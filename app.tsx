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
  experimental_PermissionModePicker as PermissionModePicker,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
  useSdk,
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

/** Mirrors the SDK's own unions; the pickers take the SDK's types, not these. */
type ReasoningLevelDto =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "ultracode";
type ServiceTierDto = "default" | "fast";
type PermissionModeDto = "auto" | "accept-edits" | "full";

/**
 * What every delegation will ask for. An absent field is inherited from the
 * project, not "unset": `{}` means workers follow the project's own execution.
 */
interface WorkerExecutionDto {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevelDto;
  serviceTier?: ServiceTierDto;
  permissionMode?: PermissionModeDto;
}

interface WorkerConfigDto extends WorkerExecutionDto {
  fallback?: WorkerExecutionDto;
}

/** The SDK's value shape for the provider/model picker. */
interface ExecutionSelection {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevelDto;
  serviceTier?: ServiceTierDto;
  permissionMode?: PermissionModeDto;
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

/**
 * The glyph every surface draws. The artwork itself is declared once, in the
 * manifest under `bb.branding.experimental_icons`, and BB serves it hashed and
 * tinted — so there is exactly one drawing of it to keep in step.
 */
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

/**
 * The Settings → Installed plugins → Orchestrator Mode surface.
 *
 * Worker execution is not a plugin setting: the model list has to follow the
 * chosen provider, and a `select` cannot depend on another `select`. BB's own
 * provider/model picker resolves provider, model, reasoning level and service
 * tier against the live catalog as one coherent value — the same value
 * `threads.spawn` takes — so the choice is stored through this plugin's RPC and
 * rendered with that picker. Each choice is a pressed pair, so `Inherit` is a
 * visible option rather than only the absence of one.
 */
function WorkerExecutionSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [stored, setStored] = useState<WorkerConfigDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStored(await rpc.call("get_worker_execution"));
    } catch {
      // Keep whatever is on screen; every write reports its own failure.
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("orchestrator-state", () => {
    void load();
  });

  /** Write the configuration. A promise is awaited first, so a caller that has
   * to read the catalog before it knows the value passes one. */
  const save = useCallback(
    async (next: WorkerConfigDto | null | Promise<WorkerConfigDto>) => {
      setBusy(true);
      try {
        setStored(await rpc.call("set_worker_execution", await next));
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );

  /**
   * This machine's catalog default, so every field the picker shows is one the
   * provider it names can actually serve. Only the worker execution carries a
   * permission mode; a fallback inherits the one its workers already use.
   */
  const seed = useCallback(
    async (withPermission: boolean): Promise<WorkerExecutionDto> => {
      const system = await sdk.providers.models();
      const provider = system.providers.find((entry) => entry.available);
      if (provider === undefined) throw new Error("No provider is available on this machine.");
      const listed = await sdk.providers.models({ providerId: provider.id });
      const model = listed.models.find((entry) => entry.isDefault) ?? listed.models[0];
      if (model === undefined) throw new Error(`${provider.id} offers no models.`);
      return {
        providerId: provider.id,
        model: model.id,
        reasoningLevel: model.defaultReasoningEffort,
        ...(withPermission ? { permissionMode: system.permissionCeiling } : {}),
      };
    },
    [sdk],
  );

  /** The stored execution, only when it names the provider and model the
   * pickers need; null while the workers inherit the project's own. */
  const execution =
    stored === null || stored.providerId === undefined || stored.model === undefined
      ? null
      : stored;
  const fallback = stored?.fallback ?? null;

  return (
    <div className="rounded-md border border-border bg-surface-recessed/70 p-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">Workers run on</div>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {execution === null
              ? "Inherit this project's remembered provider and model."
              : "Use the provider and model below. A single delegation can still override them."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Worker provider and model">
          <Button
            variant={execution === null ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={execution === null}
            disabled={loading || busy}
            className="h-7 px-2 text-xs"
            onClick={() => {
              if (execution !== null) void save(dropPrimary(execution));
            }}
          >
            Inherit
          </Button>
          <Button
            variant={execution === null ? "ghost" : "secondary"}
            size="sm"
            aria-pressed={execution !== null}
            disabled={loading || busy}
            className="h-7 px-2 text-xs"
            onClick={() =>
              void save(seed(true).then((chosen) => ({ ...stored, ...chosen })))
            }
          >
            Custom
          </Button>
        </div>
      </div>

      {execution === null ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ProviderModelPicker
            value={selectionOf(execution)}
            disabled={busy}
            className="h-8 max-w-full"
            onChange={(next) => void save({ ...execution, ...next })}
          />
          <PermissionModePicker
            providerId={execution.providerId!}
            value={execution.permissionMode ?? "full"}
            disabled={busy}
            className="h-8 shrink-0"
            onChange={(permissionMode) => void save({ ...execution, permissionMode })}
          />
        </div>
      )}

      <div className="mt-3 flex items-start justify-between gap-6 border-t border-border/60 pt-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Retry a failed worker</div>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {fallback === null
              ? "A failed worker is reported back to the orchestrator."
              : "The same brief is re-delegated on this provider and model."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Worker fallback">
          <Button
            variant={fallback === null ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={fallback === null}
            disabled={loading || busy}
            className="h-7 px-2 text-xs"
            onClick={() => {
              if (fallback !== null) void save(dropFallback(stored));
            }}
          >
            Report
          </Button>
          <Button
            variant={fallback === null ? "ghost" : "secondary"}
            size="sm"
            aria-pressed={fallback !== null}
            disabled={loading || busy}
            className="h-7 px-2 text-xs"
            onClick={() =>
              void save(seed(false).then((chosen) => ({ ...stored, fallback: chosen })))
            }
          >
            Retry
          </Button>
        </div>
      </div>

      {fallback === null ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ProviderModelPicker
            value={selectionOf(fallback)}
            disabled={busy}
            className="h-8 max-w-full"
            onChange={(next) => void save({ ...stored, fallback: next })}
          />
        </div>
      )}
    </div>
  );
}

/** The picker's own value shape, filled from what is stored. */
function selectionOf(stored: WorkerExecutionDto): ExecutionSelection {
  return {
    providerId: stored.providerId!,
    model: stored.model!,
    reasoningLevel: stored.reasoningLevel ?? "medium",
    ...(stored.serviceTier === undefined ? {} : { serviceTier: stored.serviceTier }),
  };
}

/** The config without its worker execution, keeping any fallback. */
function dropPrimary(config: WorkerConfigDto | null): WorkerConfigDto {
  return config?.fallback === undefined ? {} : { fallback: config.fallback };
}

/** The config without a retry target, keeping the worker execution. */
function dropFallback(config: WorkerConfigDto | null): WorkerConfigDto {
  const { fallback: _fallback, ...execution } = config ?? {};
  return execution;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "worker-execution",
    title: "Worker execution",
    description: "What every delegated worker thread runs on.",
    component: WorkerExecutionSettings,
  });

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
