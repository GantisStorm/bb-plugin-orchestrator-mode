// Frontend for the orchestrator-mode plugin.
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
  type ExperimentalProviderModelPickerValue,
  type PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { WORKER_RETENTION, type ContractDto, type OrchestratorStateDto, type SettingsViewDto, type rpcContract } from "./server";
import {
  CONTRACT_PRESETS,
  ENFORCEMENT_DESCRIPTIONS,
  ENFORCEMENT_LEVELS,
  INSTRUCTION_LIMIT,
  type WorkerConfig,
  type WorkerExecution,
  type WorkerPresetName,
} from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import "./app.css";

/** The presets the settings section edits, in the order it shows them. */
const PRESET_ROWS: { name: WorkerPresetName; label: string; hint: string }[] = [
  { name: "build", label: "Build", hint: "for units that change files" },
  { name: "review", label: "Review", hint: "for units that only inspect work" },
  { name: "research", label: "Research", hint: "for units that answer a question" },
];

/** The mutable handle every surface in one composer shares. */
interface Controller {
  enabled: boolean;
  busy: boolean;
  toggle(): Promise<void>;
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
 * tinted, so there is exactly one drawing of it to keep in step.
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

  const [state, setState] = useState<OrchestratorStateDto | null>(null);
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
              ? `Orchestrator mode on (${updated.effectiveEnforcement})`
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
      busy,
      toggle: () => applyEnabled(!enabled),
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
 * tier against the live catalog as one coherent value, the same value
 * `threads.spawn` takes. That is why the choice is stored through this plugin's
 * RPC and
 * rendered with that picker. Each choice is a pressed pair, so `Inherit` is a
 * visible option rather than only the absence of one.
 */
function WorkerExecutionSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [scope, setScope] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [stored, setStored] = useState<WorkerConfig | null>(null);
  const [contract, setContract] = useState<ContractDto | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const listed = await sdk.projects.list({ includePersonal: true });
      setProjects(listed.map((project) => ({ id: project.id, name: project.name ?? project.id })));
    } catch {
      // Without the list the selector stays on Global; the plugin settings above still apply.
    }
    try {
      if (scope === null) {
        setStored(await rpc.call("get_worker_execution"));
        setContract(await rpc.call("get_contract", { threadId: null }));
      } else {
        setStored(await rpc.call("get_project_worker", { projectId: scope }));
        setContract(await rpc.call("get_project_rules", { projectId: scope }));
      }
    } catch {
      // Keep whatever is on screen; every write reports its own failure.
    } finally {
      setLoading(false);
    }
  }, [rpc, sdk, scope]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("orchestrator-state", () => {
    void load();
  });

  /** Write the configuration. A promise is awaited first, so a caller that has
   * to read the catalog before it knows the value passes one. */
  const save = useCallback(
    async (next: WorkerConfig | null | Promise<WorkerConfig>) => {
      setBusy(true);
      try {
        const value = await next;
        if (scope === null) {
          setStored(await rpc.call("set_worker_execution", value));
        } else {
          // For a project, nothing stored means it inherits the global execution,
          // which is what the Inherit button asks for.
          const config = value === null || Object.keys(value).length === 0 ? null : value;
          setStored(await rpc.call("set_project_worker", { projectId: scope, config }));
        }
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc, scope],
  );

  /**
   * This machine's catalog default, so every field the picker shows is one the
   * provider it names can actually serve.
   */
  const seed = useCallback(async (): Promise<WorkerExecution> => {
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
      permissionMode: system.permissionCeiling,
    };
  }, [sdk]);

  /** The stored execution, only when it names the provider and model the
   * pickers need; null while the workers inherit the project's own. */
  const execution = completeExecution(stored);
  const saveRules = useCallback(async () => {
    if (draft === null) return;
    setBusy(true);
    try {
      setContract(
        scope === null
          ? await rpc.call("set_contract", { extra: draft })
          : await rpc.call("set_project_rules", { projectId: scope, extra: draft }),
      );
      setDraft(null);
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setBusy(false);
    }
  }, [draft, rpc, scope]);

  // A fallback that lost the ids an uninstalled provider can take with it is kept as
  // none, the way the server drops half a retry target instead of retrying on it.
  const fallback = completeExecution(stored?.fallback ?? null);

  return (
    <div className="rounded-md border border-border bg-surface-recessed/70 p-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
        <label className="text-sm font-medium" htmlFor="orchestrator-scope">
          Scope
        </label>
        <select
          id="orchestrator-scope"
          value={scope ?? ""}
          disabled={loading || busy}
          className="h-8 rounded-md border border-border/60 bg-card px-2 text-xs"
          onChange={(event) => {
            setLoading(true);
            setScope(event.target.value === "" ? null : event.target.value);
          }}
        >
          <option value="">Global</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <span className="text-xs text-subtle-foreground/75">
          {scope === null
            ? "the defaults every project inherits"
            : "this project's own worker execution, presets, rules and limits"}
        </span>
      </div>

      {scope === null ? null : <ProjectOverrides rpc={rpc} projectId={scope} disabled={busy} />}

      <div className="mt-3 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">Which provider and model workers use</div>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {execution === null
              ? "Workers use this project's remembered provider and model."
              : "Every worker starts on the provider and model below."}
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
              if (execution !== null) {
                void save(execution.fallback === undefined ? {} : { fallback: execution.fallback });
              }
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
              void save(seed().then((chosen) => ({ ...stored, ...chosen })))
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
          <div className="text-sm font-medium">If a worker fails</div>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {fallback === null
              ? "A failure comes back to the orchestrator to re-delegate."
              : "The same brief runs once more on the provider, model and access below."}
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
              void save(seed().then((chosen) => ({ ...stored, fallback: chosen })))
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
            onChange={(next) =>
              void save({
                ...stored,
                fallback: {
                  ...next,
                  ...(fallback.permissionMode === undefined
                    ? {}
                    : { permissionMode: fallback.permissionMode }),
                },
              })
            }
          />
          <PermissionModePicker
            providerId={fallback.providerId}
            value={fallback.permissionMode ?? execution?.permissionMode ?? "full"}
            disabled={busy}
            className="h-8 shrink-0"
            onChange={(permissionMode) => void save({ ...stored, fallback: { ...fallback, permissionMode } })}
          />
        </div>
      )}
      <div className="mt-3 border-t border-border/60 pt-3">
        <div className="text-sm font-medium">Presets</div>
        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
          Save a model and an access level for each kind of work. When the orchestrator hands
          a unit to a worker it can name the kind, and that unit runs on what you saved here
          instead of the default above. A kind left off uses the default.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {PRESET_ROWS.map(({ name, label, hint }) => {
            const preset = stored?.presets?.[name] ?? null;
            // Partial presets are a stored shape the CLI can write and an uninstalled
            // provider can cause, so the pickers only render when both ids they need are
            // there; otherwise the row explains itself and keeps Set/Default usable.
            const complete = completeExecution(preset);
            return (
              <div key={name} className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-xs font-medium">{label}</span>
                <Button
                  variant={preset === null ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={preset === null}
                  disabled={loading || busy}
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    if (preset === null) return;
                    const presets = { ...(stored?.presets ?? {}) };
                    delete presets[name];
                    void save({ ...stored, presets });
                  }}
                >
                  Default
                </Button>
                <Button
                  variant={preset === null ? "ghost" : "secondary"}
                  size="sm"
                  aria-pressed={preset !== null}
                  disabled={loading || busy}
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    void save(
                      seed().then((chosen) => ({
                        ...stored,
                        presets: { ...(stored?.presets ?? {}), [name]: chosen },
                      })),
                    )
                  }
                >
                  Set
                </Button>
                {complete === null ? (
                  <span className="text-xs text-subtle-foreground/75">
                    {preset === null ? hint : "Saved without a provider and model; press Set to choose them, or Default to clear it."}
                  </span>
                ) : (
                  <>
                    <ProviderModelPicker
                      value={selectionOf(complete)}
                      disabled={busy}
                      className="h-8 max-w-full"
                      onChange={(next) =>
                        void save({ ...stored, presets: { ...(stored?.presets ?? {}), [name]: next } })
                      }
                    />
                    <PermissionModePicker
                      providerId={complete.providerId}
                      value={complete.permissionMode ?? execution?.permissionMode ?? "full"}
                      disabled={busy}
                      className="h-8 shrink-0"
                      onChange={(permissionMode) =>
                        void save({
                          ...stored,
                          presets: { ...(stored?.presets ?? {}), [name]: { ...complete, permissionMode } },
                        })
                      }
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 border-t border-border/60 pt-3">
        <div className="text-sm font-medium">Extra rules for this project</div>
        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
          Added to the contract as its own section, so a rule adds to what the orchestrator is
          told instead of replacing the rules the watchdog enforces.
        </p>
        <textarea
          value={draft ?? contract?.extra ?? ""}
          maxLength={contract?.limit ?? 370}
          rows={3}
          spellCheck={false}
          disabled={loading || busy}
          onChange={(event) => setDraft(event.target.value)}
          className="mt-2 w-full resize-y rounded-md border border-border/60 bg-card px-2 py-1.5 text-xs leading-snug text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          placeholder="e.g. Never touch files under generated/."
        />
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="text-xs text-subtle-foreground/75">
            {(draft ?? contract?.extra ?? "").length} of {contract?.limit ?? 370} characters used
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={draft === null || busy}
            onClick={() => void saveRules()}
          >
            Save rules
          </Button>
        </div>
      </div>

      <details className="mt-3 border-t border-border/60 pt-3">
        <summary className="cursor-pointer text-sm font-medium">
          The contract: the exact instructions this plugin adds
          <span className="ml-2 font-normal text-subtle-foreground/75">
            {contract === null ? "" : `${contract.text.length} of ${INSTRUCTION_LIMIT} characters`}
          </span>
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-card p-2 font-mono text-xs leading-snug text-foreground/90">
          {contract?.text ?? ""}
        </pre>
      </details>

    </div>
  );
}

/**
 * The settings a project can override, and the ones it inherits. Each row writes one
 * field through `set_project_setting`; a value of null clears the override, which is
 * what Inherit does. Absent from this list on purpose: `defaultForNewThreads` is a
 * composer default rather than thread behaviour, so it stays global.
 */
function ProjectOverrides({
  rpc,
  projectId,
  disabled,
}: {
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  projectId: string;
  disabled: boolean;
}) {
  const [view, setView] = useState<{ values: SettingsViewDto; overridden: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await rpc.call("get_project_settings", { projectId }));
    } catch {
      // The rows render empty rather than lying about what is stored.
    }
  }, [rpc, projectId]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("orchestrator-state", () => {
    void load();
  });

  const write = useCallback(
    async (key: string, value: string | number | boolean | null) => {
      setBusy(true);
      try {
        setView(await rpc.call("set_project_setting", { projectId, key: key as never, value }));
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc, projectId],
  );

  const overridden = new Set(view?.overridden ?? []);
  const values = view?.values;
  const off = disabled || busy || view === null;

  /** One row: the effective value, a control that writes the override, and Inherit. */
  const row = (
    key: keyof SettingsViewDto,
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 shrink-0 text-xs font-medium">{label}</span>
      <select
        aria-label={label}
        value={overridden.has(key) ? String(values?.[key]) : ""}
        disabled={off}
        className="h-7 rounded-md border border-border/60 bg-card px-1.5 text-xs"
        onChange={(event) =>
          void write(key, event.target.value === "" ? null : event.target.value)
        }
      >
        <option value="">
          {values === undefined ? "Inherit" : `Inherit (${String(values[key])})`}
        </option>
        {options
          .filter((option) => option.value !== String(values?.[key]))
          .map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
      </select>
      {overridden.has(key) ? (
        <span className="text-xs text-subtle-foreground/75">overrides the global value</span>
      ) : (
        <span className="text-xs text-subtle-foreground/75">inherits</span>
      )}
    </div>
  );

  /** A numeric row: the input always shows the effective value, and Inherit clears the override. */
  const numberRow = (
    key: "maxNudges" | "maxParallelWorkers" | "maxDelegationsPerTurn",
    label: string,
    hint: string,
  ) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 shrink-0 text-xs font-medium">{label}</span>
      <input
        type="number"
        min={0}
        aria-label={label}
        value={values?.[key] ?? 0}
        disabled={off}
        className="h-7 w-20 rounded-md border border-border/60 bg-card px-1.5 text-xs"
        onChange={(event) => void write(key, Number(event.target.value))}
      />
      {overridden.has(key) ? (
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" disabled={off} onClick={() => void write(key, null)}>
          Inherit
        </Button>
      ) : (
        <span className="text-xs text-subtle-foreground/75">inherits</span>
      )}
      <span className="text-xs text-subtle-foreground/75">{hint}</span>
    </div>
  );

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-card/40 p-2">
      <div className="text-sm font-medium">Enforcement and limits for this project</div>
      <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
        Override any field for this project alone; Inherit hands it back to the global value.
        Threads keep their own enforcement switch either way.
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        {row(
          "enforcement",
          "Enforcement",
          ENFORCEMENT_LEVELS.map((level) => ({ value: level, label: level })),
        )}
        {row("allowReadCommands", "Read-only commands", [
          { value: "true", label: "allowed" },
          { value: "false", label: "every command is work" },
        ])}
        {row("contractPreset", "Contract shape", CONTRACT_PRESETS.map((preset) => ({ value: preset, label: preset })))}
        {row("workerRetention", "Workers afterwards", WORKER_RETENTION.map((policy) => ({ value: policy, label: policy })))}
        {numberRow("maxNudges", "Reminders per thread", "0 turns reminders off")}
        {numberRow("maxParallelWorkers", "Most workers at once", "0 removes the cap")}
        {numberRow("maxDelegationsPerTurn", "Most workers per turn", "0 removes the cap")}
      </div>
    </div>
  );
}

