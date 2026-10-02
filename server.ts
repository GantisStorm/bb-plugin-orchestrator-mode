// bb-plugin-orchestrator-mode — backend.
//
// One per-thread switch, three enforcement layers:
//
//   1. `bb.agents.configure` injects the orchestrator contract and selects the
//      `orchestrator_delegate` tool for threads that are orchestrating. This is
//      the layer that actually changes what the agent does.
//   2. The `message.dispatch` hook keeps the thread-metadata mirror in step
//      with this plugin's own authoritative state before every turn starts, and
//      applies the "new threads start as orchestrators" default. The mirror is
//      what layer 1 can read synchronously; the KV store is what the agent
//      cannot forge.
//   3. A watchdog reads the timeline of orchestrator threads, classifies each
//      new work row, and — in `guard`/`block` — records violations, stops the
//      turn and sends a corrective nudge.
//
// BB gives plugins no pre-tool-call veto, so layer 3 is detect-and-intervene
// rather than prevent-at-source. That limitation is documented in README.md.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type PluginSettingDescriptor,
  type PluginSettingsValues,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_ENFORCEMENT,
  DELEGATE_TOOL,
  ENFORCEMENT_DESCRIPTIONS,
  ENFORCEMENT_LEVELS,
  PERMISSION_MODES,
  REASONING_LEVELS,
  SERVICE_TIERS,
  buildInstructions,
  buildNudge,
  classifyRow,
  defaultAppliesTo,
  isEnforcementLevel,
  isPermissionMode,
  isReasoningLevel,
  isServiceTier,
  readMirror,
  writeMirror,
  type EnforcementLevel,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
  type Violation,
  type WorkerCatalog,
  type WorkerExecution,
  type WorkerModelOption,
} from "./shared";

export type { EnforcementLevel, Violation };
export { DELEGATE_TOOL };

/** Realtime channel the composer surfaces listen on. */
const STATE_CHANGED = "orchestrator-state";

const STATE_KEY = "state";
/** When the "new threads" default was last switched on; null while it is off. */
const DEFAULT_KEY = "default";
/** The stored worker execution every delegation defaults to. */
const WORKER_KEY = "worker";
/** Threads kept in the KV map before the least recently touched is dropped. */
const MAX_THREADS = 300;
const MAX_VIOLATIONS = 100;
const MAX_SEEN_ROWS = 500;
const MAX_DELEGATIONS = 50;

export interface Delegation {
  threadId: string;
  title: string;
  task: string;
  createdAt: number;
  status: string | null;
}

export interface ThreadState {
  enabled: boolean;
  /** Per-thread override; null follows the plugin setting. */
  enforcement: EnforcementLevel | null;
  enabledAt: string | null;
  touchedAt: number;
  violations: Violation[];
  seenRowIds: string[];
  /** Timeline sequence already classified, so a scan never re-judges a row. */
  lastSeq: number;
  /**
   * Turns that ran in a provider session which never received the contract or
   * the tool: the one in flight when the mode was switched on (if any) and the
   * first one after it, because BB resumes a live session rather than
   * hot-mutating it. Recorded but never judged.
   */
  graceTurnIds: string[];
  /** How many grace turns this enablement gets: two mid-turn, one when idle. */
  graceSlots: number;
  nudgeCount: number;
  lastNudgeTurnId: string | null;
  lastStopTurnId: string | null;
  delegations: Delegation[];
}

const delegationSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  task: z.string(),
  createdAt: z.number(),
  status: z.string().nullable(),
});

const violationSchema = z.object({
  id: z.string(),
  turnId: z.string().nullable(),
  workKind: z.string(),
  detail: z.string(),
  detectedAt: z.number(),
});

/** The execution a delegation defaults to; an absent field inherits. */
const workerExecutionSchema = z.object({
  providerId: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(200).optional(),
  reasoningLevel: z.enum(REASONING_LEVELS).optional(),
  serviceTier: z.enum(SERVICE_TIERS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});

const stateSchema = z.object({
  enabled: z.boolean(),
  enforcement: z.enum(ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]]).nullable(),
  effectiveEnforcement: z.enum(ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]]),
  enabledAt: z.string().nullable(),
  violations: z.array(violationSchema),
  delegations: z.array(delegationSchema),
  nudgeCount: z.number(),
  /** The plugin-wide default, so the new-thread composer can render it. */
  defaultForNewThreads: z.boolean(),
  allowReadCommands: z.boolean(),
  maxNudges: z.number(),
  /** The execution every delegation defaults to; absent fields inherit. */
  workerExecution: workerExecutionSchema,
});

/** The shape every RPC call returns; the schema above owns it. */
export type OrchestratorStateDto = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  get_state: {
    input: z.object({ threadId: z.string().min(1).max(120) }).strict(),
    output: stateSchema,
  },
  set_enabled: {
    input: z
      .object({
        threadId: z.string().min(1).max(120),
        enabled: z.boolean(),
        enforcement: z.enum(ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]]).nullable().optional(),
      })
      .strict(),
    output: stateSchema,
  },
  get_default: { input: z.null(), output: z.object({ enabled: z.boolean() }) },
  set_default: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  get_worker_execution: { input: z.null(), output: workerExecutionSchema },
  set_worker_execution: {
    input: workerExecutionSchema.nullable(),
    output: workerExecutionSchema,
  },
  clear_violations: {
    input: z.object({ threadId: z.string().min(1).max(120) }).strict(),
    output: stateSchema,
  },
});

/** A timeline row, narrowed to the fields the classifier reads. */
interface ScanRow {
  id: string;
  kind: string;
  workKind?: string;
  status?: string;
  toolName?: string | null;
  command?: string | null;
  change?: { path?: string | null } | null;
  turnId?: string | null;
  sourceSeqEnd?: number;
  startedAt?: number;
  children?: unknown;
}

