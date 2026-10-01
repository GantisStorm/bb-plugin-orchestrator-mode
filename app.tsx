// bb-plugin-orchestrator-mode — frontend.
//
// One composer customization with three surfaces over one shared controller:
//
//   banner  (always mounted)  owns the data: it holds the plugin's RPC client,
//                             keeps the thread's state fresh, paints the draft
//                             effect, and renders the visible strip when the
//                             mode is on. It returns null when the mode is off
//                             but stays mounted, which is what makes the other
//                             two surfaces work in every composer layout.
//   action  (toggle button)   renders before the native voice/submit buttons.
//                             Unavailable in compact layout, hence the menu row.
//   plusMenu (toggle row)     host-rendered, so it works in compact layout too.
//
// Scopes are `thread` and `new-thread`. In a thread the toggle writes that
// thread's state; in the root compose screen it writes the plugin's "new
// threads start as orchestrators" default, which the backend applies to the
// thread's first dispatch.
import { useCallback, useEffect, useReducer, useState } from "react";
import {
  definePluginApp,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
  type ComposerView,
  type PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { ENFORCEMENT_DESCRIPTIONS, type EnforcementLevel } from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import "./app.css";

interface ViolationDto {
  id: string;
  turnId: string | null;
  workKind: string;
  detail: string;
  detectedAt: number;
}

interface DelegationDto {
  threadId: string;
  title: string;
  task: string;
  createdAt: number;
  status: string | null;
}

interface OrchestratorState {
  enabled: boolean;
  enforcement: EnforcementLevel | null;
  effectiveEnforcement: EnforcementLevel;
  enabledAt: string | null;
  violations: ViolationDto[];
  delegations: DelegationDto[];
  nudgeCount: number;
  defaultForNewThreads: boolean;
  allowReadCommands: boolean;
  maxNudges: number;
}

/** The mutable handle every surface in one composer shares. */
interface Controller {
  enabled: boolean;
  state: OrchestratorState | null;
  busy: boolean;
  toggle(): Promise<void>;
  turnOff(): Promise<void>;
}

const registry = new Map<string, Controller>();
const listeners = new Set<() => void>();

function bump(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `thread:<id>` or `new-thread`; null for scopes this plugin does not own. */
function scopeKey(scope: PluginComposerScope): string | null {
  if (scope.kind === "thread") return `thread:${scope.threadId}`;
  if (scope.kind === "new-thread") return "new-thread";
  return null;
}

function controllerFor(view: ComposerView): Controller | null {
  const key = scopeKey(view.scope);
  return key === null ? null : (registry.get(key) ?? null);
}

/** Re-render whenever any controller's contents change. */
function useController(key: string | null): Controller | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => subscribe(rerender), []);
  return key === null ? null : (registry.get(key) ?? null);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The hub-and-spoke mark, registered so every surface draws the same glyph. */
function HubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="5" cy="18" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M12 7.2v4.3M10.4 12.8 6.3 16.4M13.6 12.8l4.1 3.6" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

const ICON_NAME = "orchestrator-mode/hub";

/**
 * Owns the data for one composer. Mounted as a `bare` banner in every thread
 * and new-thread composer, so it exists even when the mode is off and even in
 * compact layout, where the action button does not render.
 */
function OrchestratorHost() {
  const view = useComposerView();
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const key = scopeKey(view.scope);
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;

  const [state, setState] = useState<OrchestratorState | null>(null);
  const [defaultEnabled, setDefaultEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (key === null) return;
    try {
      if (threadId !== null) {
        setState(await rpc.call("get_state", { threadId }));
      } else {
        const next = await rpc.call("get_default");
        setDefaultEnabled(next.enabled);
      }
    } catch {
      // A read failure leaves the last known state on screen; the toggle
      // reports its own errors.
    }
  }, [key, threadId, rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("orchestrator-state", () => {
    void load();
  });

  const enabled = threadId !== null ? (state?.enabled ?? false) : defaultEnabled;

  const applyEnabled = useCallback(
    async (next: boolean) => {
      if (key === null) return;
      setBusy(true);
      try {
        if (threadId !== null) {
          const updated = await rpc.call("set_enabled", { threadId, enabled: next });
          setState(updated);
          toast.success(
            next
              ? `Orchestrator mode on — ${updated.effectiveEnforcement}`
              : "Orchestrator mode off",
          );
        } else {
          const updated = await rpc.call("set_default", { enabled: next });
          setDefaultEnabled(updated.enabled);
          toast.success(
            next
              ? "New threads will start in orchestrator mode"
              : "New threads will start normally",
          );
        }
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [key, threadId, rpc],
  );

  // Register (and keep current) the controller the other two surfaces read.
  useEffect(() => {
    if (key === null) return;
    const controller: Controller = {
      enabled,
      state,
      busy,
      toggle: () => applyEnabled(!enabled),
      turnOff: () => applyEnabled(false),
    };
    registry.set(key, controller);
    bump();
    return () => {
      if (registry.get(key) === controller) registry.delete(key);
      bump();
    };
  }, [key, enabled, state, busy, applyEnabled]);

  // Paint the draft while the mode is on. The host clears it when this
  // customization unmounts or the composer scope changes.
  useEffect(() => {
    if (key === null) return;
    composer.setTextEffect(enabled ? { className: "orch-draft" } : null);
  }, [key, enabled, composer]);

  if (key === null || !enabled) return null;

  if (threadId === null) {
    return (
      <div className="orch-strip" data-testid="orch-strip-new-thread">
        <Icon name={ICON_NAME} className="mt-0.5 size-4 shrink-0" />
        <div className="orch-strip__body">
          <div className="orch-strip__title">New threads start as orchestrators</div>
          <div className="orch-strip__detail">
            The thread you are about to create will delegate every unit of work instead of
            doing it itself.
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          disabled={busy}
          onClick={() => void applyEnabled(false)}
        >
          Turn off
        </Button>
      </div>
    );
  }

  const enforcement = state?.effectiveEnforcement ?? "guard";
  const violations = state?.violations ?? [];
  const recent = violations.slice(-3);
  return (
    <div
      className="orch-strip"
      data-violations={violations.length > 0 ? "true" : "false"}
      data-testid="orch-strip-thread"
    >
      <Icon name={ICON_NAME} className="mt-0.5 size-4 shrink-0" />
      <div className="orch-strip__body">
        <div className="orch-strip__title">
          Orchestrator mode is on
          <span className="font-normal opacity-70">· {enforcement}</span>
        </div>
        <div className="orch-strip__detail">
          {ENFORCEMENT_DESCRIPTIONS[enforcement]} This thread may only read, plan, ask,
          delegate and report.
        </div>
        {recent.length === 0 ? null : (
          <div className="orch-strip__acts">
            <span className="font-medium">
              Direct work caught ({violations.length} total):
            </span>
            {recent.map((violation) => (
              <span key={violation.id} className="block truncate opacity-80">
                · {violation.detail}
              </span>
            ))}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={busy}
        onClick={() => void applyEnabled(false)}
      >
        Turn off
      </Button>
    </div>
  );
}

/** The toggle button that renders before the native voice/submit actions. */
function OrchestratorToggle() {
  const view = useComposerView();
  const key = scopeKey(view.scope);
  const controller = useController(key);
  if (key === null || controller === null) return null;
  const enabled = controller.enabled;
  const label =
    view.scope.kind === "thread"
      ? enabled
        ? "Turn orchestrator mode off for this thread"
        : "Turn orchestrator mode on for this thread"
      : enabled
        ? "Stop starting new threads in orchestrator mode"
        : "Start new threads in orchestrator mode";
  return (
    <Button
      variant="ghost"
      size="icon"
      className="orch-toggle size-8"
      aria-pressed={enabled}
      aria-label={label}
      disabled={controller.busy}
      onClick={() => void controller.toggle()}
    >
      <Icon name={ICON_NAME} className="size-4" />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: ICON_NAME, component: HubIcon });

  app.composer.customize({
    id: "orchestrator-mode",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "toggle", component: OrchestratorToggle }],
    banners: [{ id: "state", chrome: "bare", component: OrchestratorHost }],
    plusMenu: [
      {
        id: "toggle",
        label: "Orchestrator mode",
        description: "Force this thread to delegate every unit of work",
        disabled: (view) => controllerFor(view) === null,
        run: async ({ view }) => {
          const controller = controllerFor(view);
          if (controller === null) {
            toast.error("Orchestrator mode is not available in this composer.");
            return;
          }
          await controller.toggle();
        },
      },
    ],
  });
});