/** The execution shape that can be rendered: both ids the pickers need are present. */
type CompleteExecution = WorkerConfig & { providerId: string; model: string };

/**
 * The stored execution as the pickers can render it, or null when the provider or model
 * is missing. A partial value is a real stored shape (the CLI can write one, and
 * uninstalling a provider creates one), so it is never handed to a picker that needs both.
 */
function completeExecution(stored: WorkerConfig | null | undefined): CompleteExecution | null {
  return stored === null || stored === undefined || stored.providerId === undefined || stored.model === undefined
    ? null
    : { ...stored, providerId: stored.providerId, model: stored.model };
}

/** The picker's own value shape, filled from what is stored. */
function selectionOf(stored: CompleteExecution): ExperimentalProviderModelPickerValue {
  return {
    providerId: stored.providerId,
    model: stored.model,
    reasoningLevel: stored.reasoningLevel ?? "medium",
    ...(stored.serviceTier === undefined ? {} : { serviceTier: stored.serviceTier }),
  };
}

/** The config without a retry target, keeping the worker execution. */
function dropFallback(config: WorkerConfig | null): WorkerConfig {
  const { fallback: _fallback, ...execution } = config ?? {};
  return execution;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "worker-execution",
    title: "Workers",
    description:
      "What delegated workers run on, how a failure is retried, and one-word presets a delegation can name. Enforcement, the contract and the limits are in the plugin settings above.",
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