function asScanRows(rows: unknown): ScanRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ScanRow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const candidate = row as ScanRow;
    if (typeof candidate.id !== "string") continue;
    out.push(candidate);
    if (Array.isArray(candidate.children)) out.push(...asScanRows(candidate.children));
  }
  return out;
}

// --- settings --------------------------------------------------------------

/**
 * Every model the SDK's own picker would offer, with the provider that serves
 * it. Read from `bb.sdk.providers.models()` — the same source the new-thread
 * composer's provider and model pickers use, so a worker runs on something the
 * user can actually select there.
 *
 * A failed read is not fatal: the catalog comes back empty, the pickers offer
 * only "inherit", and nothing is validated against it.
 */
async function loadWorkerCatalog(bb: BbPluginApi): Promise<WorkerCatalog> {
  try {
    // The unfiltered response enumerates providers, including which are
    // available; each provider's models need a call of its own. Providers are a
    // handful, so this is a few requests once per plugin load.
    const system = await bb.sdk.providers.models();
    const providers: string[] = [];
    const models: WorkerModelOption[] = [];
    for (const provider of system.providers) {
      if (!provider.available) continue;
      providers.push(provider.id);
      const listed = (await bb.sdk.providers.models({ providerId: provider.id })).models;
      for (const model of listed) {
        if (models.some((existing) => existing.id === model.id)) continue;
        models.push({ id: model.id, providerId: provider.id });
      }
    }
    return { providers, models };
  } catch (cause) {
    bb.log.warn(`worker provider catalog unavailable, offering inherit only: ${String(cause)}`);
    return { providers: [], models: [] };
  }
}

/** `explicit` means the caller named the value, so the server must keep it. */
type ExecutionSource = "explicit";

/** The provenance map `threads.spawn` reads for each execution field it gets. */
interface WorkerExecutionSources {
  providerId?: ExecutionSource;
  model?: ExecutionSource;
  reasoningLevel?: ExecutionSource;
  serviceTier?: ExecutionSource;
  permissionMode?: ExecutionSource;
}

/**
 * Stamp every field present in `exec` as caller-chosen. Without this the server
 * drops a requested `providerId`/`model` and re-derives it from the project's
 * remembered defaults, so the worker would silently ignore what was asked for.
 */
function executionSources(exec: WorkerExecution): WorkerExecutionSources {
  return {
    ...(exec.providerId === undefined ? {} : { providerId: "explicit" as const }),
    ...(exec.model === undefined ? {} : { model: "explicit" as const }),
    ...(exec.reasoningLevel === undefined ? {} : { reasoningLevel: "explicit" as const }),
    ...(exec.serviceTier === undefined ? {} : { serviceTier: "explicit" as const }),
    ...(exec.permissionMode === undefined ? {} : { permissionMode: "explicit" as const }),
  };
}

export default async function plugin(bb: BbPluginApi) {
  const catalog = await loadWorkerCatalog(bb);

  const SETTING_DESCRIPTORS = {
    defaultForNewThreads: {
      type: "boolean",
      label: "New threads start in orchestrator mode",
      description:
        "Applies the default to root threads created while it is on. Existing threads are left alone.",
      default: false,
    },
    enforcement: {
      type: "select",
      label: "Enforcement",
      description: ENFORCEMENT_DESCRIPTIONS.guard,
      options: [...ENFORCEMENT_LEVELS],
      default: DEFAULT_ENFORCEMENT,
    },
    allowReadCommands: {
      type: "boolean",
      label: "Read-only shell commands are not work",
      description:
        "Lets an orchestrator run ls/cat/rg/git status/git diff to orient itself. Turning this off treats every command as doing the work.",
      default: true,
    },
    maxNudges: {
      type: "number",
      label: "Maximum corrective nudges per thread",
      description: "Violations keep being recorded after the cap is reached.",
      default: 3,
    },
  } satisfies Record<string, PluginSettingDescriptor>;

  /**
   * The resolved settings this plugin defines. Named here rather than published
   * through `ReturnType` of the handle, so `applySettings` takes a real type.
   */
  type OrchestratorSettings = PluginSettingsValues<typeof SETTING_DESCRIPTORS>;

  const settings = bb.settings.define(SETTING_DESCRIPTORS);

  /** In-memory mirror of the effective settings, for the sync configure path. */
  const live = {
    defaultForNewThreads: false,
    /**
     * When the default was last switched on. The dispatch hook only applies the
     * default to threads created at or after this moment, which is what keeps
     * "new threads" from meaning "every thread that happens to lack a mirror".
     */
    defaultEnabledAtMs: 0,
    enforcement: DEFAULT_ENFORCEMENT as EnforcementLevel,
    allowReadCommands: true,
    maxNudges: 3,
    /** Worker execution defaults; an absent field means "inherit". */
    worker: {} as WorkerExecution,
  };

  /**
   * The worker execution this plugin configures, in the shape `threads.spawn`
   * takes and `buildInstructions` describes. Absent fields are omitted rather
   * than sent empty, so a thread spawned without them resolves the project's
   * remembered defaults exactly as it did before this fork.
   */
  function workerDefaults(): WorkerExecution {
    return { ...live.worker };
  }

  /**
   * Resolve one stored id. A blank one means "not set"; a value the live
   * catalog no longer lists is dropped with a warning rather than spawned,
   * because both writers (the settings section and the CLI) choose from the
   * catalog: this means the provider's models changed under a saved choice, and
   * a worker on the project's own default beats one whose start fails.
   */
  function workerChoice(
    value: string | undefined,
    options: readonly string[],
    setting: string,
  ): string | undefined {
    if (value === undefined || value === "") return undefined;
    if (options.length > 0 && !options.includes(value)) {
      bb.log.warn(`${setting} "${value}" is not in the current catalog; ignoring it`);
      return undefined;
    }
    return value;
  }

  /**
   * Keep provider and model coherent. A model belongs to exactly one provider,
   * so naming a provider that does not serve the chosen model would guarantee a
   * failed start; the model wins and the mismatch is logged.
   */
  function reconcile(exec: WorkerExecution): WorkerExecution {
    if (exec.model === undefined) return exec;
    const owner = catalog.models.find((option) => option.id === exec.model)?.providerId;
    if (owner === undefined || owner === exec.providerId) return exec;
    if (exec.providerId !== undefined) {
      bb.log.warn(
        `worker provider ${exec.providerId} does not serve ${exec.model}; using ${owner}`,
      );
    }
    return { ...exec, providerId: owner };
  }

  function applySettings(values: OrchestratorSettings): void {
    live.defaultForNewThreads = values.defaultForNewThreads === true;
    live.enforcement = isEnforcementLevel(values.enforcement)
      ? values.enforcement
      : DEFAULT_ENFORCEMENT;
    live.allowReadCommands = values.allowReadCommands !== false;
    const nudges = Number(values.maxNudges);
    live.maxNudges = Number.isFinite(nudges) && nudges >= 0 ? Math.floor(nudges) : 3;
  }

  /**
   * The stored worker execution, with any id the live catalog no longer lists
   * dropped. The store is written by this plugin's own surfaces, so an unknown
   * id means a provider's models changed under a saved choice.
   */
  function storedWorkerExecution(stored: unknown): WorkerExecution {
    if (stored === null || typeof stored !== "object") return {};
    const record = stored as Record<string, unknown>;
    const providerId = workerChoice(
      typeof record.providerId === "string" ? record.providerId : undefined,
      catalog.providers,
      "worker provider",
    );
    const model = workerChoice(
      typeof record.model === "string" ? record.model : undefined,
      catalog.models.map((option) => option.id),
      "worker model",
    );
    return reconcile({
      ...(providerId === undefined ? {} : { providerId }),
      ...(model === undefined ? {} : { model }),
      ...(isReasoningLevel(record.reasoningLevel) ? { reasoningLevel: record.reasoningLevel } : {}),
      ...(isServiceTier(record.serviceTier) ? { serviceTier: record.serviceTier } : {}),
      ...(isPermissionMode(record.permissionMode)
        ? { permissionMode: record.permissionMode }
        : {}),
    });
  }

  /**
   * Refuse a worker the provider catalog cannot serve, naming the alternatives
   * so the agent can correct itself instead of handing back a broken worker.
   * Nothing is asserted while the catalog is empty — an unreadable catalog must
   * not make delegation impossible.
   */
  function assertInCatalog(exec: WorkerExecution): void {
    if (
      exec.model !== undefined &&
      catalog.models.length > 0 &&
      !catalog.models.some((option) => option.id === exec.model)
    ) {
      const sample = catalog.models
        .slice(0, 12)
        .map((option) => option.id)
        .join(", ");
      throw new Error(
        `Unknown worker model "${exec.model}". Models this machine offers include: ${sample}. Run \`bb provider models <provider>\` for the full list, or omit model to inherit the project default.`,
      );
    }
    if (
      exec.providerId !== undefined &&
      catalog.providers.length > 0 &&
      !catalog.providers.includes(exec.providerId)
    ) {
      throw new Error(
        `Unknown worker provider "${exec.providerId}". Providers this machine offers: ${catalog.providers.join(", ")}. Omit provider to inherit the project default.`,
      );
    }
  }

  async function persistDefaultEnabledAt(): Promise<void> {
    await bb.storage.kv.set(DEFAULT_KEY, {
      enabledAtMs: live.defaultForNewThreads ? live.defaultEnabledAtMs : null,
    });
  }

  /**
   * The one place the "new threads" default is switched. Recording the moment
   * it turned on is what lets the dispatch hook distinguish a thread created
   * under the default from one that merely predates it.
   */
  async function setDefault(enabled: boolean): Promise<boolean> {
    await settings.experimental_set({ defaultForNewThreads: enabled });
    live.defaultForNewThreads = enabled;
    live.defaultEnabledAtMs = enabled ? Date.now() : 0;
    await persistDefaultEnabledAt();
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return enabled;
  }

  /**
   * Replace the stored worker execution. `null` clears it, leaving every
   * delegation on the project's remembered defaults. A record must name both a
   * provider and a model — the settings section renders them with BB's picker,
   * which resolves the pair against the live catalog, and every id it cannot
   * serve is refused here rather than spawned.
   */
  async function setWorkerExecution(next: WorkerExecution | null): Promise<WorkerExecution> {
    if (next !== null) {
      if (next.providerId === undefined || next.model === undefined) {
        throw new Error("A worker execution needs both a provider and a model.");
      }
      assertInCatalog(next);
    }
    const stored = next === null ? {} : reconcile(next);
    await bb.storage.kv.set(WORKER_KEY, stored);
    live.worker = stored;
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return stored;
  }

  applySettings(await settings.get());
  live.worker = storedWorkerExecution(await bb.storage.kv.get<unknown>(WORKER_KEY));
  {
    const stored = await bb.storage.kv.get<{ enabledAtMs?: unknown }>(DEFAULT_KEY);
    const storedAt =
      stored !== undefined && typeof stored.enabledAtMs === "number" ? stored.enabledAtMs : null;
    if (live.defaultForNewThreads) {
      // A default switched on by an older build, or straight through settings,
      // has no recorded moment: claim now, so only threads created from here
      // on are caught by it.
      live.defaultEnabledAtMs = storedAt ?? Date.now();
      if (storedAt === null) await persistDefaultEnabledAt();
    } else {
      live.defaultEnabledAtMs = 0;
    }
  }
  settings.onChange((next, prev) => {
    const wasOn = prev.defaultForNewThreads === true;
    const isOn = next.defaultForNewThreads === true;
    applySettings(next);
    if (isOn && !wasOn) {
      live.defaultEnabledAtMs = Date.now();
      void persistDefaultEnabledAt();
    } else if (!isOn && wasOn) {
      live.defaultEnabledAtMs = 0;
      void persistDefaultEnabledAt();
    }
    bb.log.info(`enforcement=${live.enforcement} default=${live.defaultForNewThreads}`);
  });

  // --- state store ---------------------------------------------------------
  //
  // Authoritative per-thread state lives in this plugin's KV, which the thread's
  // own agent cannot write. Thread metadata carries a mirror of it only because
  // `bb.agents.configure` is synchronous and metadata is its only per-thread
  // input. The dispatch hook rewrites the mirror before every turn.

  let cache: Record<string, ThreadState> | null = null;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  async function readAll(): Promise<Record<string, ThreadState>> {
    if (cache !== null) return cache;
    const stored = await bb.storage.kv.get<Record<string, ThreadState>>(STATE_KEY);
    cache = stored !== undefined && typeof stored === "object" && stored !== null ? stored : {};
    return cache;
  }

  /**
   * Fill in fields added after a state row was written. A thread enabled by an
   * older build of this plugin must keep being watched after an update instead
   * of crashing the scan on a missing array.
   */
  function normalize(state: ThreadState): ThreadState {
    return {
      ...state,
      violations: Array.isArray(state.violations) ? state.violations : [],
      seenRowIds: Array.isArray(state.seenRowIds) ? state.seenRowIds : [],
      delegations: Array.isArray(state.delegations) ? state.delegations : [],
      graceTurnIds: Array.isArray(state.graceTurnIds) ? state.graceTurnIds : [],
      graceSlots: typeof state.graceSlots === "number" ? state.graceSlots : 1,
      lastSeq: typeof state.lastSeq === "number" ? state.lastSeq : 0,
      nudgeCount: typeof state.nudgeCount === "number" ? state.nudgeCount : 0,
    };
  }

  async function persist(next: Record<string, ThreadState>): Promise<void> {
    await bb.storage.kv.set(STATE_KEY, next);
    cache = next;
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
  }

  function emptyState(now: number): ThreadState {
    return {
      enabled: false,
      enforcement: null,
      enabledAt: null,
      touchedAt: now,
      violations: [],
      seenRowIds: [],
      lastSeq: 0,
      graceTurnIds: [],
      graceSlots: 1,
      nudgeCount: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
      delegations: [],
    };
  }

  async function getState(threadId: string): Promise<ThreadState | undefined> {
    const all = await readAll();
    const stored = all[threadId];
    return stored === undefined ? undefined : normalize(stored);
  }

  function mutateState(
    threadId: string,
    update: (current: ThreadState) => ThreadState | null,
  ): Promise<ThreadState | undefined> {
    // Serialize the read as well as the write: parallel delegations and thread
    // toggles must derive their updates from the preceding committed state.
    const mutation = mutationQueue.then(async () => {
      const all = { ...(await readAll()) };
      const current = normalize(all[threadId] ?? emptyState(Date.now()));
      const next = update(current);
      if (next === null) {
        if (all[threadId] === undefined) return undefined;
        delete all[threadId];
        await persist(prune(all));
        return undefined;
      }
      next.touchedAt = Date.now();
      all[threadId] = next;
      await persist(prune(all));
      return next;
    });
    // A failed mutation rejects its caller without wedging subsequent updates.
    mutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  function clearViolations(threadId: string): Promise<ThreadState | undefined> {
    return mutateState(threadId, (current) => ({
      ...current,
      violations: [],
      nudgeCount: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
    }));
  }

  /** Drop the least recently touched threads once the map outgrows its cap. */
  function prune(all: Record<string, ThreadState>): Record<string, ThreadState> {
    const ids = Object.keys(all);
    if (ids.length <= MAX_THREADS) return all;
    const ordered = ids.sort((a, b) => (all[a]!.touchedAt ?? 0) - (all[b]!.touchedAt ?? 0));
    const out: Record<string, ThreadState> = {};
    for (const id of ordered.slice(ordered.length - MAX_THREADS)) out[id] = all[id]!;
    return out;
  }

  function effectiveEnforcement(state: ThreadState | undefined): EnforcementLevel {
    return state?.enforcement ?? live.enforcement;
  }

  function toDto(threadId: string, state: ThreadState | undefined): OrchestratorStateDto {
    const base = state ?? emptyState(Date.now());
    return {
      enabled: state?.enabled ?? false,
      enforcement: base.enforcement,
      effectiveEnforcement: effectiveEnforcement(state),
      enabledAt: base.enabledAt,
      violations: base.violations.slice(-MAX_VIOLATIONS),
      delegations: base.delegations.slice(-MAX_DELEGATIONS),
      nudgeCount: base.nudgeCount,
      defaultForNewThreads: live.defaultForNewThreads,
      allowReadCommands: live.allowReadCommands,
      maxNudges: live.maxNudges,
      workerExecution: workerDefaults(),
    };
  }

  /** Read the thread's current timeline head so a scan starts after it. */
  async function timelineHead(
    threadId: string,
  ): Promise<{ seq: number; turnId: string | null }> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId });
      const response = timeline as { maxSeq?: unknown; rows?: unknown };
      const seq =
        typeof response.maxSeq === "number" && Number.isFinite(response.maxSeq)
          ? response.maxSeq
          : 0;
      const rows = asScanRows(response.rows);
      return { seq, turnId: rows.length === 0 ? null : (rows[rows.length - 1]!.turnId ?? null) };
    } catch (cause) {
      bb.log.warn(`timeline head read failed for ${threadId}: ${String(cause)}`);
      return { seq: 0, turnId: null };
    }
  }

  async function setEnabled(
    threadId: string,
    enabled: boolean,
    enforcement: EnforcementLevel | null,
  ): Promise<ThreadState> {
    // Seeding the sequence head when turning on means historical work in an
    // existing thread is never retroactively flagged.
    const head = enabled ? await timelineHead(threadId) : { seq: 0, turnId: null };
    // A thread with a turn in flight loses that turn AND the next one to the
    // session lag; an idle thread loses only the next one.
    let graceTurnIds: string[] = [];
    let graceSlots = 1;
    if (enabled) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.status === "active" && head.turnId !== null) {
          graceTurnIds = [head.turnId];
          graceSlots = 2;
        }
      } catch (cause) {
        bb.log.warn(`thread status read failed for ${threadId}: ${String(cause)}`);
      }
    }
    const state = await mutateState(threadId, (current) => ({
      ...current,
      enabled,
      enforcement,
      enabledAt: enabled ? (current.enabledAt ?? new Date().toISOString()) : null,
      lastSeq: enabled ? head.seq : current.lastSeq,
      graceTurnIds: enabled ? graceTurnIds : current.graceTurnIds,
      graceSlots: enabled ? graceSlots : current.graceSlots,
      nudgeCount: enabled ? current.nudgeCount : 0,
      lastNudgeTurnId: enabled ? current.lastNudgeTurnId : null,
      lastStopTurnId: enabled ? current.lastStopTurnId : null,
    }));
    await syncMirror(threadId, state?.enabled ?? false, state?.enforcement ?? null);
    return state ?? emptyState(Date.now());
  }

  async function syncMirror(
    threadId: string,
    enabled: boolean,
    enforcement: EnforcementLevel | null,
  ): Promise<void> {
    try {
      const current = await bb.sdk.threads.getPluginMetadata({ threadId });
      const mirror = readMirror(current as Record<string, unknown>);
      if (mirror !== null && mirror.enabled === enabled && mirror.enforcement === enforcement) {
        return;
      }
      // No mirror of ours and nothing to enforce: leave the namespace alone
      // rather than writing an "off" entry onto every thread in the app.
      if (mirror === null && !enabled) return;
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: writeMirror({ enabled, enforcement }),
      });
    } catch (cause) {
      // A missing thread (deleted between the write and the mirror) is normal.
      bb.log.warn(`mirror sync failed for ${threadId}: ${String(cause)}`);
    }
  }

  // --- layer 1: the contract ----------------------------------------------

  bb.agents.registerTool({
    name: DELEGATE_TOOL,
    description:
      "Hand one unit of work to a worker thread and get its result back. The only way an orchestrator-mode thread gets work done. The worker cannot see this conversation, so `task` must be a complete, self-contained brief: goal, context, constraints, and what done means.",
    instructions:
      "In orchestrator mode, delegate every unit of real work with orchestrator_delegate instead of doing it yourself. Fan out independent units in parallel; sequence only genuine dependencies.",
    presentation: {
      label: {
        pending: "Delegating to a worker thread",
        completed: "Delegated to a worker thread",
      },
    },
    parameters: z.object({
      task: z
        .string()
        .min(1)
        .max(20_000)
        .describe("Complete, self-contained brief for the worker."),
      title: z.string().max(200).optional().describe("Worker thread title."),
      waitForResult: z
        .boolean()
        .optional()
        .describe("Wait for the worker to finish and return its result. Default true."),
      timeoutSeconds: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe("How long to wait. Default 900."),
      hidden: z
        .boolean()
        .optional()
        .describe("Keep the worker out of the sidebar. Default false."),
      model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Model id for this worker, taken from the provider catalog (`bb provider models <provider>`). Defaults to the plugin's worker model, then the project's remembered model.",
        ),
      provider: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Provider id for this worker, taken from the provider catalog (`bb provider list`). Defaults to the plugin's worker provider, then the project's remembered provider.",
        ),
      reasoning: z
        .enum(REASONING_LEVELS)
        .optional()
        .describe(
          "Reasoning level for this worker. Defaults to the plugin's worker reasoning level, then the project's remembered level.",
        ),
      permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe(
          "Permission mode for this worker. Defaults to the plugin's worker permission mode, then the project's remembered mode.",
        ),
    }),
    async execute(
      {
        task,
        title,
        waitForResult,
        timeoutSeconds,
        hidden,
        model,
        provider,
        reasoning,
        permissionMode,
      },
      { threadId, projectId, signal },
    ) {
      if (threadId === undefined || projectId === undefined) {
        throw new Error("orchestrator_delegate needs a thread context.");
      }
      const parent = await bb.sdk.threads.get({ threadId });
      const environment =
        parent.environmentId === null
          ? { type: "project-default" as const }
          : { type: "reuse" as const, environmentId: parent.environmentId };
      const workerTitle = title?.trim() || task.trim().split("\n")[0]!.slice(0, 120);

      // Per-delegation arguments win over the plugin's worker settings; a field
      // neither names is left out so the worker resolves the project default.
      const workerExec = reconcile({
        ...workerDefaults(),
        ...(provider === undefined ? {} : { providerId: provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoning === undefined ? {} : { reasoningLevel: reasoning }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
      });
      assertInCatalog(workerExec);

      const worker = await bb.sdk.threads.spawn({
        projectId,
        environment,
        prompt: task,
        title: workerTitle,
        parentThreadId: threadId,
        ...(hidden === true ? { visibility: "hidden" as const } : {}),
        ...workerExec,
        // The server drops a requested provider/model that carries no
        // provenance source and re-derives it from the project's remembered
        // defaults, which would silently undo everything above.
        ...(Object.keys(workerExec).length === 0
          ? {}
          : { executionInputSources: executionSources(workerExec) }),
        pluginMetadata: { workerFor: threadId },
      });

      await mutateState(threadId, (current) => ({
        ...current,
        delegations: [
          ...current.delegations,
          {
            threadId: worker.id,
            title: workerTitle,
            task: task.slice(0, 400),
            createdAt: Date.now(),
            status: null,
          },
        ].slice(-MAX_DELEGATIONS),
      }));

      if (waitForResult === false) {
        return `Delegated without waiting.\nWorker thread: ${worker.id} — "${workerTitle}"\nCheck on it later and fold its result into your report.`;
      }

      const timeoutMs = Math.min(Math.max(timeoutSeconds ?? 900, 10), 3600) * 1000;
      const deadline = Date.now() + timeoutMs;
      let status: string | null = null;
      try {
        await bb.sdk.threads.wait({ threadId: worker.id, status: "idle", timeoutMs, signal });
      } catch {
        // A timeout or an error status both land here; read the real status.
      }
      try {
        const settled = await bb.sdk.threads.get({ threadId: worker.id });
        status = settled.status;
      } catch {
        status = null;
      }
      await mutateState(threadId, (current) => ({
        ...current,
        delegations: current.delegations.map((delegation) =>
          delegation.threadId === worker.id ? { ...delegation, status } : delegation,
        ),
      }));

      if (Date.now() >= deadline && status !== "idle" && status !== "error") {
        return `Worker ${worker.id} is still running after ${Math.round(timeoutMs / 1000)}s (status: ${status ?? "unknown"}). Delegate the next unit, or wait and check it again — do not start doing its work yourself.`;
      }

      let output: string | null = null;
      try {
        const result = await bb.sdk.threads.output({ threadId: worker.id });
        output = (result as { output?: string | null }).output ?? null;
      } catch (cause) {
        bb.log.warn(`worker output read failed for ${worker.id}: ${String(cause)}`);
      }

      const trimmed = (output ?? "").trim();
      const body =
        trimmed === ""
          ? "(the worker produced no final text — open the thread to see what it did)"
          : trimmed.length > 12_000
            ? `${trimmed.slice(0, 12_000)}\n\n[truncated]`
            : trimmed;
      return `Worker ${worker.id} finished with status "${status ?? "unknown"}".\n\n${body}\n\nReview it. If it is wrong or incomplete, send a follow-up to a worker — do not fix it yourself.`;
    },
  });

  bb.agents.configure((context) => {
    // The mirror is the only source of truth here. `configure` is synchronous
    // and receives no createdAt, so it cannot tell a thread created under the
    // new-thread default from one that merely predates it — guessing here is
    // what once governed every mirror-less thread in the app. The dispatch
    // hook, which does have createdAt, is the single place the default lands.
    const mirror = readMirror(context.pluginMetadata as Record<string, unknown>);
    const enabled = mirror !== null && mirror.enabled;
    if (!enabled) return { tools: [], skills: [] };
    const enforcement = mirror?.enforcement ?? live.enforcement;
    const state = cache?.[context.thread.id];
    const reminders =
      state === undefined || state.violations.length === 0
        ? undefined
        : state.violations.slice(-5).map((violation) => violation.detail);
    return {
      tools: [DELEGATE_TOOL],
      skills: [],
      instructions: buildInstructions({
        enforcement,
        allowReadCommands: live.allowReadCommands,
        reminders,
        workerExecution: workerDefaults(),
      }),
    };
  });

  // --- layer 2: the dispatch checkpoint ------------------------------------

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const threadId = ctx.thread.id;
    try {
      let state = await getState(threadId);
      if (state === undefined) {
        const qualifies =
          live.defaultForNewThreads &&
          live.defaultEnabledAtMs > 0 &&
          ctx.thread.createdAt >= live.defaultEnabledAtMs &&
          // A preference for threads *you* start. Plugin-spawned background
          // workers (recap runners, watchers) are root threads too, and a
          // background worker that may only delegate is a background worker
          // that does nothing.
          ctx.initiator === "user" &&
          defaultAppliesTo({
            parentThreadId: ctx.thread.parentThreadId,
            originPluginId: ctx.thread.originPluginId,
          });
        if (qualifies) {
          const head = await timelineHead(threadId);
          state = await mutateState(threadId, (current) => ({
            ...current,
            enabled: true,
            enforcement: null,
            enabledAt: new Date().toISOString(),
            lastSeq: head.seq,
            graceTurnIds: head.turnId === null ? [] : [head.turnId],
            graceSlots: 1,
          }));
          bb.log.info(`orchestrator mode applied by default to ${threadId}`);
        }
      }
      if (state === undefined) {
        // We have never enforced this thread and the default does not reach it,
        // so there is no mirror of ours to correct: leave the dispatch path
        // without touching the SDK. A thread we did enable always has state,
        // so a forged mirror is still caught and rewritten below.
        return { action: "proceed" as const };
      }
      await syncMirror(threadId, state.enabled, state.enforcement);
      if (state.enabled) scheduleScan(threadId, 0);
    } catch (cause) {
      // Never block a dispatch because the mirror could not be refreshed; the
      // next turn tries again and the watchdog still reads authoritative state.
      bb.log.warn(`dispatch sync failed for ${threadId}: ${String(cause)}`);
    }
    return { action: "proceed" as const };
  });

  // --- layer 3: the watchdog ----------------------------------------------

  const scanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scanning = new Set<string>();
  /** Set on dispose so an in-flight scan stops touching `bb.sdk`. */
  let disposed = false;

  function scheduleScan(threadId: string, delayMs = 750): void {
    if (disposed) return;
    const existing = scanTimers.get(threadId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      scanTimers.delete(threadId);
      void runScan(threadId);
    }, delayMs);
    // Do not hold the process open for a pending scan.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    scanTimers.set(threadId, timer);
  }

  async function runScan(threadId: string): Promise<void> {
    if (disposed || scanning.has(threadId)) return;
    scanning.add(threadId);
    try {
      await scan(threadId);
    } catch (cause) {
      bb.log.warn(`scan failed for ${threadId}: ${String(cause)}`);
    } finally {
      scanning.delete(threadId);
    }
  }

  async function scan(threadId: string): Promise<void> {
    const state = await getState(threadId);
    if (state === undefined || !state.enabled) return;
    const enforcement = effectiveEnforcement(state);
    if (enforcement === "instruct") return;

    const timeline = await bb.sdk.threads.timeline({
      threadId,
      includeNestedRows: "true",
      ...(state.lastSeq > 0 ? { afterSequence: String(state.lastSeq) } : {}),
    });
    // Incremental responses carry row patches instead of full rows. Nested
    // rows keep work visible after a completed turn collapses to a summary.
    const rows = asScanRows(timeline.delta?.upsertRows ?? timeline.rows);
    const enabledAtMs = state.enabledAt === null ? 0 : Date.parse(state.enabledAt);
    let maxSeq = Math.max(state.lastSeq, timeline.maxSeq);
    const graceTurnIds = [...state.graceTurnIds];
    const fresh: Violation[] = [];
    for (const row of rows) {
      const seq = typeof row.sourceSeqEnd === "number" ? row.sourceSeqEnd : 0;
      if (seq > maxSeq) maxSeq = seq;
      if (seq !== 0 && seq <= state.lastSeq) continue;
      if (state.seenRowIds.includes(row.id)) continue;
      const turnId = row.turnId ?? null;
      const startedAt = typeof row.startedAt === "number" ? row.startedAt : 0;
      if (
        turnId !== null &&
        !graceTurnIds.includes(turnId) &&
        graceTurnIds.length < state.graceSlots &&
        startedAt >= enabledAtMs
      ) {
        graceTurnIds.push(turnId);
      }
      // Turns that ran before the session could gain the contract are never
      // judged — only recorded.
      if (turnId !== null && graceTurnIds.includes(turnId)) continue;
      const violation = classifyRow(row, { allowReadCommands: live.allowReadCommands });
      if (violation !== null) fresh.push(violation);
    }

    if (fresh.length === 0 && maxSeq === state.lastSeq) return;

    const updated = await mutateState(threadId, (current) => ({
      ...current,
      lastSeq: Math.max(current.lastSeq, maxSeq),
      graceTurnIds,
      seenRowIds: [...current.seenRowIds, ...rows.map((row) => row.id)].slice(-MAX_SEEN_ROWS),
      violations: [...current.violations, ...fresh].slice(-MAX_VIOLATIONS),
    }));
    if (fresh.length === 0) return;

    bb.log.warn(
      `${threadId} did direct work ${fresh.length} time(s): ${fresh
        .map((violation) => violation.detail)
        .join("; ")}`,
    );
    bb.realtime.publish(STATE_CHANGED, { at: Date.now(), threadId, violations: fresh.length });
    await intervene(threadId, updated, fresh, enforcement);
  }

  async function intervene(
    threadId: string,
    state: ThreadState | undefined,
    violations: readonly Violation[],
    enforcement: EnforcementLevel,
  ): Promise<void> {
    if (state === undefined) return;
    const turnId = violations.find((violation) => violation.turnId !== null)?.turnId ?? "unknown";

    if (enforcement === "block" && state.lastStopTurnId !== turnId) {
      try {
        await bb.sdk.threads.stop({ threadId });
        await mutateState(threadId, (current) => ({ ...current, lastStopTurnId: turnId }));
        bb.log.warn(`stopped ${threadId} for doing direct work`);
      } catch (cause) {
        bb.log.warn(`stop failed for ${threadId}: ${String(cause)}`);
      }
    }

    if (state.lastNudgeTurnId === turnId) return;
    if (state.nudgeCount >= live.maxNudges) return;
    const text = buildNudge(violations, enforcement);
    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
      await mutateState(threadId, (current) => ({
        ...current,
        nudgeCount: current.nudgeCount + 1,
        lastNudgeTurnId: turnId,
      }));
    } catch (cause) {
      bb.log.warn(`nudge failed for ${threadId}: ${String(cause)}`);
    }
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    void (async () => {
      const state = await getState(thread.id);
      if (state?.enabled === true) scheduleScan(thread.id);
    })();
  });

  bb.events.on("thread.idle", ({ thread }) => {
    void (async () => {
      const state = await getState(thread.id);
      if (state?.enabled === true) scheduleScan(thread.id, 250);
    })();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    void mutateState(thread.id, () => null);
  });

  // --- RPC -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    get_state: async ({ threadId }) => toDto(threadId, await getState(threadId)),
    set_enabled: async ({ threadId, enabled, enforcement }) => {
      const state = await setEnabled(threadId, enabled, enforcement ?? null);
      return toDto(threadId, state);
    },
    get_default: async () => ({ enabled: live.defaultForNewThreads }),
    set_default: async ({ enabled }) => ({ enabled: await setDefault(enabled) }),
    get_worker_execution: async () => workerDefaults(),
    set_worker_execution: async (next) => setWorkerExecution(next),
    clear_violations: async ({ threadId }) => {
      const state = await clearViolations(threadId);
      return toDto(threadId, state);
    },
  });

  // --- CLI -----------------------------------------------------------------

  const threadOption = {
    thread: {
      type: "string",
      description: "Thread id. Defaults to the thread running this command.",
      aliases: ["t"],
    },
    json: { type: "boolean", description: "Emit machine-readable JSON" },
  } as const;

  function resolveThreadId(explicit: string | undefined, ctx: { threadId?: string }): string {
    const threadId = explicit?.trim() || ctx.threadId;
    if (threadId === undefined || threadId === "") {
      throw new PluginCliError("no thread to act on", {
        code: "thread_required",
        hint: "Pass --thread <thread-id>, or run this inside a bb thread.",
      });
    }
    return threadId;
  }

  function render(
    json: boolean | undefined,
    value: unknown,
    text: string,
  ): { exitCode: number; stdout: string } {
    return { exitCode: 0, stdout: json === true ? JSON.stringify(value, null, 2) : text };
  }

  /** One line naming what a delegation's worker will run on. */
  function describeWorkerExecution(exec: OrchestratorStateDto["workerExecution"]): string {
    const parts = [
      exec.providerId === undefined ? null : `provider ${exec.providerId}`,
      exec.model === undefined ? null : `model ${exec.model}`,
      exec.reasoningLevel === undefined ? null : `reasoning ${exec.reasoningLevel}`,
      exec.serviceTier === undefined ? null : `tier ${exec.serviceTier}`,
      exec.permissionMode === undefined ? null : `permission ${exec.permissionMode}`,
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? "project default (no worker override)" : parts.join(", ");
  }

  function describeState(threadId: string, state: OrchestratorStateDto): string {
    const lines = [
      `thread ${threadId}`,
      `  orchestrator mode: ${state.enabled ? "ON" : "off"}`,
      `  enforcement:       ${state.effectiveEnforcement}${
        state.enforcement === null ? " (plugin default)" : " (thread override)"
      }`,
      `  violations:        ${state.violations.length}`,
      `  nudges sent:       ${state.nudgeCount} of ${state.maxNudges}`,
      `  delegations:       ${state.delegations.length}`,
      `  workers run as:    ${describeWorkerExecution(state.workerExecution)}`,
    ];
    if (state.violations.length > 0) {
      lines.push("  recent direct work:");
      for (const violation of state.violations.slice(-5)) {
        lines.push(`    - ${violation.detail}`);
      }
    }
    return lines.join("\n");
  }

  bb.cli.register(
    defineCli({
      name: "orchestrator-mode",
      summary: "Force a thread to delegate every unit of work instead of doing it",
      description:
        "Turn orchestrator mode on for a thread and it may only read, plan, ask, delegate and report. `bb orchestrator-mode --help` for every command.",
      commands: {
        status: cliCommand({
          summary: "Show a thread's orchestrator mode, violations and delegations",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const state = toDto(threadId, await getState(threadId));
            return render(input.options.json, state, describeState(threadId, state));
          },
        }),
        on: cliCommand({
          summary: "Turn orchestrator mode on for a thread",
          options: {
            ...threadOption,
            enforcement: {
              type: "enum",
              values: [...ENFORCEMENT_LEVELS],
              description: "Override the plugin's enforcement level for this thread",
            },
          },
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const enforcement =
              input.options.enforcement === undefined
                ? null
                : (input.options.enforcement as EnforcementLevel);
            const state = await setEnabled(threadId, true, enforcement);
            await syncMirror(threadId, true, state.enforcement);
            const dto = toDto(threadId, state);
            return render(
              input.options.json,
              dto,
              `Orchestrator mode ON for ${threadId} (${dto.effectiveEnforcement}).\n` +
                "Applies when the provider session is next constructed — a live session keeps the instructions it started with.",
            );
          },
        }),
        off: cliCommand({
          summary: "Turn orchestrator mode off for a thread",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const state = await setEnabled(threadId, false, null);
            const dto = toDto(threadId, state);
            return render(input.options.json, dto, `Orchestrator mode off for ${threadId}.`);
          },
        }),
        violations: cliCommand({
          summary: "List the direct work a thread did, or clear the record",
          options: { ...threadOption, clear: { type: "boolean", description: "Clear the record" } },
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            if (input.options.clear === true) {
              const state = await clearViolations(threadId);
              return render(input.options.json, toDto(threadId, state), `Cleared for ${threadId}.`);
            }
            const state = await getState(threadId);
            const violations = state?.violations ?? [];
            if (violations.length === 0) {
              return render(input.options.json, [], `No direct work recorded for ${threadId}.`);
            }
            const text = violations
              .map(
                (violation) =>
                  `${new Date(violation.detectedAt).toISOString()}  [${violation.workKind}] ${violation.detail}`,
              )
              .join("\n");
            return render(input.options.json, violations, text);
          },
        }),
        default: cliCommand({
          summary: "Show or set whether new threads start in orchestrator mode",
          positionals: [
            { name: "state", description: "on or off; omit to show the current default" },
          ],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const requested = input.positionals.state?.toLowerCase();
            if (requested === undefined || requested === "") {
              return render(input.options.json, { enabled: live.defaultForNewThreads }, 
                `New threads start in orchestrator mode: ${live.defaultForNewThreads ? "yes" : "no"}`);
            }
            if (requested !== "on" && requested !== "off") {
              throw new PluginCliError(`expected "on" or "off", got "${requested}"`, {
                code: "invalid_state",
              });
            }
            const enabled = requested === "on";
            await setDefault(enabled);
            return render(input.options.json, { enabled }, 
              `New threads start in orchestrator mode: ${enabled ? "yes" : "no"}`);
          },
        }),
        worker: cliCommand({
          summary: "Show or set the execution every delegated worker defaults to",
          options: {
            clear: { type: "boolean", description: "Clear it, so workers inherit again" },
            provider: { type: "string", description: "Provider id, from `bb provider list`" },
            model: {
              type: "string",
              description: "Model id, from `bb provider models <provider>`",
            },
            reasoning: {
              type: "enum",
              values: [...REASONING_LEVELS],
              description: "Reasoning level for workers",
            },
            tier: {
              type: "enum",
              values: [...SERVICE_TIERS],
              description: "Service tier for workers",
            },
            permission: {
              type: "enum",
              values: [...PERMISSION_MODES],
              description: "Permission mode for workers",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const chosen = {
              ...(input.options.provider === undefined ? {} : { providerId: input.options.provider }),
              ...(input.options.model === undefined ? {} : { model: input.options.model }),
              ...(input.options.reasoning === undefined
                ? {}
                : { reasoningLevel: input.options.reasoning as ReasoningLevel }),
              ...(input.options.tier === undefined
                ? {}
                : { serviceTier: input.options.tier as ServiceTier }),
              ...(input.options.permission === undefined
                ? {}
                : { permissionMode: input.options.permission as PermissionMode }),
            };
            const clearing = input.options.clear === true;
            if (!clearing && Object.keys(chosen).length === 0) {
              return render(
                input.options.json,
                workerDefaults(),
                `Workers run as: ${describeWorkerExecution(workerDefaults())}`,
              );
            }
            const stored = await setWorkerExecution(clearing ? null : chosen);
            return render(
              input.options.json,
              stored,
              `Workers run as: ${describeWorkerExecution(stored)}`,
            );
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    disposed = true;
    for (const timer of scanTimers.values()) clearTimeout(timer);
    scanTimers.clear();
    scanning.clear();
  });

  bb.log.info(`loaded (enforcement=${live.enforcement})`);
}
