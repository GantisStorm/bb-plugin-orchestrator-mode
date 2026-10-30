// Backend for the orchestrator-mode plugin.
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
//      new work row; in `guard`/`block` it records violations, stops the
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
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { judgeSecretStore } from "./judge-secret";
import { childMessageQueue, CHILD_BATCH_WAIT_REASON } from "./child-message-queue";
import {
  CHECK_TOOL,
  CONTRACT_PRESETS,
  DEFAULT_ENFORCEMENT,
  DELEGATE_TOOL,
  ENFORCEMENT_LEVELS,
  KIND_CHECKS,
  KIND_WORKSPACES,
  ORCHESTRATOR_SUBAGENT_POLICIES,
  PINNED_DELEGATION_FIELDS,
  PERMISSION_MODES,
  REASONING_LEVELS,
  REVIEW_TOOL,
  REVIEW_VERDICTS,
  WORKER_MODEL_POLICIES,
  WORKER_MODEL_POLICY_DESCRIPTIONS,
  WORKER_PRESETS,
  WORKER_RETENTION,
  WORKER_RETENTION_DESCRIPTIONS,
  WORKER_WORKSPACE_DESCRIPTIONS,
  WORKER_WORKSPACES,

  WORKER_SUBAGENT_POLICIES,
  WORKER_SUBAGENT_RULE,
  SERVICE_TIERS,
  EXTRA_INSTRUCTION_LIMIT,
  INSTRUCTION_LIMIT,
  buildInstructions,
  buildNudge,
  buildReviewNudge,
  buildRevisionBrief,
  buildVerifierBrief,
  classifyRow,
  minimizeCheckEvidence,
  parseVerdictLine,
  unquotedReportLines,
  subagentsOf,
  defaultAppliesTo,
  isEnforcementLevel,
  isOneOf,
  readMirror,
  writeMirror,
  type EnforcementLevel,
  type PermissionMode,
  type ReasoningLevel,
  type ReviewVerdict,
  type WorkerRetention,
  type WorkerWorkspace,
  type ServiceTier,
  type Violation,
  type WorkerCatalog,
  type WorkerConfig,
  type WorkerPresetName,
  type ContractPresetId,
  type WorkRowLike,
  type WorkerExecution,
  type WorkerModelOption,
  type WorkerModelPolicy,
  type OrchestratorSubagentPolicy,
  type WorkerSubagentPolicy,
} from "./shared";

export { CHECK_TOOL, DELEGATE_TOOL };

/** Realtime channel the composer surfaces listen on. */
const STATE_CHANGED = "orchestrator-state";

/**
 * The app renderer `setup-jev` names in `bb.ui.requestInput`, and the bounds of
 * the key that form may return. The key is never a CLI option, never part of a
 * form payload, never logged and never part of a result: `readJudgeKey` below is
 * the only code that reads it out of a submission, and the caller holds it only
 * for the length of one settings write.
 */
const SETUP_JEV_RENDERER = "setup-jev";
/** Below this, a submitted value cannot be an API key, so nothing is stored. */
const JUDGE_KEY_MIN_LENGTH = 8;
/** Above this, the submission is refused rather than stored and reported. */
const JUDGE_KEY_MAX_LENGTH = 512;

/**
 * The only shape `setup-jev` accepts from the form: `{ key: string }` meeting
 * both bounds and containing no whitespace or control character. Nothing else in
 * the submission is read, and no refusal repeats what was submitted: the value
 * must not reach stdout, stderr, the transcript or this plugin's log.
 */
function readJudgeKey(value: unknown): string {
  const submitted =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { key?: unknown }).key
      : undefined;
  if (typeof submitted !== "string") {
    throw new PluginCliError("the form did not submit a key, so nothing was stored", {
      code: "invalid_key",
    });
  }
  const key = submitted.trim();
  if (key.length < JUDGE_KEY_MIN_LENGTH || key.length > JUDGE_KEY_MAX_LENGTH) {
    throw new PluginCliError(
      `the submitted key is not usable (expected ${JUDGE_KEY_MIN_LENGTH}–${JUDGE_KEY_MAX_LENGTH} characters), so nothing was stored`,
      { code: "invalid_key" },
    );
  }
  if (/[\s\x00-\x1f\x7f]/.test(key)) {
    throw new PluginCliError(
      "the submitted key is not usable (it contains whitespace or a control character), so nothing was stored",
      { code: "invalid_key" },
    );
  }
  return key;
}

/**
 * The global settings record: every thread-behaviour setting, plus the composer
 * default. Stored here rather than as BB settings descriptors because a
 * descriptor has one value per install, and these resolve per project; the
 * editor is the plugin's own settings section, which picks the scope.
 */
const GLOBAL_SETTINGS_KEY = "settings";
/** When the "new threads" default was last switched on; null while it is off. */
const DEFAULT_KEY = "default";
/** The stored worker execution every delegation defaults to. */
const WORKER_KEY = "worker";
/** Per-project overrides, keyed by project id: settings, worker execution, appended rules. */
const PROJECT_SETTINGS_KEY = "project_settings";
const PROJECT_WORKER_KEY = "project_worker";
const PROJECT_RULES_KEY = "project_rules";
/** The stored project rules appended to the contract. */
const CONTRACT_KEY = "contract";
/**
 * Verdict-owed records kept outside the newest window. They are exempt from the
 * window itself so a late verdict is never refused, which is exactly why they need
 * a cap: an orchestrator that never records verdicts would otherwise grow the
 * array, and the whole state is re-serialized into KV on every mutation.
 */
const MAX_UNJUDGED_RETAINED = 200;

/**
 * The legacy single KV map this build used to write. It is read once by
 * `importLegacyState` and never written again; a per-thread table row replaced
 * it because one KV value's byte ceiling forced evictions between threads.
 */
const STATE_KEY = "state";
const MAX_VIOLATIONS = 100;
const MAX_SEEN_ROWS = 500;
const MAX_DELEGATIONS = 50;
/**
 * One page each of a thread's children and of its forks, read so the
 * `bb thread tell` exemption covers threads this plugin did not itself
 * delegate. Hidden threads count: a worker kept out of the sidebar is still
 * owned. The cap bounds each read; a parent with more than this under-exempts
 * rather than paging the host from a scan.
 */
const MAX_CHILD_THREADS = 200;

/**
 * The statuses BB shows a child thread as still working: `starting` before its
 * first turn, `active` during one, `stopping` while it is being wound down.
 * Archived and deleted children are dropped before these are counted, so a
 * count is a count of current children.
 */
const RUNNING_CHILD_STATUSES = ["starting", "active", "stopping"] as const;
const RUNNING_CHILD_STATUS_SET = new Set<string>(RUNNING_CHILD_STATUSES);

/**
 * How the live child count is read. `threads.count` cannot answer it: the count
 * route takes no `includeHidden`, so a hidden child — a worker kept out of the
 * sidebar, which still runs and still holds a slot — is silently missing from
 * its total. The list route does take `includeHidden` and pages through
 * `limit`/`offset`, so the count accumulates pages until a short page proves
 * the end.
 *
 * Three full pages of 200 bound one read at 600 children. A parent past that
 * is proved inexact by one probing row and reported unknown: a count that might
 * be short is worse than "unknown", because the strip would present it as
 * fact.
 */
const CHILD_COUNT_PAGE_SIZE = 200;
const CHILD_COUNT_MAX_PAGES = 3;

/**
 * How long one live child-count read is reused, so a burst of state reads (a
 * realtime event per mutation, plus every panel that mounts) does not turn into
 * a burst of BB queries. Counts are points in time, not durable facts.
 */
const CHILD_COUNT_TTL_MS = 2_000;

/** BB's current thread tree under one orchestrator, or why it could not be read. */
export interface ChildCounts {
  available: boolean;
  /** Direct children that are not archived or deleted; hidden children count. */
  total: number;
  running: number;
  error: string | null;
}

export interface JudgeOpinion {
  agrees: boolean;
  rationale: string;
}

/** Whether the advisory judge answered, and why not when it did not. */
export type JudgeOutcome = { ok: true; opinion: JudgeOpinion } | { ok: false; error: string };

/**
 * An advisory second opinion on a check unit's report, from Jev through
 * OpenRouter. It only adds text to the result: it never records a verdict,
 * blocks a unit or stops a turn. A failure is reported to the orchestrator as
 * the failure it was, so a broken key or endpoint is visible instead of silent.
 *
 * Jev is not a chat model. OpenRouter serves it on the decisions endpoint
 * (`/api/alpha/decisions`) with a typed question, and answers with a
 * probability — never prose. The old call to `/api/v1/chat/completions` named a
 * model that endpoint does not serve, so it could not succeed.
 *
 * Only {@link minimizeCheckEvidence} is sent: the verdict token and the bare
 * names of the allowlisted programs the report says it ran. Arguments, paths,
 * header values, output and the verdict's reasoning sentence stay local, so no
 * credential can be carried in any spelling.
 *
 * The call draws from the delegation's own deadline and its cancellation, so a
 * stalled endpoint cannot outlive the call that advertised a timeout.
 */
const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const JEV_MODEL = "typesafe/jev-1.13";
/** A hard cap on the advisory call, so it can never be the longest wait in a delegation. */
const JEV_TIMEOUT_MS = 30_000;

/** What the caller already spent, so the judge cannot outlive the call it serves. */
export interface JudgeBudget {
  /** What is left of the delegation's deadline. Absent means {@link JEV_TIMEOUT_MS} alone. */
  remainingMs?: number;
  /** The call's cancellation. */
  signal?: AbortSignal;
}

export async function judgeCheckVerdict(
  key: string,
  checkOutput: string,
  fetchImpl: typeof fetch = fetch,
  budget: JudgeBudget = {},
): Promise<JudgeOutcome> {
  if (key === "") return { ok: false, error: "no OpenRouter key is stored" };
  if (budget.signal?.aborted === true) {
    return { ok: false, error: "the call was cancelled, so the advisory judge was not asked" };
  }
  const budgetMs =
    budget.remainingMs === undefined ? JEV_TIMEOUT_MS : Math.min(budget.remainingMs, JEV_TIMEOUT_MS);
  if (budgetMs <= 0) {
    return { ok: false, error: "the call's deadline passed, so the advisory judge was not asked" };
  }
  const evidence = minimizeCheckEvidence(checkOutput);
  if (evidence === "") {
    return {
      ok: false,
      error:
        "the check named no program that can be sent safely (only an allowlisted program name and the pass/fail verdict are sent, never arguments, paths or output)",
    };
  }
  // One controller carries both bounds: the deadline timer and the caller's
  // cancellation. `fetch` is given only this signal, so an endpoint that hangs
  // is cut off by the same deadline the rest of the call runs on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const cancelled = () => controller.abort();
  budget.signal?.addEventListener("abort", cancelled, { once: true });
  const stopped = (): string =>
    budget.signal?.aborted === true
      ? "the call was cancelled while the advisory judge was waiting"
      : `OpenRouter did not answer within ${Math.round(budgetMs / 1000)}s`;
  try {
    let response: Response;
    try {
      response = await fetchImpl(JEV_DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: evidence,
          questions: {
            verified: {
              type: "noul",
              instructions:
                "Does this report show that the work it describes was actually run or checked, rather than only claimed?",
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) return { ok: false, error: `${stopped()}, so no opinion was produced` };
      return { ok: false, error: `OpenRouter could not be reached (${cause instanceof Error ? cause.message : String(cause)})` };
    }
    if (!response.ok) {
      return { ok: false, error: `OpenRouter refused the request (HTTP ${response.status})` };
    }
    let body: { answers?: { verified?: { noul?: unknown } } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      if (controller.signal.aborted) return { ok: false, error: `${stopped()}, so no opinion was produced` };
      return { ok: false, error: "OpenRouter's answer was not JSON" };
    }
    const probability = body.answers?.verified?.noul;
    if (typeof probability !== "number" || !Number.isFinite(probability)) {
      return { ok: false, error: "OpenRouter's answer carried no probability" };
    }
    const bounded = Math.min(1, Math.max(0, probability));
    return {
      ok: true,
      opinion: {
        agrees: bounded >= 0.5,
        rationale: `Jev put ${Math.round(bounded * 100)}% on the report showing the work was actually verified.`,
      },
    };
  } finally {
    clearTimeout(timer);
    budget.signal?.removeEventListener("abort", cancelled);
  }
}

/** A report line that carries content: not blank, and not a Markdown rule. */
function contentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !/^(?:[-*_=—]\s*){3,}$/.test(trimmed);
}

/**
 * The verdict a check unit ends with, read from the one `VERDICT: pass|fail`
 * line the checker itself stated, through the ordinary Markdown a report wraps
 * it in. `verdict: null` means fail closed, because acceptance and dependants
 * both read this result and silence must not read as a pass:
 *
 * - a `VERDICT:` line inside a block quote or a fence is the report the checker
 *   was handed, not the checker's own word;
 * - a report that states two verdicts, or both a pass and a fail, is ambiguous;
 * - the checker's verdict must be the last content line of its own text. The
 *   brief asks for exactly that, and a verdict with more report after it cannot
 *   be told apart from one the checker echoed from the worker's report.
 */
export function parseCheckVerdict(text: string): { verdict: ReviewVerdict | null; reasoning: string } {
  // Only the checker's own content lines, in order: the last one is where the
  // protocol puts the verdict, and the position is what makes that checkable.
  const content = unquotedReportLines(text)
    .filter(contentLine)
    .map((line) => parseVerdictLine(line));
  const stated: NonNullable<(typeof content)[number]>[] = [];
  for (const found of content) {
    if (found !== null) stated.push(found);
  }
  if (stated.length === 0) {
    return {
      verdict: null,
      reasoning:
        text.trim() === ""
          ? "the check produced no report, so it holds no verdict"
          : "the check left no line that reads `VERDICT: pass` or `VERDICT: fail`",
    };
  }
  const accepted = stated.some((found) => found.verdict === "accepted");
  const rejected = stated.some((found) => found.verdict === "rejected");
  if (accepted && rejected) {
    return {
      verdict: null,
      reasoning: "the check reported both a pass and a fail, so its result is ambiguous",
    };
  }
  if (stated.length > 1) {
    return {
      verdict: null,
      reasoning: "the check stated more than one verdict line, so which one it means is ambiguous",
    };
  }
  const only = stated[0]!;
  if (only !== content[content.length - 1]) {
    return {
      verdict: null,
      reasoning:
        "the check's verdict is not its final line, so it cannot be told apart from a verdict it quoted",
    };
  }
  return only;
}

/**
 * Whether a check result may be written for a unit. The checker that produced it
 * must still be the one the unit is bound to: a checker a newer attempt replaced
 * must not overwrite the newer failure with an old pass, and a write from a check
 * that never started (no checker) is only accepted while nothing is bound.
 */
export function checkWriteAllowed(
  boundChecker: string | null | undefined,
  checkerId: string | undefined,
): boolean {
  const bound =
    boundChecker === null || boundChecker === undefined || boundChecker === "" ? null : boundChecker;
  return checkerId === undefined ? bound === null : bound === checkerId;
}

export interface Delegation {
  threadId: string;
  title: string;
  task: string;
  createdAt: number;
  status: string | null;
  /** Set when the delegation asked for an independent check unit. */
  verifiedBy?: string | null;
  /**
   * The delegation this worker is the check unit for. A check unit is evidence,
   * not a unit of work: the orchestrator judges the unit, not its checker.
   */
  verifierFor?: string;
  /** The orchestrator's verdict, absent until `orchestrator_review` records one. */
  verdict?: ReviewVerdict | null;
  notes?: string | null;
  reviewedAt?: number | null;
  /** The error text when this worker failed, so the orchestrator sees why. */
  failure?: string | null;
  /**
   * The environment this worker ran in. It is what a check unit and a fallback
   * retry reuse, so both stay in the same checkout, and it names the worktree a
   * `worktree` delegation left behind.
   */
  environmentId?: string | null;
  /** The model, reasoning, tier and permission a worker was asked to run with. Null fields inherit the stored execution. */
  execution?: {
    providerId: string | null;
    model: string | null;
    reasoningLevel: string | null;
    serviceTier: string | null;
    permissionMode: string | null;
  } | null;
  /**
   * What the worker actually ran on, read back from BB rather than assumed. A
   * field BB does not report stays null and is named in `unreported`, so the UI
   * never presents a request as a fact.
   */
  resolved?: ResolvedExecution | null;
  /**
   * The unit asked for an independent check (`verify: true`) or the scope gave
   * it one. A rejected unit is revised on the same rule the check uses, so this
   * has to survive the spawn that recorded it.
   */
  verify?: boolean;
  /** The unit kind this delegation named, so a revision can keep it. */
  kind?: WorkerPresetName | null;
  /** The worker ids this unit waited for before it started. */
  after?: string[];
  /** This worker revises another unit, and which one. */
  revisionOf?: string | null;
  /**
   * The original unit this worker's revision chain belongs to. Every revision in
   * a chain names the same root, so the chain's spent budget and its outcome live
   * on one record whatever order the revisions came in.
   */
  revisionRoot?: string | null;
  /**
   * Revisions this chain has spent, kept on the chain's root; a revision also
   * carries the count it was written at, so a trimmed root still has a figure.
   */
  revisions?: number;
  /**
   * The revision that settled this chain: its own check passed, or the
   * orchestrator accepted it. A new attempt clears it. Kept on the root, so the
   * original's failed check is a fixed finding rather than a permanent refusal.
   */
  resolvedBy?: string | null;
  /**
   * When the resolution above was recorded, so a check that was already running
   * when it landed cannot take it back.
   */
  resolvedAt?: number | null;
  /** The independent check's parsed verdict and report, when one ran. */
  check?: {
    verdict: ReviewVerdict;
    detail: string;
    at: number;
    /** Why this record is fail-closed when the check left no verdict it can stand behind. */
    problem?: string | null;
  } | null;
  /** Timeline scans that found no progress and the resume messages sent. */
  stallResumes?: number;
  /**
   * Recovery checks this unit has spent. Each run is a whole worker, so the
   * count is durable and capped by {@link MAX_CHECK_ATTEMPTS}; a failed start
   * hands its attempt back because no worker ran.
   */
  checkAttempts?: number;
  /**
   * The check that owns this unit right now: the reservation taken before its
   * worker starts, then the checker's own id once that worker exists. Two calls
   * cannot both check one unit. `threadId` names the checker as soon as BB
   * spawns it, so an expired claim can be reconciled against the live thread
   * instead of silently handing a possibly running checker's work to a second
   * one; only a claim that never became a worker is released on expiry.
   */
  checkClaim?: { token: string; at: number; threadId?: string | null } | null;
}

/** What a worker resolved to when it actually started, and what BB could not tell us. */
export interface ResolvedExecution {
  providerId: string | null;
  model: string | null;
  /** `session` when the model came from the provider session snapshot, `thread` when only the provider was readable. */
  source: "thread" | "session";
  at: number;
  /** Fields BB exposes nowhere for a worker, so the request is all anyone can show. */
  unreported: string[];
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
  /** How much of `nudgeCount` the watchdog spent, and how much the review gate spent. */
  violationNudges: number;
  reviewNudges: number;
  lastNudgeTurnId: string | null;
  lastStopTurnId: string | null;
  delegations: Delegation[];
  /**
   * When the orchestrator's current turn started, as the dispatch hook saw it.
   * The per-turn fan-out cap counts delegations created since this moment.
   */
  turnStartedAt: number;
  /**
   * The set of workers the review gate last reminded about, so a turn that ends
   * with the same unjudged workers is not nagged twice.
   */
  lastReviewNudge: string | null;
  /**
   * The orchestrator this thread is a worker of, when this plugin spawned it.
   * A worker never runs the mode, so its subagent launches are watched through this link.
   */
  workerOf: string | null;
  /**
   * Records this thread has already lost to a per-thread cap, counted as they
   * were dropped. Durable storage keeps every thread, but these arrays are
   * working records with a ceiling, and a silent loss is what makes a status
   * line misleading.
   */
  lost?: {
    violations: number;
    delegations: number;
    seenRows: number;
  };
  /**
   * Set when the timeline head could not be read while enabling. The first
   * successful scan then seeds the cursor before judging anything, so a failed
   * read can never turn pre-enable history into violations.
   */
  headUnknown?: boolean;
}

const delegationSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  task: z.string(),
  createdAt: z.number(),
  status: z.string().nullable(),
  verifiedBy: z.string().nullable().optional(),
  verifierFor: z.string().optional(),
  verdict: z.enum(REVIEW_VERDICTS).nullable().optional(),
  notes: z.string().nullable().optional(),
  reviewedAt: z.number().nullable().optional(),
  failure: z.string().nullable().optional(),
  environmentId: z.string().nullable().optional(),
  execution: z
    .object({
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      reasoningLevel: z.string().nullable(),
      serviceTier: z.string().nullable(),
      permissionMode: z.string().nullable(),
    })
    .nullable()
    .optional(),
  resolved: z
    .object({
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      source: z.enum(["thread", "session"]),
      at: z.number(),
      unreported: z.array(z.string()),
    })
    .nullable()
    .optional(),
  verify: z.boolean().optional(),
  kind: z.enum(WORKER_PRESETS).nullable().optional(),
  after: z.array(z.string()).optional(),
  revisionOf: z.string().nullable().optional(),
  revisionRoot: z.string().nullable().optional(),
  revisions: z.number().optional(),
  resolvedBy: z.string().nullable().optional(),
  resolvedAt: z.number().nullable().optional(),
  check: z
    .object({
      verdict: z.enum(REVIEW_VERDICTS),
      detail: z.string(),
      at: z.number(),
      problem: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  stallResumes: z.number().optional(),
  checkAttempts: z.number().optional(),
  checkClaim: z
    .object({
      token: z.string(),
      at: z.number(),
      /** The checker thread this claim owns, once one exists. */
      threadId: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const violationSchema = z.object({
  id: z.string(),
  turnId: z.string().nullable(),
  workKind: z.string(),
  detail: z.string(),
  detectedAt: z.number(),
});

/**
 * The stored arrays are read by consumers that assume their declared element
 * shape (`violation.detail`, `delegation.status`), so a foreign value in the
 * store is dropped on the way out instead of crashing an RPC read or a scan.
 */
function sanitizeElements<T>(value: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The execution a delegation defaults to; an absent field inherits. */
const workerExecutionSchema = z.object({
  providerId: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(200).optional(),
  reasoningLevel: z.enum(REASONING_LEVELS).optional(),
  serviceTier: z.enum(SERVICE_TIERS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});

/** The stored configuration: the execution, the retry target, the presets. */
const workerConfigSchema = workerExecutionSchema.extend({
  fallback: workerExecutionSchema.optional(),
  presets: z
    .partialRecord(z.enum(WORKER_PRESETS), workerExecutionSchema)
    .optional(),
});

/** The enforcement union as a zod enum, shared by the state shape and the writes. */
const enforcementSchema = z.enum(
  ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]],
);

/** The `{ threadId }` input every per-thread RPC call takes. */
const threadIdSchema = z.object({ threadId: z.string().min(1).max(120) });

const stateSchema = z.object({
  enabled: z.boolean(),
  enforcement: enforcementSchema.nullable(),
  effectiveEnforcement: enforcementSchema,
  enabledAt: z.string().nullable(),
  violations: z.array(violationSchema),
  delegations: z.array(delegationSchema),
  nudgeCount: z.number(),
  violationNudges: z.number(),
  reviewNudges: z.number(),
  /** The plugin-wide default, so the new-thread composer can render it. */
  defaultForNewThreads: z.boolean(),
  allowReadCommands: z.boolean(),
  maxNudges: z.number(),
  /** The execution every delegation defaults to; absent fields inherit. */
  workerExecution: workerExecutionSchema,
  /** The fan-out caps in force, so a report can name them. */
  maxParallelWorkers: z.number(),
  maxDelegationsPerTurn: z.number(),
  /** Settled workers whose result nobody has judged yet. */
  unreviewed: z.number(),
  /** Delegations whose result the orchestrator accepted, as a ratio's numerator. */
  reviewed: z.number(),
  /** The worker ledger, counted from the same records the strip lists. */
  workers: z.object({
    total: z.number(),
    running: z.number(),
    settled: z.number(),
    accepted: z.number(),
    rejected: z.number(),
    /** Settled and still owed a verdict. */
    waiting: z.number(),
    /** Workers whose request BB could not confirm, so the UI says so. */
    unconfirmed: z.number(),
  }),
  /**
   * BB's own thread tree for this orchestrator, read live: direct children that
   * are not archived or deleted. This is the only honest answer to "how many
   * children are there now", so it is never derived from the ledger; when BB
   * cannot be read it says so instead of reporting a record count.
   */
  children: z.object({
    available: z.boolean(),
    total: z.number(),
    running: z.number(),
    error: z.string().nullable(),
  }),
  /**
   * Durable storage keeps every thread. These are the per-thread record caps and
   * how much this thread has already lost to them, so a report can be honest
   * about what is no longer there.
   */
  retention: z.object({
    threads: z.number(),
    caps: z.object({ delegations: z.number(), violations: z.number(), seenRows: z.number() }),
    lost: z.object({ delegations: z.number(), violations: z.number(), seenRows: z.number() }),
  }),
  /** Whether a judge key is stored and the advisory judge was opted into. */
  judge: z.object({ configured: z.boolean(), advisory: z.boolean() }),
});

/** A project id, as the scope RPCs take it. */
const projectIdSchema = z.object({ projectId: z.string().min(1).max(120) });

/** The settings keys a project may override; `defaultForNewThreads` is deliberately absent. */
const SETTINGS_KEYS = [
  "enforcement",
  "allowReadCommands",
  "maxNudges",
  "maxParallelWorkers",
  "maxDelegationsPerTurn",
  "contractPreset",
  "workerModelPolicy",
  "workerRetention",
  "workerWorkspace",
  "childMessageDelivery",
  "orchestratorSubagents",
  "workerSubagents",
  "maxRevisions",
  "maxStallResumes",
  "judgeAdvisory",
] as const;
const settingsKeySchema = z.enum(SETTINGS_KEYS);

/** The effective settings one project's threads run under. */
const settingsViewSchema = z.object({
  enforcement: enforcementSchema,
  allowReadCommands: z.boolean(),
  maxNudges: z.number(),
  maxParallelWorkers: z.number(),
  maxDelegationsPerTurn: z.number(),
  contractPreset: z.enum(CONTRACT_PRESETS),
  workerModelPolicy: z.enum(WORKER_MODEL_POLICIES),
  workerRetention: z.enum(WORKER_RETENTION),
  workerWorkspace: z.enum(WORKER_WORKSPACES),
  childMessageDelivery: z.enum(["queued", "immediate"]),
  orchestratorSubagents: z.enum(ORCHESTRATOR_SUBAGENT_POLICIES),
  workerSubagents: z.enum(WORKER_SUBAGENT_POLICIES),
  /** Revisions a rejected or failed-check build unit gets, per unit chain. */
  maxRevisions: z.number(),
  /** Resume messages a worker with no timeline progress may receive. */
  maxStallResumes: z.number(),
  /** Explicit opt-in for sending minimized check evidence to the advisory judge. */
  judgeAdvisory: z.boolean(),
});

export type SettingsViewDto = z.infer<typeof settingsViewSchema>;

/**
 * One scope's settings: the values in force there, the globals they resolve
 * over, and the fields a project overrides rather than inherits.
 */
const scopeSettingsSchema = z.object({
  values: settingsViewSchema,
  global: settingsViewSchema,
  overridden: z.array(z.string()),
});
export type ScopeSettingsDto = z.infer<typeof scopeSettingsSchema>;

/** The contract text, the project rules appended to it, and the room left. */
const contractSchema = z.object({ text: z.string(), extra: z.string(), limit: z.number() });
export type ContractDto = z.infer<typeof contractSchema>;

/** Whether the advisory judge has a key. The key itself is never part of any response. */
const judgeStatusSchema = z.object({ configured: z.boolean() }).strict();

/** The shape every RPC call returns; the schema above owns it. */
export type OrchestratorStateDto = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  get_state: {
    input: threadIdSchema.strict(),
    output: stateSchema,
  },
  set_enabled: {
    input: z
      .object({
        threadId: z.string().min(1).max(120),
        enabled: z.boolean(),
        enforcement: enforcementSchema.nullable().optional(),
      })
      .strict(),
    output: stateSchema,
  },
  get_default: { input: z.null(), output: z.object({ enabled: z.boolean() }) },
  set_default: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  get_contract: {
    input: z.object({ threadId: z.string().min(1).max(120).nullable() }).strict(),
    output: contractSchema,
  },
  set_contract: {
    input: z
      .object({ extra: z.string().max(EXTRA_INSTRUCTION_LIMIT) })
      .strict(),
    output: contractSchema,
  },
  get_judge: { input: z.null(), output: judgeStatusSchema },
  get_worker_execution: { input: z.null(), output: workerConfigSchema },
  set_worker_execution: {
    input: workerConfigSchema.nullable(),
    output: workerConfigSchema,
  },
  get_project_worker: {
    input: projectIdSchema.strict(),
    output: workerConfigSchema,
  },
  set_project_worker: {
    input: z.object({ projectId: z.string().min(1).max(120), config: workerConfigSchema.nullable() }).strict(),
    output: workerConfigSchema,
  },
  get_project_rules: {
    input: projectIdSchema.strict(),
    output: contractSchema,
  },
  set_project_rules: {
    input: z.object({ projectId: z.string().min(1).max(120), extra: z.string().max(EXTRA_INSTRUCTION_LIMIT) }).strict(),
    output: contractSchema,
  },
  get_scope_settings: {
    input: z.object({ projectId: z.string().min(1).max(120).nullable() }).strict(),
    output: scopeSettingsSchema,
  },
  set_scope_setting: {
    input: z
      .object({
        projectId: z.string().min(1).max(120).nullable(),
        key: settingsKeySchema,
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      })
      .strict(),
    output: scopeSettingsSchema,
  },
  clear_violations: {
    input: threadIdSchema.strict(),
    output: stateSchema,
  },
});

/**
 * Thrown when a delegation would exceed a fan-out cap. A distinct type because
 * the delegation tool retries a *provider* failure on the fallback, and a cap
 * is not a provider failure: retrying it would fail twice for no reason.
 */
class WorkerBudgetError extends Error {
  override readonly name = "WorkerBudgetError";
}

/** A timeline row, narrowed to the fields the classifier reads. */
interface ScanRow extends WorkRowLike {
  id: string;
  turnId?: string | null;
  sourceSeqEnd?: number;
  startedAt?: number;
  children?: unknown;
}

function asScanRows(rows: unknown): ScanRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ScanRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === null || typeof row !== "object") continue;
    const candidate = row as Omit<ScanRow, "id"> & { id?: unknown };
    // A delivered work row is judged even when the provider omitted its id:
    // dropping it would make the act invisible to a watchdog that exists to see
    // it. The sequence keys it stably, so a re-delivery in the next delta is
    // still deduped; only the id-less, sequence-less row falls back to position.
    const id =
      typeof candidate.id === "string"
        ? candidate.id
        : typeof candidate.sourceSeqEnd === "number"
          ? `seq:${candidate.sourceSeqEnd}`
          : `row:${index}`;
    out.push({ ...candidate, id });
    if (Array.isArray(candidate.children)) out.push(...asScanRows(candidate.children));
  }
  return out;
}

// --- settings --------------------------------------------------------------

/**
 * Every model the SDK's own picker would offer, with the provider that serves
 * it. Read from `bb.sdk.providers.models()`, the same source the new-thread
 * composer's provider and model pickers use, so a worker runs on something the
 * user can actually select there.
 *
 * Discovery runs after registration because unfiltered requests wait for the
 * provider-registration pass, which itself waits for all factories to return.
 * Failed reads preserve saved choices and retry without blocking activation.
 */
async function loadWorkerCatalog(bb: BbPluginApi, signal: AbortSignal): Promise<WorkerCatalog> {
  // The unfiltered response enumerates available providers; their models each
  // need a separate request. SDK failures may be returned as modelLoadError
  // rather than thrown, and must not turn into an authoritative empty catalog.
  signal.throwIfAborted();
  const system = await whileActive(bb.sdk.providers.models(), signal);
  if (system.modelLoadError) throw new Error(`Provider catalog: ${system.modelLoadError.code}`);
  const providers: string[] = [];
  const unavailable: string[] = [];
  const models: WorkerModelOption[] = [];
  for (const provider of system.providers) {
    if (!provider.available) continue;
    signal.throwIfAborted();
    // One provider that cannot list its models must not hold the whole catalog:
    // it is reported unavailable, and every other provider stays validated.
    const response = await whileActive(bb.sdk.providers.models({ providerId: provider.id }), signal).catch(
      (cause: unknown) => {
        if (signal.aborted) throw cause;
        return undefined;
      },
    );
    if (response === undefined || response.modelLoadError) {
      unavailable.push(provider.id);
      continue;
    }
    providers.push(provider.id);
    for (const model of response.models) {
      if (models.some((existing) => existing.id === model.id)) continue;
      models.push({ id: model.id, providerId: provider.id });
    }
  }
  return { providers, models, unavailable };
}

/** Stop consumers on service abort; observe late SDK results without using a
 * disposed plugin context. */
function whileActive<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    request.then(
      (value) => { cleanup(); if (signal.aborted) reject(signal.reason); else resolve(value); },
      (cause) => { cleanup(); reject(cause); },
    );
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * The provenance map `threads.spawn` reads for each execution field it gets:
 * `explicit` means the caller named the value, so the server must keep it.
 */
type WorkerExecutionSources = Partial<Record<keyof WorkerExecution, "explicit">>;

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
  /** Stop in-flight consumers before the plugin context becomes stale. */
  let disposed = false;
  let catalog: WorkerCatalog = { providers: [], models: [], unavailable: [] };
  let catalogReady = false;

  const judgeStore = judgeSecretStore(bb.server.experimental_dataDir);
  judgeStore.migrate();
  let judgeKeyPresent = judgeStore.read() !== null;

  /** The settings that shape thread behaviour, after a scope's values are validated. */
  interface SettingsView {
    enforcement: EnforcementLevel;
    allowReadCommands: boolean;
    maxNudges: number;
    maxParallelWorkers: number;
    maxDelegationsPerTurn: number;
    contractPreset: ContractPresetId;
    workerModelPolicy: WorkerModelPolicy;
    workerRetention: WorkerRetention;
    workerWorkspace: WorkerWorkspace;
    childMessageDelivery: "queued" | "immediate";
    /** Whether this scope's orchestrator may start provider subagents at all. */
    orchestratorSubagents: OrchestratorSubagentPolicy;
    /** Whether this scope's workers may start subagents of their own. */
    workerSubagents: WorkerSubagentPolicy;
    /** Revisions one unit chain may spend on a rejected or failed check. */
    maxRevisions: number;
    /** Resume messages one stalled worker may receive before it is reported as stuck. */
    maxStallResumes: number;
    /** Whether minimized check evidence may be sent to the advisory judge. */
    judgeAdvisory: boolean;
  }

  /** The global record: what every project inherits, plus the composer default. */
  interface OrchestratorSettings extends SettingsView {
    defaultForNewThreads: boolean;
  }

  /**
   * What a fresh install starts from, and the value every stored field falls back
   * to: a record missing a field, or carrying an unusable one, keeps the default
   * instead of blanking it.
   *
   * The parallel cap is eight, not six: a check unit counts against it, so a
   * `review-heavy` session needs two slots per unit and the default fits a batch
   * of four.
   */
  const DEFAULT_SETTINGS: OrchestratorSettings = {
    defaultForNewThreads: false,
    enforcement: DEFAULT_ENFORCEMENT,
    allowReadCommands: true,
    maxNudges: 3,
    maxParallelWorkers: 8,
    maxDelegationsPerTurn: 20,
    contractPreset: "standard",
    workerModelPolicy: "pinned",
    workerRetention: "keep",
    workerWorkspace: "shared",
    childMessageDelivery: "queued",
    orchestratorSubagents: "none",
    workerSubagents: "blocked",
    maxRevisions: 1,
    maxStallResumes: 1,
    judgeAdvisory: false,
  };

  /**
   * The stored global record. Not a BB settings descriptor: a descriptor has one
   * value per install and BB renders one form for it, while these resolve per
   * project, so the plugin owns the record and the settings section renders the
   * editor for whichever scope is selected.
   */
  let globalSettings: OrchestratorSettings = { ...DEFAULT_SETTINGS };

  /** In-memory mirror of the effective settings, for the sync configure path. */
  const live = {
    ...DEFAULT_SETTINGS,
    /**
     * When the default was last switched on. The dispatch hook only applies the
     * default to threads created at or after this moment, which is what keeps
     * "new threads" from meaning "every thread that happens to lack a mirror".
     */
    defaultEnabledAtMs: 0,
    /** Worker execution defaults; an absent field means "inherit". */
    worker: {} as WorkerConfig,
  };

  /**
   * The global record a stored value stands for. Every field is validated, so a
   * hand-edited record keeps the default of any field it gets wrong, and a key this
   * version no longer has is ignored.
   */
  function readGlobals(stored: unknown, base: SettingsView = DEFAULT_SETTINGS): OrchestratorSettings {
    const record = stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    return {
      ...sanitizedSettings(record, base),
      defaultForNewThreads: record.defaultForNewThreads === true,
    };
  }

  /** The global values in force, as the settings section reads them. */
  function globalsView(): SettingsView {
    // No field list to keep in step: everything `live` carries that is a setting
    // is one this view returns, and only the bookkeeping keys are dropped.
    const { defaultEnabledAtMs: _enabledAt, worker: _worker, ...settings } = live;
    return settings;
  }

  /**
   * Write the global record. Fields the caller names are validated against the
   * values in force, so one bad value keeps its current one; the rest keep the
   * stored value. This is the only global writer, so it is also where the
   * composer strip and the settings section are told the values moved.
   */
  async function writeSettings(patch: Partial<OrchestratorSettings>): Promise<void> {
    const next = readGlobals({ ...globalSettings, ...patch }, globalsView());
    globalSettings = next;
    await bb.storage.kv.set(GLOBAL_SETTINGS_KEY, next);
    applySettings(next);
    bb.log.info(`enforcement=${live.enforcement} default=${live.defaultForNewThreads}`);
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
  }

  /**
   * The worker execution this plugin configures, in the shape `threads.spawn`
   * takes and `buildInstructions` describes. Absent fields are omitted rather
   * than sent empty, so a thread spawned without them resolves the project's
   * remembered defaults exactly as it did before this fork.
   */
  function workerDefaults(): WorkerExecution {
    return executionOf(live.worker);
  }

  /**
   * A configuration's execution, without its fallback. `reconcile` and
   * `threads.spawn` must never see the `fallback` key: it is this plugin's own
   * bookkeeping, not a spawn field.
   */
  function executionOf(config: WorkerConfig): WorkerExecution {
    const { fallback: _fallback, presets: _presets, ...execution } = config;
    return execution;
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
    options: readonly string[] | undefined,
    setting: string,
  ): string | undefined {
    if (value === undefined || value === "") return undefined;
    if (catalogReady && options !== undefined && !options.includes(value)) {
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

  /** Put a validated global record into the mirror the synchronous paths read. */
  function applySettings(values: OrchestratorSettings): void {
    Object.assign(live, sanitizedSettings(values, DEFAULT_SETTINGS));
    live.defaultForNewThreads = values.defaultForNewThreads === true;
  }

  /**
   * One validator for the global settings and every project override: a field the
   * caller names and this module accepts replaces the base value, and anything
   * unusable leaves the base in place. `defaultForNewThreads` is absent on purpose —
   * it is a composer default, not thread behaviour, so it stays global.
   */
  function sanitizedSettings(
    values: Partial<OrchestratorSettings>,
    base: SettingsView,
  ): SettingsView {
    return {
      enforcement: isEnforcementLevel(values.enforcement) ? values.enforcement : base.enforcement,
      allowReadCommands: flagOf(values.allowReadCommands, base.allowReadCommands),
      maxNudges:
        values.maxNudges === undefined ? base.maxNudges : capOf(values.maxNudges, base.maxNudges),
      maxParallelWorkers:
        values.maxParallelWorkers === undefined
          ? base.maxParallelWorkers
          : capOf(values.maxParallelWorkers, base.maxParallelWorkers),
      maxDelegationsPerTurn:
        values.maxDelegationsPerTurn === undefined
          ? base.maxDelegationsPerTurn
          : capOf(values.maxDelegationsPerTurn, base.maxDelegationsPerTurn),
      contractPreset: isOneOf(CONTRACT_PRESETS, values.contractPreset)
        ? values.contractPreset
        : base.contractPreset,
      workerModelPolicy: isOneOf(WORKER_MODEL_POLICIES, values.workerModelPolicy)
        ? values.workerModelPolicy
        : base.workerModelPolicy,
      workerRetention: isOneOf(WORKER_RETENTION, values.workerRetention)
        ? values.workerRetention
        : base.workerRetention,
      workerWorkspace: isOneOf(WORKER_WORKSPACES, values.workerWorkspace)
        ? values.workerWorkspace
        : base.workerWorkspace,
      childMessageDelivery:
        values.childMessageDelivery === "queued" || values.childMessageDelivery === "immediate"
          ? values.childMessageDelivery
          : base.childMessageDelivery,
      orchestratorSubagents: isOneOf(ORCHESTRATOR_SUBAGENT_POLICIES, values.orchestratorSubagents)
        ? values.orchestratorSubagents
        : base.orchestratorSubagents,
      workerSubagents: isOneOf(WORKER_SUBAGENT_POLICIES, values.workerSubagents)
        ? values.workerSubagents
        : base.workerSubagents,
      maxRevisions:
        values.maxRevisions === undefined
          ? base.maxRevisions
          : Math.min(5, capOf(values.maxRevisions, base.maxRevisions)),
      maxStallResumes:
        values.maxStallResumes === undefined
          ? base.maxStallResumes
          : Math.min(5, capOf(values.maxStallResumes, base.maxStallResumes)),
      judgeAdvisory: flagOf(values.judgeAdvisory, base.judgeAdvisory),
    };
  }

  /**
   * A boolean setting from the RPC's own value union. The settings UI sends a
   * select's string (`"on"` and `"off"` are its labels), so both spellings are
   * accepted; a value that is neither keeps the base instead of silently
   * writing `false`, which is what made the consent switch a no-op.
   */
  function flagOf(value: unknown, base: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return base;
  }

  /** A fan-out cap: a non-negative whole number, or the fallback when unusable. */
  function capOf(value: unknown, fallback: number): number {
    const cap = Number(value);
    return Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : fallback;
  }

  /**
   * The stored worker configuration, with any id the live catalog no longer
   * lists dropped. The store is written by this plugin's own surfaces, so an
   * unknown id means a provider's models changed under a saved choice.
   */
  function storedWorkerConfig(stored: unknown): WorkerConfig {
    if (stored === null || typeof stored !== "object") return {};
    const record = stored as Record<string, unknown>;
    const execution = sanitizeExecution(record);
    const fallback =
      record.fallback === undefined || record.fallback === null
        ? undefined
        : sanitizeExecution(record.fallback as Record<string, unknown>);
    const presets: Partial<Record<WorkerPresetName, WorkerExecution>> = {};
    if (record.presets !== null && typeof record.presets === "object") {
      for (const [name, value] of Object.entries(record.presets as Record<string, unknown>)) {
        // A preset is a partial override, so it only loses the ids the catalog
        // no longer lists, and is dropped when nothing usable is left.
        if (!isOneOf(WORKER_PRESETS, name) || value === null || typeof value !== "object") continue;
        const sanitized = sanitizeExecution(value as Record<string, unknown>);
        if (Object.keys(sanitized).length > 0) presets[name] = sanitized;
      }
    }
    return {
      ...execution,
      // A model-only saved fallback may acquire its provider at discovery.
      // Only discard incomplete targets once the catalog is authoritative.
      ...(fallback === undefined || Object.keys(fallback).length === 0 ||
        catalogReady && (fallback.providerId === undefined || fallback.model === undefined)
        ? {}
        : { fallback }),
      ...(Object.keys(presets).length === 0 ? {} : { presets }),
    };
  }

  /** One level of the stored configuration, validated against the catalog. */
  function sanitizeExecution(record: Record<string, unknown>): WorkerExecution {
    const providerId = workerChoice(
      typeof record.providerId === "string" ? record.providerId : undefined,
      [...catalog.providers, ...catalog.unavailable],
      "worker provider",
    );
    const model = workerChoice(
      typeof record.model === "string" ? record.model : undefined,
      catalog.unavailable.length === 0 ? catalog.models.map((option) => option.id) : undefined,
      "worker model",
    );
    return reconcile({
      ...(providerId === undefined ? {} : { providerId }),
      ...(model === undefined ? {} : { model }),
      ...(isOneOf(REASONING_LEVELS, record.reasoningLevel)
        ? { reasoningLevel: record.reasoningLevel }
        : {}),
      ...(isOneOf(SERVICE_TIERS, record.serviceTier) ? { serviceTier: record.serviceTier } : {}),
      ...(isOneOf(PERMISSION_MODES, record.permissionMode)
        ? { permissionMode: record.permissionMode }
        : {}),
    });
  }

  /**
   * Refuse a worker the provider catalog cannot serve, naming the alternatives
   * so the agent can correct itself instead of handing back a broken worker.
   * Until discovery succeeds, preserve the existing fail-open behaviour. A
   * successful empty catalog is authoritative too, and refuses explicit ids.
   */
  function assertInCatalog(exec: WorkerExecution): void {
    // The provider first: it is the outer choice, and naming a model that exists
    // under a provider that does not is a confusing way to report a typo.
    if (
      exec.providerId !== undefined &&
      catalogReady &&
      !catalog.providers.includes(exec.providerId) &&
      !catalog.unavailable.includes(exec.providerId)
    ) {
      throw new Error(
        `Unknown worker provider "${exec.providerId}". Providers this machine offers: ${catalog.providers.join(", ")}. Omit provider to inherit the project default.`,
      );
    }
    if (exec.providerId !== undefined && catalog.unavailable.includes(exec.providerId)) {
      throw new Error(
        `Worker provider "${exec.providerId}" cannot list its models right now, so it cannot start a worker. Providers this machine offers: ${catalog.providers.join(", ")}.`,
      );
    }
    if (
      exec.model !== undefined &&
      catalogReady &&
      (exec.providerId === undefined
        ? catalog.unavailable.length === 0
        : catalog.providers.includes(exec.providerId)) &&
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
    live.defaultEnabledAtMs = enabled ? Date.now() : 0;
    await writeSettings({ defaultForNewThreads: enabled });
    await persistDefaultEnabledAt();
    return enabled;
  }

  /** Global executions need a complete pair; project overrides and presets may
   * inherit fields. Validate every configured id once discovery is available. */
  function validateWorkerConfig(next: WorkerConfig | null, requirePair: boolean): void {
    if (next !== null) {
      const execution = executionOf(next);
      if (Object.keys(execution).length > 0) {
        if (requirePair && (execution.providerId === undefined || execution.model === undefined)) {
          throw new Error("A worker execution needs both a provider and a model.");
        }
        assertInCatalog(execution);
      }
      if (next.fallback !== undefined) {
        if (requirePair && (next.fallback.providerId === undefined || next.fallback.model === undefined)) {
          throw new Error("A worker execution needs both a provider and a model.");
        }
        assertInCatalog(next.fallback);
      }
      // A preset is partial by design, so only the ids it does name must exist.
      for (const preset of Object.values(next.presets ?? {})) {
        assertInCatalog(preset);
      }
    }
  }

  async function setWorkerConfig(next: WorkerConfig | null): Promise<WorkerConfig> {
    validateWorkerConfig(next, true);
    const stored: WorkerConfig =
      next === null
        ? {}
        : {
            ...reconcile(executionOf(next)),
            ...(next.fallback === undefined ? {} : { fallback: reconcile(next.fallback) }),
            ...(next.presets === undefined
              ? {}
              : {
                  presets: Object.fromEntries(
                    Object.entries(next.presets).map(([name, preset]) => [
                      name,
                      reconcile(preset),
                    ]),
                  ),
                }),
          };
    await bb.storage.kv.set(WORKER_KEY, stored);
    // Discovery may have finished while this provisional write was in flight.
    live.worker = storedWorkerConfig(stored);
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return live.worker;
  }

  /**
   * The project rules the user appended. Held in memory as well as storage
   * because `bb.agents.configure` is synchronous and cannot await a read.
   */
  let extraInstructions = readExtra(await bb.storage.kv.get<unknown>(CONTRACT_KEY));

  /** The appended rules out of a stored record, or "" when there are none. */
  function readExtra(stored: unknown): string {
    if (stored === null || typeof stored !== "object") return "";
    const value = (stored as Record<string, unknown>).extra;
    return typeof value === "string" ? value : "";
  }

  /** Replace the appended rules. An empty string clears them. */
  async function setExtraInstructions(next: string): Promise<string> {
    const text = next.trim();
    if (text.length > EXTRA_INSTRUCTION_LIMIT) {
      throw new Error(
        `Project rules are capped at ${EXTRA_INSTRUCTION_LIMIT} characters so the contract stays inside the ${INSTRUCTION_LIMIT}-character limit; that text is ${text.length}.`,
      );
    }
    await bb.storage.kv.set(CONTRACT_KEY, { extra: text });
    extraInstructions = text;
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return text;
  }

  /**
   * Per-project overrides, held in memory beside the globals for the same reason:
   * `bb.agents.configure` is synchronous and cannot await a read. A project with no
   * record inherits every field, so an install that never scopes anything behaves
   * exactly as before.
   */
  const projectSettings: Record<string, Partial<OrchestratorSettings>> = {};
  const projectWorker: Record<string, WorkerConfig> = {};
  const projectRules: Record<string, string> = {};

  /** The settings one project's threads run under: its overrides over the globals. */
  function settingsFor(projectId: string | null | undefined): SettingsView {
    const override = projectId === null || projectId === undefined ? undefined : projectSettings[projectId];
    return override === undefined ? globalsView() : sanitizedSettings(override, globalsView());
  }

  /**
   * One scope's settings as the settings section reads them: the effective values,
   * the globals they resolve over, and the fields this scope overrides rather than
   * inherits. Global scope overrides nothing.
   */
  function scopeSettings(projectId: string | null): ScopeSettingsDto {
    return {
      values: settingsFor(projectId),
      global: globalsView(),
      overridden: projectId === null ? [] : Object.keys(projectSettings[projectId] ?? {}),
    };
  }

  /**
   * The worker configuration a project's delegations use. Merged per field, and per
   * kind for presets, so a project can change one thing without restating the rest.
   */
  function workerFor(projectId: string | null | undefined): WorkerConfig {
    const override = projectId === null || projectId === undefined ? undefined : projectWorker[projectId];
    if (override === undefined) return live.worker;
    const fallback = { ...live.worker.fallback, ...override.fallback };
    return {
      ...live.worker,
      ...override,
      ...(Object.keys(fallback).length === 0 ? {} : { fallback }),
      presets: { ...(live.worker.presets ?? {}), ...(override.presets ?? {}) },
    };
  }

  /** The appended project rules for one project, or the global ones when it has none. */
  function rulesFor(projectId: string | null | undefined): string {
    const stored = projectId === null || projectId === undefined ? undefined : projectRules[projectId];
    return stored ?? extraInstructions;
  }

  /** Store the settings overrides for one project. A field removed here inherits again. */
  async function writeProjectSettings(projectId: string, next: Partial<OrchestratorSettings>): Promise<SettingsView> {
    if (Object.keys(next).length === 0) delete projectSettings[projectId];
    else projectSettings[projectId] = next;
    await bb.storage.kv.set(PROJECT_SETTINGS_KEY, projectSettings);
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return settingsFor(projectId);
  }

  /** Store one project's worker configuration. Null hands it back to the global value. */
  async function writeProjectWorker(projectId: string, next: WorkerConfig | null): Promise<WorkerConfig> {
    validateWorkerConfig(next, false);
    if (next === null || Object.keys(next).length === 0) delete projectWorker[projectId];
    else
      projectWorker[projectId] = {
        ...reconcile(executionOf(next)),
        ...(next.fallback === undefined ? {} : { fallback: reconcile(next.fallback) }),
        ...(next.presets === undefined
          ? {}
          : {
              presets: Object.fromEntries(
                Object.entries(next.presets).map(([name, preset]) => [name, reconcile(preset)]),
              ),
            }),
      };
    await bb.storage.kv.set(PROJECT_WORKER_KEY, projectWorker);
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return workerFor(projectId);
  }

  /** Store one project's appended rules. An empty string hands it back to the global value. */
  async function writeProjectRules(projectId: string, next: string): Promise<string> {
    const text = next.trim();
    if (text.length > EXTRA_INSTRUCTION_LIMIT) {
      throw new Error(
        `Project rules are capped at ${EXTRA_INSTRUCTION_LIMIT} characters so the contract stays inside the ${INSTRUCTION_LIMIT}-character limit; that text is ${text.length}.`,
      );
    }
    if (text === "") delete projectRules[projectId];
    else projectRules[projectId] = text;
    await bb.storage.kv.set(PROJECT_RULES_KEY, projectRules);
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return text;
  }

  /** Load every project override once, before any thread can be governed by it. */
  async function loadProjectOverrides(): Promise<void> {
    const storedSettings = await bb.storage.kv.get<unknown>(PROJECT_SETTINGS_KEY);
    if (storedSettings !== null && typeof storedSettings === "object") {
      for (const [projectId, value] of Object.entries(storedSettings as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        projectSettings[projectId] = value as Partial<OrchestratorSettings>;
      }
    }
    const storedWorker = await bb.storage.kv.get<unknown>(PROJECT_WORKER_KEY);
    if (storedWorker !== null && typeof storedWorker === "object") {
      for (const [projectId, value] of Object.entries(storedWorker as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        projectWorker[projectId] = storedWorkerConfig(value);
      }
    }
    const storedRules = await bb.storage.kv.get<unknown>(PROJECT_RULES_KEY);
    if (storedRules !== null && typeof storedRules === "object") {
      for (const [projectId, value] of Object.entries(storedRules as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim() !== "") projectRules[projectId] = value;
      }
    }
  }

  /** The project a thread belongs to, or null when the thread cannot be read. */
  async function projectOfThread(threadId: string): Promise<string | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return typeof thread.projectId === "string" ? thread.projectId : null;
    } catch {
      return null;
    }
  }

  /**
   * The exact text `bb.agents.configure` injects for one thread. Pass a null
   * thread for the text a thread that has not run yet would receive. Exposed so
   * the contract can be read instead of guessed at.
   */
  async function contractText(threadId: string | null, projectId?: string | null): Promise<string> {
    const state = threadId === null ? undefined : await getState(threadId);
    const project = projectId === undefined && threadId !== null ? await projectOfThread(threadId) : projectId ?? null;
    const settings = settingsFor(project);
    const enforcement = effectiveEnforcement(state) ?? settings.enforcement;
    const reminders =
      state === undefined || state.violations.length === 0
        ? undefined
        : state.violations.slice(-5).map((violation) => violation.detail);
    return buildInstructions({
      enforcement: enforcement ?? settings.enforcement,
      allowReadCommands: settings.allowReadCommands,
      reminders,
      workerConfig: workerFor(project),
      extra: rulesFor(project),
      preset: settings.contractPreset,
      maxRevisions: settings.maxRevisions,
      modelPolicy: settings.workerModelPolicy,
      workspace: settings.workerWorkspace,
      subagents: settings.orchestratorSubagents,
    });
  }

  globalSettings = readGlobals(await bb.storage.kv.get<unknown>(GLOBAL_SETTINGS_KEY));
  applySettings(globalSettings);
  live.worker = storedWorkerConfig(await bb.storage.kv.get<unknown>(WORKER_KEY));
  await loadProjectOverrides();
  {
    const stored = await bb.storage.kv.get<{ enabledAtMs?: unknown }>(DEFAULT_KEY);
    const storedAt =
      stored !== undefined && typeof stored.enabledAtMs === "number" ? stored.enabledAtMs : null;
    if (live.defaultForNewThreads) {
      // A default switched on by an older build, or during a crash between the
      // settings write and this one, has no recorded moment: claim now, so only
      // threads created from here on are caught by it.
      live.defaultEnabledAtMs = storedAt ?? Date.now();
      if (storedAt === null) await persistDefaultEnabledAt();
    } else {
      live.defaultEnabledAtMs = 0;
    }
  }

  // --- state store ---------------------------------------------------------
  //
  // Authoritative per-thread state lives in this plugin's KV, which the thread's
  // own agent cannot write. Thread metadata carries a mirror of it only because
  // `bb.agents.configure` is synchronous and metadata is its only per-thread
  // input. The dispatch hook rewrites the mirror before every turn.

  let cache: Record<string, ThreadState> | null = null;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  /**
   * Per-thread state lives in this plugin's own SQLite database, not in a single
   * KV value. A KV row is capped at 256 KB and every thread shared it, so one
   * busy thread's history forced the least recently touched threads out of the
   * map — losing exactly the delegation and violation records the state exists
   * to keep. A row per thread has no shared budget: nothing is evicted, and the
   * existing KV map is imported once so the upgrade keeps every record it had.
   */
  const stateDb = bb.storage.database();
  bb.storage.migrate(stateDb, [
    `CREATE TABLE IF NOT EXISTS thread_state (
       thread_id TEXT PRIMARY KEY NOT NULL,
       touched_at INTEGER NOT NULL,
       state TEXT NOT NULL
     )`,
  ]);
  const readStateRows = stateDb.prepare<[], { thread_id: string; state: string }>(
    "SELECT thread_id, state FROM thread_state",
  );
  const writeStateRow = stateDb.prepare<[string, number, string]>(
    `INSERT INTO thread_state (thread_id, touched_at, state) VALUES (?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET touched_at = excluded.touched_at, state = excluded.state`,
  );
  const deleteStateRow = stateDb.prepare<[string]>("DELETE FROM thread_state WHERE thread_id = ?");
  const countStateRows = stateDb.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM thread_state");

  /**
   * How many threads durable state holds. A storage failure must not fail a read
   * that is only reporting a count, so an unreadable table answers 0.
   */
  function retainedThreadCount(): number {
    try {
      return countStateRows.get()?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Claims this process has made but not yet recorded. A cap check that counted
   * only the recorded delegations would let two simultaneous claims both pass,
   * so in-flight claims are counted too. `turn` tracks the ones that count
   * toward the per-turn cap, which excludes check units and retries.
   */
  const pendingClaims = new Map<string, { parallel: number; turn: number }>();

  function reserveClaim(threadId: string, countPerTurn: boolean): void {
    const counts = pendingClaims.get(threadId) ?? { parallel: 0, turn: 0 };
    pendingClaims.set(threadId, {
      parallel: counts.parallel + 1,
      turn: counts.turn + (countPerTurn ? 1 : 0),
    });
  }

  function releaseClaim(threadId: string, countPerTurn: boolean): void {
    const counts = pendingClaims.get(threadId) ?? { parallel: 0, turn: 0 };
    const next = {
      parallel: Math.max(0, counts.parallel - 1),
      turn: Math.max(0, counts.turn - (countPerTurn ? 1 : 0)),
    };
    if (next.parallel === 0 && next.turn === 0) pendingClaims.delete(threadId);
    else pendingClaims.set(threadId, next);
  }

  /**
   * Check units this process spawned whose ledger row never landed. The durable
   * check claim, not this reservation, is what stops a second check, so the
   * process-local slot must not outlive the failed write: one such write per
   * checker would otherwise spend a parallel slot for the life of the process and
   * refuse every later delegation on the thread. The checker is a real running
   * worker, though, so it keeps counting toward the cap until BB reports it
   * settled, which {@link pruneStrayCheckers} notices before the cap is read.
   */
  const strayCheckers = new Map<string, { ownerThreadId: string; countPerTurn: boolean }>();

  /**
   * Drop stray-checker entries that no longer hold a slot. A checker the ledger
   * now records is dropped because the ledger's own status counts it from then
   * on. One whose status BB cannot read is dropped too: it cannot be shown to be
   * running, its durable claim still stops a duplicate check, and keeping it
   * would recreate the leak this map exists to avoid. Reads happen only for this
   * orchestrator, and only when a cap is actually being counted.
   */
  async function pruneStrayCheckers(threadId: string, state: ThreadState): Promise<void> {
    for (const [checkerId, entry] of strayCheckers) {
      if (entry.ownerThreadId !== threadId) continue;
      if (state.delegations.some((delegation) => delegation.threadId === checkerId)) {
        strayCheckers.delete(checkerId);
        continue;
      }
      let status: string | null;
      try {
        status = (await bb.sdk.threads.get({ threadId: checkerId })).status ?? null;
      } catch {
        strayCheckers.delete(checkerId);
        continue;
      }
      if (!isRunningStatus(status)) strayCheckers.delete(checkerId);
    }
  }

  /**
   * Run `work` in the same queue as the state writes, so a check that reads the
   * state cannot interleave with another claim on the same thread. A failed
   * unit rejects its caller without wedging the queue.
   */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = mutationQueue.then(work, work);
    mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function readAll(): Promise<Record<string, ThreadState>> {
    if (cache !== null) return cache;
    // A corrupt or unreadable store must not throw out of a read: every caller
    // (the toggle, the dispatch hook, the watchdog, the contract builder) treats
    // "no row" as an ordinary state, so degrade to an empty map and log.
    const rows: Record<string, unknown> = {};
    try {
      for (const row of readStateRows.all()) {
        try {
          rows[row.thread_id] = JSON.parse(row.state) as unknown;
        } catch (cause) {
          bb.log.warn(`state row for ${row.thread_id} is not JSON; skipped: ${String(cause)}`);
        }
      }
    } catch (cause) {
      bb.log.warn(`state read failed; starting empty: ${String(cause)}`);
    }
    // One-time import of the single KV map this build used to write. It is kept
    // rather than deleted, so a rollback to the previous build still has its
    // records, and rows already in the table win over the older copy.
    let imported = 0;
    try {
      imported = await importLegacyState(rows);
    } catch (cause) {
      bb.log.warn(`legacy state import failed; continuing with the database rows: ${String(cause)}`);
    }
    if (imported > 0) bb.log.info(`imported ${imported} thread(s) from the legacy KV state map`);
    // Normalize here, not only in getState and mutateState: every reader shares this
    // cache, including the agent-configuration path, and a row written by an older
    // build must not reach a caller with a missing array.
    const loaded = Object.fromEntries(
      Object.entries(rows).map(([threadId, state]) => [
        threadId,
        // The store is untyped input: `normalize` is what turns a foreign shape
        // into the row this build expects.
        normalize(state as ThreadState | null | undefined),
      ]),
    );
    // A read already in flight can resolve after a write landed, with a snapshot
    // older than the cache. Adopting it would resurrect the pre-write map in
    // memory, and the next mutation would persist that stale map over the write.
    if (cache === null) cache = loaded;
    return cache;
  }

  /**
   * Copy rows out of the legacy KV map into the table, once. Returns how many
   * rows this call added: a populated table short-circuits, so the import runs
   * exactly once in the life of an upgrade.
   */
  async function importLegacyState(rows: Record<string, unknown>): Promise<number> {
    if (countStateRows.get()?.n !== 0) return 0;
    let legacy: Record<string, unknown> = {};
    try {
      const stored = await bb.storage.kv.get<unknown>(STATE_KEY);
      if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
        legacy = stored as Record<string, unknown>;
      } else if (stored !== undefined && stored !== null) {
        bb.log.warn(
          `legacy state is not an object (${Array.isArray(stored) ? "array" : typeof stored}); nothing imported`,
        );
      }
    } catch (cause) {
      bb.log.warn(`legacy state read failed; nothing imported: ${String(cause)}`);
    }
    const entries = Object.entries(legacy);
    if (entries.length === 0) return 0;
    stateDb.transaction(() => {
      for (const [threadId, state] of entries) {
        writeStateRow.run(threadId, Date.now(), JSON.stringify(state));
        rows[threadId] = state;
      }
    })();
    return entries.length;
  }

  /**
   * Fill in fields added after a state row was written, and tolerate a row that is
   * not the shape this build writes at all: a thread enabled by an older build, or
   * a foreign value in the store, must not crash a scan or an RPC read. That
   * covers the array *elements* too: a stored `violations: [null]` reaches
   * `violation.detail` in the contract and the RPC output, so a bad element is
   * dropped rather than passed on.
   */
  function normalize(state: ThreadState | null | undefined): ThreadState {
    if (state === null || state === undefined) return emptyState(Date.now());
    return {
      ...state,
      enabled: state.enabled === true,
      enforcement:
        state.enforcement === "instruct" || state.enforcement === "guard" || state.enforcement === "block"
          ? state.enforcement
          : null,
      enabledAt: typeof state.enabledAt === "string" ? state.enabledAt : null,
      violations: sanitizeElements(state.violations, violationSchema),
      seenRowIds: sanitizeElements(state.seenRowIds, z.string()),
      delegations: sanitizeElements(state.delegations, delegationSchema),
      graceTurnIds: sanitizeElements(state.graceTurnIds, z.string()),
      lastReviewNudge: typeof state.lastReviewNudge === "string" ? state.lastReviewNudge : null,
      touchedAt: typeof state.touchedAt === "number" && Number.isFinite(state.touchedAt) ? state.touchedAt : 0,
      turnStartedAt: typeof state.turnStartedAt === "number" ? state.turnStartedAt : 0,
      graceSlots: typeof state.graceSlots === "number" ? state.graceSlots : 1,
      lastSeq: typeof state.lastSeq === "number" ? state.lastSeq : 0,
      nudgeCount: typeof state.nudgeCount === "number" ? state.nudgeCount : 0,
      violationNudges: typeof state.violationNudges === "number" ? state.violationNudges : 0,
      reviewNudges: typeof state.reviewNudges === "number" ? state.reviewNudges : 0,
      workerOf: typeof state.workerOf === "string" ? state.workerOf : null,
      lost: {
        violations: countOf(state.lost?.violations),
        delegations: countOf(state.lost?.delegations),
        seenRows: countOf(state.lost?.seenRows),
      },
      headUnknown: state.headUnknown === true,
    };
  }

  /** A stored counter: a non-negative integer, or 0. */
  function countOf(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  async function judgeKeyConfigured(): Promise<boolean> {
    judgeKeyPresent = judgeStore.read() !== null;
    return judgeKeyPresent;
  }

  async function judgeKey(): Promise<string | null> {
    return judgeStore.read();
  }

  /**
   * Write the rows this mutation changed. The map is the cache, not the storage
   * format: each thread is one table row, so no write can crowd out another
   * thread, and no record is ever evicted to make room.
   */
  async function persist(next: Record<string, ThreadState>): Promise<void> {
    const previous = cache ?? {};
    stateDb.transaction(() => {
      for (const [threadId, state] of Object.entries(next)) {
        if (previous[threadId] === state) continue;
        writeStateRow.run(threadId, state.touchedAt, JSON.stringify(state));
      }
      for (const threadId of Object.keys(previous)) {
        if (next[threadId] === undefined) deleteStateRow.run(threadId);
      }
    })();
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
      violationNudges: 0,
      reviewNudges: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
      delegations: [],
      turnStartedAt: 0,
      lastReviewNudge: null,
      workerOf: null,
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
    return enqueue(async () => {
      const all = { ...(await readAll()) };
      const current = normalize(all[threadId] ?? emptyState(Date.now()));
      const next = update(current);
      if (next === null) {
        if (all[threadId] === undefined) return undefined;
        delete all[threadId];
        await persist(all);
        return undefined;
      }
      next.touchedAt = Date.now();
      setRow(all, threadId, next);
      await persist(all);
      return next;
    });
  }

  function clearViolations(threadId: string): Promise<ThreadState | undefined> {
    return mutateState(threadId, (current) => ({
      ...current,
      violations: [],
      nudgeCount: 0,
      violationNudges: 0,
      reviewNudges: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
      // The review reminder is a correction counter too. Leaving its marker here
      // would mute the gate for the same workers while the cap said there were
      // reminders left to spend.
      lastReviewNudge: null,
    }));
  }

  /**
   * Store a row as an own data property. A plain `map[threadId] = row` treats
   * the key `__proto__` as the object's prototype setter instead, so that row
   * would disappear from `Object.keys`/`JSON.stringify` and the map would start
   * inheriting the row's fields. A hostile or stale store can carry such a key.
   */
  function setRow(map: Record<string, ThreadState>, threadId: string, state: ThreadState): void {
    Object.defineProperty(map, threadId, {
      value: state,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  function effectiveEnforcement(
    state: ThreadState | undefined,
    settings: SettingsView = settingsFor(null),
  ): EnforcementLevel {
    return state?.enforcement ?? settings.enforcement;
  }

  function toDto(
    threadId: string,
    state: ThreadState | undefined,
    children: ChildCounts,
    settings: SettingsView = settingsFor(null),
    retainedThreads = 0,
  ): OrchestratorStateDto {
    const base = state ?? emptyState(Date.now());
    const delegations = trimDelegations(base.delegations);
    const settled = delegations.filter((delegation) => isSettledStatus(delegation.status));
    return {
      enabled: state?.enabled ?? false,
      enforcement: base.enforcement,
      effectiveEnforcement: effectiveEnforcement(state, settings),
      enabledAt: base.enabledAt,
      violations: base.violations.slice(-MAX_VIOLATIONS),
      delegations: trimDelegations(base.delegations),
      nudgeCount: base.nudgeCount,
      violationNudges: base.violationNudges,
      reviewNudges: base.reviewNudges,
      defaultForNewThreads: live.defaultForNewThreads,
      allowReadCommands: settings.allowReadCommands,
      maxNudges: settings.maxNudges,
      workerExecution: workerDefaults(),
      maxParallelWorkers: settings.maxParallelWorkers,
      maxDelegationsPerTurn: settings.maxDelegationsPerTurn,
      unreviewed: unreviewedOf(base.delegations).length,
      reviewed: base.delegations.filter((delegation) => delegation.verdict != null).length,
      workers: {
        total: delegations.length,
        running: delegations.filter((delegation) => isRunningStatus(delegation.status)).length,
        settled: settled.length,
        accepted: delegations.filter((delegation) => delegation.verdict === "accepted").length,
        rejected: delegations.filter((delegation) => delegation.verdict === "rejected").length,
        waiting: settled.filter((delegation) => needsVerdict(delegation)).length,
        unconfirmed: delegations.filter((delegation) => delegation.resolved == null).length,
      },
      children,
      retention: {
        threads: retainedThreads,
        caps: { delegations: MAX_DELEGATIONS, violations: MAX_VIOLATIONS, seenRows: MAX_SEEN_ROWS },
        lost: {
          delegations: base.lost?.delegations ?? 0,
          violations: base.lost?.violations ?? 0,
          seenRows: base.lost?.seenRows ?? 0,
        },
      },
      judge: { configured: judgeKeyPresent, advisory: settings.judgeAdvisory },
    };
  }

  /** Statuses in which a worker has finished, one way or the other. */
  function isSettledStatus(status: string | null): boolean {
    return status === "idle" || status === "error";
  }

  /** Statuses in which a worker is still consuming a parallel slot. */
  function isRunningStatus(status: string | null): boolean {
    return status === null || status === "active" || status === "starting" || status === "pending" || status === "stopping";
  }

  /**
   * Settled, unjudged, and not a check unit: a delegation the orchestrator still
   * owes a verdict. A worker still running is not owed one yet, so a review
   * reminder cannot arrive before there is anything to review.
   */
  function needsVerdict(delegation: Delegation): boolean {
    return (
      isSettledStatus(delegation.status) &&
      delegation.verdict == null &&
      // A check unit is evidence for the unit it checks: judging the checker
      // as well would double the ceremony without adding a decision.
      delegation.verifierFor === undefined
    );
  }

  /**
   * Keep the newest records plus every worker still owed a verdict: dropping an
   * unjudged record would refuse its verdict later and hide it from the counts.
   */
  function trimDelegations(delegations: readonly Delegation[]): Delegation[] {
    if (delegations.length <= MAX_DELEGATIONS) return [...delegations];
    const recent = delegations.slice(-MAX_DELEGATIONS);
    const kept = new Set(recent.map((delegation) => delegation.threadId));
    const owed = delegations.filter((delegation) => !kept.has(delegation.threadId) && needsVerdict(delegation));
    // The newest owed records are the ones a verdict is still plausible for; the
    // oldest fall away once the cap is reached, and the drop is named rather than
    // silent, the way a pruned thread is.
    const retained = owed.slice(-MAX_UNJUDGED_RETAINED);
    if (retained.length < owed.length) {
      bb.log.warn(
        `delegation records over cap: dropped ${owed.length - retained.length} oldest verdict-owed record(s)`,
      );
    }
    return [...retained, ...recent];
  }

  function unreviewedOf(delegations: readonly Delegation[]): Delegation[] {
    return delegations.filter(needsVerdict);
  }

  /**
   * One row's dedupe key. A later turn may reuse a row id, and a row id may
   * itself contain `:`, so neither the bare id nor `id:seq` is unique per
   * `(id, seq)`: `id:"a:1"` at seq 0 would collide with `id:"a"` at seq 1 and
   * hide the later row. The id's length in front makes the key unambiguous
   * whatever characters the id holds.
   */
  function seenKey(row: ScanRow): string {
    const seq = typeof row.sourceSeqEnd === "number" ? row.sourceSeqEnd : 0;
    return `${row.id.length}:${row.id}:${seq}`;
  }

  /** Read the thread's current timeline head so a scan starts after it. */
  async function timelineHead(
    threadId: string,
  ): Promise<{ seq: number; turnId: string | null; ok: boolean }> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId });
      const response = timeline as { maxSeq?: unknown; rows?: unknown };
      const seq =
        typeof response.maxSeq === "number" && Number.isFinite(response.maxSeq)
          ? response.maxSeq
          : 0;
      const rows = asScanRows(response.rows);
      return {
        seq,
        turnId: rows.length === 0 ? null : (rows[rows.length - 1]!.turnId ?? null),
        ok: true,
      };
    } catch (cause) {
      // A head this build could not read says nothing about where the history
      // ends. Reporting `ok: false` lets the enable path defer the cursor instead
      // of starting at 0, which would judge the whole thread as fresh work.
      bb.log.warn(`timeline head read failed for ${threadId}: ${String(cause)}`);
      return { seq: 0, turnId: null, ok: false };
    }
  }

  async function setEnabled(
    threadId: string,
    enabled: boolean,
    enforcement: EnforcementLevel | null,
  ): Promise<ThreadState> {
    // Seeding the sequence head when turning on means historical work in an
    // existing thread is never retroactively flagged.
    const head = enabled
      ? await timelineHead(threadId)
      : { seq: 0, turnId: null, ok: true };
    // A thread with a turn in flight loses that turn AND the next one to the
    // session lag; an idle thread loses only the next one.
    let graceTurnIds: string[] = [];
    let graceSlots = 1;
    let active = false;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      active = thread.status === "active";
      if (enabled && active && head.turnId !== null) {
        graceTurnIds = [head.turnId];
        graceSlots = 2;
      }
    } catch (cause) {
      bb.log.warn(`thread status read failed for ${threadId}: ${String(cause)}`);
    }
    const state = await mutateState(threadId, (current) => ({
      ...current,
      enabled,
      enforcement,
      enabledAt: enabled ? (current.enabledAt ?? new Date().toISOString()) : null,
      lastSeq: enabled ? head.seq : current.lastSeq,
      // With no readable head, the first successful scan seeds the cursor before
      // it judges anything (see `scan`), so nothing from before this point counts.
      headUnknown: enabled ? !head.ok : false,
      graceTurnIds: enabled ? graceTurnIds : current.graceTurnIds,
      graceSlots: enabled ? graceSlots : current.graceSlots,
      nudgeCount: enabled ? current.nudgeCount : 0,
      violationNudges: enabled ? current.violationNudges : 0,
      reviewNudges: enabled ? current.reviewNudges : 0,
      lastNudgeTurnId: enabled ? current.lastNudgeTurnId : null,
      lastStopTurnId: enabled ? current.lastStopTurnId : null,
      lastReviewNudge: enabled ? current.lastReviewNudge : null,
    }));
    await syncMirror(threadId, state?.enabled ?? false, state?.enforcement ?? null);
    if (active) {
      try {
        const text = enabled
          ? await contractText(threadId)
          : "Orchestrator mode is now off. The earlier orchestrator contract no longer applies; continue following the user's request.";
        await bb.sdk.threads.send({
          threadId,
          mode: "steer",
          input: [{ type: "text", mentions: [], text }],
        });
      } catch (cause) {
        bb.log.warn(`mode notification failed for ${threadId}: ${String(cause)}`);
      }
    }
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

  const delegateParameters = z.object({
    task: z
      .string()
      .min(1)
      .max(20_000)
      .describe("Complete, self-contained brief for the worker."),
    title: z.string().max(200).optional().describe("Worker thread title."),
    providerId: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("Alias for provider: pin this registered provider before the worker starts. If both are supplied, they must match."),
    waitForResult: z
      .boolean()
      .optional()
      .describe(
        "Wait for the worker to finish and return its result. Default true. `false` returns once the unit is spawned, so independent units fan out; its check then waits for `orchestrator_check`. A cancelled call starts no worker.",
      ),
    after: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .optional()
      .describe(
        "Worker thread ids this unit depends on. It starts only once each dependency has settled cleanly: idle, not errored, and not rejected by its own check or review. Only this orchestrator's own workers are accepted, and a dependency cycle is refused.",
      ),
    timeoutSeconds: z
      .number()
      .int()
      .min(10)
      .max(3600)
      .optional()
      .describe(
        "Total time for this call, including its check unit and any revision. Default 900.",
      ),
    hidden: z
      .boolean()
      .optional()
      .describe("Keep the worker out of the sidebar. Default false."),
    workspace: z
      .enum(WORKER_WORKSPACES)
      .optional()
      .describe(
        "Where this unit runs: `shared` (the orchestrator's own checkout) or `worktree` (its own git worktree and branch, which stays out until a merge unit brings it in). Default: the plugin setting. Under `mixed`, the unit's `kind` picks the checkout and `workspace` overrides it.",
      ),
    kind: z
      .enum(WORKER_PRESETS)
      .optional()
      .describe(
        "What kind of unit this is: `build`, `review` or `research`. A kind picks where the unit runs under a `mixed` workspace (a build gets its own worktree; a review or research unit reads this checkout), decides whether it gets an independent check (a build does), and applies that kind's stored execution when one exists. It needs no stored preset.",
      ),
    preset: z
      .enum(WORKER_PRESETS)
      .optional()
      .describe(
        "A named execution preset stored in the plugin settings. Under the default `pinned` it is the only way to give this unit a raw model change, because `model`, `provider` and `reasoning` are refused; under `flexible` this call's own arguments apply on top of it. A `kind` already applies its stored execution for you, so a preset is only needed to force one that is stored.",
      ),
    verify: z
      .boolean()
      .optional()
      .describe(
        "Also spawn an independent check unit on the same brief, told to run what the unit claims and report its raw output before a pass or fail verdict. Use it for a unit whose result you cannot judge from its report alone. Default false, except under a review-heavy scope, which checks every unit.",
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Model id for this worker, taken from the provider catalog (`bb provider models <provider>`). Defaults to the plugin's worker model, then the project's remembered model.",
      ),
    provider: z
      .string()
      .trim()
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
  });

  async function delegateTask(
    {
      task,
      title,
      waitForResult,
      after,
      timeoutSeconds,
      hidden,
      workspace,
      kind,
      preset,
      verify,
      model,
      provider,
      providerId,
      reasoning,
      permissionMode,
    }: z.infer<typeof delegateParameters>,
    { threadId, projectId: contextProjectId, signal }: PluginCliContext,
  ): Promise<string> {
    if (threadId === undefined) {
      throw new Error("orchestrator_delegate needs a thread context.");
    }
    const parent = await bb.sdk.threads.get({ threadId });
    const projectId = contextProjectId ?? parent.projectId;
    /**
     * One deadline for the whole call. The worker, its check unit and every
     * revision share it, so `timeoutSeconds` bounds the call rather than each
     * wait inside it.
     */
    const timeoutMs = Math.min(Math.max(timeoutSeconds ?? 900, 10), 3600) * 1000;
    const deadlineMs = Date.now() + timeoutMs;
    const remainingMs = (): number => Math.max(0, deadlineMs - Date.now());
    /**
     * Whether this call may start another worker. Read as a function so a check
     * after an await sees the current state instead of a narrowed earlier one.
     */
    const cancelled = (): boolean => disposed || signal?.aborted === true;
    /**
     * A dependent unit starts only after each named input has finished
     * cleanly. Failed, rejected or unchecked-as-failing inputs stop this unit
     * too: starting on a broken input would hand the worker a result it cannot
     * trust. The graph is the recorded one, so a cycle is refused instead of
     * waiting forever.
     */
    if (after !== undefined && after.length > 0) {
      const recorded = (await getState(threadId))?.delegations ?? [];
      const known = new Map(recorded.map((delegation) => [delegation.threadId, delegation]));
      const foreign = after.filter((id) => !known.has(id));
      if (foreign.length > 0) {
        throw new Error(`These are not this orchestrator's workers, so they cannot be dependencies: ${foreign.join(", ")}`);
      }
      const repeated = after.filter((id, index) => after.indexOf(id) !== index);
      if (repeated.length > 0) {
        throw new Error(`Name each dependency once: ${[...new Set(repeated)].join(", ")} is listed more than once.`);
      }
      const cycle = findDependencyCycle(recorded, after);
      if (cycle !== null) {
        throw new Error(
          `These dependencies form a cycle (${cycle.join(" -> ")}), so this unit would wait on itself. Break the chain and delegate the units in order instead.`,
        );
      }
      for (const id of after) {
        const settledDependency = await waitForWorker(id, remainingMs(), {
          ownerThreadId: threadId,
          maxResumes: settingsFor(projectId).maxStallResumes,
          ...(signal === undefined ? {} : { signal }),
        });
        if (settledDependency.status !== "idle") {
          const dependency = (await getState(threadId))?.delegations.find((entry) => entry.threadId === id) ?? known.get(id);
          const why =
            dependency?.failure ??
            (settledDependency.running
              ? `it was still ${settledDependency.status ?? "running"} when the deadline passed`
              : `status ${settledDependency.status ?? "unknown"}`);
          throw new Error(`Dependency ${id} did not finish cleanly (${why}), so this unit did not start.`);
        }
        const currentDelegations = (await getState(threadId))?.delegations ?? recorded;
        const dependency = currentDelegations.find((entry) => entry.threadId === id) ?? known.get(id);
        if (dependency === undefined) continue;
        // A chain a later revision resolved is fixed work, so its original's
        // failure no longer stops a dependent unit.
        const resolved = resolvedByOf(dependency, currentDelegations) !== null;
        if (dependency.verdict === "rejected" && !resolved) {
          throw new Error(
            `Dependency ${id} was rejected${dependency.notes === null || dependency.notes === undefined ? "" : ` (${dependency.notes})`}, so this unit did not start on it. Re-delegate that unit first.`,
          );
        }
        const blocked = checkBlockReason(dependency, currentDelegations);
        if (blocked !== null) {
          throw new Error(
            `Dependency ${id} cannot be used because ${blocked}, so this unit did not start on it. Re-delegate that unit with the check's findings first.`,
          );
        }
      }
    }
    // A check unit inspects finished work, so it can only start once the
    // worker has settled. Refusing beats spawning a worker nobody checks.
    if (verify === true && waitForResult === false) {
      throw new Error(
        "verify: true needs waitForResult: true, because a check unit has to inspect finished work. Wait for this worker, or record a verdict yourself and delegate the check as its own unit.",
      );
    }
    /**
     * Where this unit runs. The call always wins; `mixed` has no default of its
     * own, so under it every delegation has to say, which is the whole point of
     * the mode: the orchestrator decides per unit.
     */
    // A review-heavy scope checks every unit, so the check is the scope's rule, not an option the orchestrator can skip.
    const reviewHeavy = settingsFor(projectId).contractPreset === "review-heavy";
    if (reviewHeavy && verify === false) {
      throw new Error("This scope is review-heavy, so every unit gets an independent check. Leave verify unset.");
    }
    if (reviewHeavy && waitForResult === false) {
      throw new Error("This scope is review-heavy, so every unit is checked once it finishes. Keep waitForResult true.");
    }
    /**
     * The unit kind. `preset` is the older spelling of the same thing: it names
     * a kind and, when one is stored, that kind's execution. A kind is a
     * property of the work, not of a stored execution, so it needs no preset to
     * pick a checkout or a check.
     */
    if (kind !== undefined && preset !== undefined && kind !== preset) {
      throw new Error(
        `kind \`${kind}\` and preset \`${preset}\` name different unit kinds; pass one, or make them match.`,
      );
    }
    const unitKind: WorkerPresetName | undefined = kind ?? preset;
    const scopeWorkspace = settingsFor(projectId).workerWorkspace;
    // In a mixed scope the kind picks its own checkout: a build writes its own
    // branch, while a review or research unit only reads the orchestrator's own
    // checkout. A unit with no workspace and no kind still has to name one.
    const kindWorkspace = unitKind === undefined ? undefined : KIND_WORKSPACES[unitKind];
    if (workspace === undefined && scopeWorkspace === "mixed" && kindWorkspace === undefined) {
      throw new Error(
        "This scope runs workers in both checkouts, so each delegation names where it runs: `workspace: \"shared\"` uses the orchestrator's own checkout, so its edits are visible at once, and `workspace: \"worktree\"` gives the unit its own branch, which stays out until a merge unit brings it in. Or pass a `kind` (build, review or research) and the workspace follows it.",
      );
    }
    const unitWorkspace = workspace ?? (scopeWorkspace === "mixed" ? kindWorkspace : scopeWorkspace);
    // A build unit is checked by default: the review loop is on for every kind
    // that changes files. A check needs the result, so a unit that does not wait
    // is left unchecked rather than refused.
    const checkUnit =
      verify === true ||
      reviewHeavy ||
      (unitKind !== undefined && KIND_CHECKS[unitKind] && verify !== false && waitForResult !== false);
    /**
     * The machine a new worktree belongs on: the orchestrator's own, so the unit
     * sees the same host as the thread that handed it the work. An environment
     * that cannot be read leaves it unset, which asks BB for this machine.
     */
    let parentHostId: string | undefined;
    if (unitWorkspace === "worktree" && parent.environmentId !== null) {
      try {
        parentHostId = (await bb.sdk.environments.get({ environmentId: parent.environmentId })).hostId;
      } catch {
        parentHostId = undefined;
      }
    }
    /**
     * The checkout one unit runs in. Without a worktree it is the orchestrator's
     * own; with one, BB creates a managed worktree off the project's default
     * branch on the machine the orchestrator runs on. A check unit or a retry
     * passes the environment its unit was spawned into, so it inspects and
     * continues the same working tree instead of opening a second one.
     */
    function environmentFor(reuseId: string | null | undefined) {
      if (reuseId !== null && reuseId !== undefined) {
        return { type: "reuse" as const, environmentId: reuseId };
      }
      if (unitWorkspace !== "worktree") {
        return parent.environmentId === null
          ? { type: "project-default" as const }
          : { type: "reuse" as const, environmentId: parent.environmentId };
      }
      return {
        type: "host" as const,
        ...(parentHostId === undefined ? {} : { hostId: parentHostId }),
        workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } },
      };
    }
    /**
     * The worker's title, carrying the preset it runs under: the sidebar is the
     * only place a delegation is visible, and `BUILD: …` says what the thread is
     * doing before the brief does. A title that already names the preset is left
     * alone, so the prefix is never doubled.
     */
    const baseTitle = title?.trim() || task.trim().split("\n")[0]!.slice(0, 120);
    const presetPrefix = unitKind === undefined ? null : `${unitKind.toUpperCase()}:`;
    const workerTitle =
      presetPrefix === null || baseTitle.toUpperCase().startsWith(presetPrefix)
        ? baseTitle
        : `${presetPrefix} ${baseTitle}`;
    const orchestratorId = threadId;
    const targetProjectId = projectId;

    // The mode has to be on: a stale session can keep this tool after the
    // thread was switched off, and the review gate does not monitor a thread
    // that is off, so those workers would never be nudged for a verdict.
    const orchestratorState = await getState(orchestratorId);
    if (orchestratorState?.enabled !== true) {
      throw new Error(
        "This thread is not in orchestrator mode, so delegations are refused. Turn the mode on in the composer first.",
      );
    }

    // A named preset must be stored: silently ignoring one would leave the
    // orchestrator believing it had asked for a different model. The project's
    // worker configuration is the one that applies, global values under it.
    const workerConfig = workerFor(projectId);
    const pinnedProvider = provider ?? providerId;
    // A pinned scope runs every worker on the stored execution, or on a stored
    // kind it names: refusing here beats spawning a worker on a model the scope
    // ruled out, and both the tool and the CLI delegate command route through
    // this handler.
    if (settingsFor(projectId).workerModelPolicy === "pinned") {
      // Field names come from the shared list, so the refusal cannot drift from
      // the contract prose that promises it. The provider alias reports the
      // spelling the caller actually passed: naming `provider` on a
      // `providerId`-only call sends the orchestrator to the wrong argument.
      const passedArgs = { model, provider: provider ?? providerId, reasoning };
      const asked = PINNED_DELEGATION_FIELDS
        .filter((field) => passedArgs[field] !== undefined)
        .map((field) => `\`${field === "provider" && provider === undefined ? "providerId" : field}\``);
      if (asked.length > 0) {
        throw new Error(
          `This scope's worker model policy is \`pinned\`, so ${asked.join(", ")} cannot be set on a delegation. Workers run on the stored execution, or on a stored kind named as \`preset\`. Ask the user to switch the model policy to \`flexible\` to let a unit choose its own.`,
        );
      }
    }
    let presetExec: WorkerExecution = {};
    if (preset !== undefined) {
      const stored = workerConfig.presets?.[preset];
      if (stored === undefined) {
        const available = Object.keys(workerConfig.presets ?? {});
        throw new Error(
          `No \`${preset}\` worker preset is stored.${available.length === 0 ? " This plugin has no presets configured." : ` Stored presets: ${available.join(", ")}.`}`,
        );
      }
      presetExec = stored;
    } else if (unitKind !== undefined) {
      // A kind is not a stored preset: its execution applies when the scope has
      // saved one, and otherwise the unit simply runs on the default execution.
      presetExec = workerConfig.presets?.[unitKind] ?? {};
    }

    // Per-delegation arguments win over a preset, which wins over the worker
    // settings; a field none of them names is left out so the worker resolves
    // the project default.
    if (provider !== undefined && providerId !== undefined && provider !== providerId) {
      throw new Error("provider and providerId must match when both are supplied.");
    }
    assertInCatalog({
      ...(pinnedProvider === undefined ? {} : { providerId: pinnedProvider }),
      ...(model === undefined ? {} : { model }),
    });
    const workerExec = reconcile({
      ...executionOf(workerConfig),
      ...presetExec,
      ...(pinnedProvider === undefined ? {} : { providerId: pinnedProvider }),
      ...(model === undefined ? {} : { model }),
      ...(reasoning === undefined ? {} : { reasoningLevel: reasoning }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    });
    if (pinnedProvider !== undefined && workerExec.providerId !== pinnedProvider) {
      throw new Error("The worker model does not belong to the pinned provider; supply a compatible model.");
    }
    assertInCatalog(workerExec);

    /**
     * Spawn one worker on `exec`, in `environment`, and record it against this
     * orchestrator. The spawned thread comes back so a check unit or a retry can
     * reuse the checkout this unit was given.
     */
    async function spawnWorker(
      exec: WorkerExecution,
      workerLabel: string,
      environment: ReturnType<typeof environmentFor>,
      options: {
        brief?: string;
        verifierFor?: string;
        pluginInitiated?: boolean;
        revisionOf?: string;
        /** The chain's root unit, carried so the budget stays on one record. */
        revisionRoot?: string;
        /** The chain depth this revision is, recorded as the spend at this point. */
        revisionDepth?: number;
        kind?: WorkerPresetName;
        after?: string[];
      } = {},
    ): Promise<{ id: string; environmentId: string | null }> {
      // One choke point: no path in this call spawns a worker after the call was
      // cancelled or the plugin was disposed.
      if (cancelled()) {
        throw new Error("the call was cancelled, so no worker was started");
      }
      const countPerTurn = options.pluginInitiated !== true;
      await assertWithinBudget(orchestratorId, countPerTurn, targetProjectId);
      try {
        assertInCatalog(exec);
        const spawned = await bb.sdk.threads.spawn({
          projectId: targetProjectId,
          environment,
          prompt: options.brief ?? task,
          title: workerLabel,
          parentThreadId: orchestratorId,
          ...(hidden === true ? { visibility: "hidden" as const } : {}),
          ...exec,
          // The server drops a requested provider/model that carries no
          // provenance source and re-derives it from the project's remembered
          // defaults, which would silently undo everything above.
          ...(Object.keys(exec).length === 0
            ? {}
            : { executionInputSources: executionSources(exec) }),
          // A check unit names the unit it inspects, so a ledger write that fails
          // still leaves definitive ownership in BB rather than only a title.
          pluginMetadata: {
            workerFor: orchestratorId,
            ...(options.verifierFor === undefined ? {} : { checkFor: options.verifierFor }),
          },
        });
        await mutateState(spawned.id, (current) => ({ ...current, workerOf: orchestratorId }));
        await mutateState(orchestratorId, (current) => {
          const delegations = trimDelegations([
            ...current.delegations,
            {
              threadId: spawned.id,
              title: workerLabel,
              // The full brief, because a rejected unit is re-delegated from this
              // record: a truncated brief would hand the revision a different task.
              task: (options.brief ?? task).slice(0, 20_000),
              createdAt: Date.now(),
              status: null,
              ...(options.verifierFor === undefined
                ? {}
                : { verifierFor: options.verifierFor, verifiedBy: null, verdict: null }),
              ...(options.revisionOf === undefined
                ? {}
                : {
                    revisionOf: options.revisionOf,
                    revisionRoot: options.revisionRoot ?? options.revisionOf,
                    revisions: options.revisionDepth ?? 0,
                  }),
              ...(checkUnit && options.verifierFor === undefined ? { verify: true } : {}),
              kind: options.kind ?? unitKind ?? null,
              ...(options.after === undefined || options.after.length === 0
                ? {}
                : { after: options.after }),
              environmentId: spawned.environmentId ?? null,
              // What BB reports at spawn. The provider is readable immediately,
              // so a worker nobody waits for is not "unconfirmed" forever; a
              // later settle fills in the model from the session snapshot.
              resolved:
                spawned.providerId === null || spawned.providerId === undefined
                  ? null
                  : {
                      providerId: spawned.providerId,
                      model: null,
                      source: "thread" as const,
                      at: Date.now(),
                      unreported: ["reasoningLevel", "serviceTier"],
                    },
              execution: {
                providerId: spawned.providerId ?? exec.providerId ?? null,
                model: exec.model ?? null,
                reasoningLevel: exec.reasoningLevel ?? null,
                serviceTier: exec.serviceTier ?? null,
                permissionMode: exec.permissionMode ?? null,
              },
            },
          ]);
          const dropped = current.delegations.length + 1 - delegations.length;
          return {
            ...current,
            delegations,
            lost: {
              violations: current.lost?.violations ?? 0,
              seenRows: current.lost?.seenRows ?? 0,
              delegations: (current.lost?.delegations ?? 0) + Math.max(0, dropped),
            },
          };
        });
        return { id: spawned.id, environmentId: spawned.environmentId ?? null };
      } finally {
        // However the spawn ended, its claim stops counting against the caps.
        releaseClaim(orchestratorId, countPerTurn);
      }
    }

    /**
     * Wait for one worker, resuming it when it is stalled, record how it
     * settled, and read what it said. The stall budget comes from the scope, and
     * the resume continues the same session: a stalled worker is never replaced,
     * so its side effects cannot run twice.
     */
    async function settle(workerId: string, signal?: AbortSignal): Promise<SettledWorker> {
      const settled = await waitForWorker(workerId, remainingMs(), {
        ownerThreadId: orchestratorId,
        maxResumes: settingsFor(projectId).maxStallResumes,
        ...(signal === undefined ? {} : { signal }),
      });
      await mutateState(orchestratorId, (current) => ({
        ...current,
        delegations: current.delegations.map((delegation) =>
          delegation.threadId === workerId
            ? {
                ...delegation,
                status: settled.status,
              }
            : delegation,
        ),
      }));
      await recordResolved(orchestratorId, workerId);
      if (!settled.running) await maybeArchive(orchestratorId, workerId);
      return settled;
    }

    /** The text the orchestrator gets back about one finished worker. */
    function report(workerId: string, settled: SettledWorker): string {
      if (settled.running) {
        const window = `${Math.round(STALL_WINDOW_MS / 60_000)} minutes`;
        const resumed = settled.stalled
          ? `It recorded no progress for over ${window}, and its resume budget is spent, so no further resume was sent.`
          : settled.resumes === 0
            ? `It is still recording progress, so no resume was sent.`
            : `It recorded no progress for over ${window}, so ${settled.resumes === 1 ? "a resume message was" : `${settled.resumes} resume messages were`} sent to the same worker.`;
        return `Worker ${workerId} is still running after ${Math.round(timeoutMs / 1000)}s (status: ${settled.status ?? "unknown"}). ${resumed} Delegate the next unit, or wait and check it again. Do not start doing its work yourself, and do not delegate the same unit a second time: it may still finish.`;
      }
      const trimmed = (settled.output ?? "").trim();
      const body =
        trimmed === ""
          ? "(the worker produced no final text. Open the thread to see what it did.)"
          : trimmed.length > 12_000
            ? `${trimmed.slice(0, 12_000)}\n\n[truncated]`
            : trimmed;
      return `Worker ${workerId} finished with status "${settled.status ?? "unknown"}".\n\n${body}\n\nReview it. If it is wrong or incomplete, send a follow-up to a worker. Do not fix it yourself.`;
    }

    /**
     * Re-delegate the same brief on the fallback, which inherits every field
     * it does not name from the execution the first attempt used.
     */
    async function retryOnFallback(fallback: WorkerExecution, reason: string, label: "fallback" | "resume" = "fallback"): Promise<string> {
      const retryExec = reconcile({ ...workerExec, ...fallback });
      const target = retryExec.model ?? "the project default";
      bb.log.warn(`${reason} Retrying on ${target}.`);
      const retry = await spawnWorker(
        retryExec,
        `${workerTitle} (${label})`,
        environmentFor(workerEnvironmentId),
        { pluginInitiated: true },
      );
      const retryId = retry.id;
      const settled = await settle(retryId, signal);
      return `${reason} Re-delegated the same brief on \`${target}\` as worker ${retryId}.\n\n${await finish(retryId, `${workerTitle} (${label})`, settled)}`;
    }

    interface CheckRun {
      id: string | null;
      /** The parsed verdict, or null when the check left none. */
      verdict: ReviewVerdict | null;
      /** Text appended to the delegation result. */
      text: string;
      /** The check's report, used as the reviewer's notes for a revision. */
      report: string;
    }

    /**
     * Store a check's result on the unit it inspected. Acceptance and dependants
     * both read this record, so a check that could not produce a verdict it can
     * stand behind is stored as `rejected` with `problem` naming why: silence must
     * never read as a pass.
     */
    async function storeCheck(
      workerId: string,
      checkerId: string | undefined,
      verdict: ReviewVerdict,
      report: string,
      problem: string | null,
      checkerStatus?: string | null,
    ): Promise<void> {
      await storeCheckFor(orchestratorId, workerId, checkerId, verdict, report, problem, checkerStatus);
    }

    /**
     * Spawn a second worker to check the first one's work, on the same
     * execution, and hand its report back with the worker's. The check unit
     * is recorded as evidence for `workerId` and is not itself a unit the
     * orchestrator has to judge. Its parsed verdict is stored on the unit, so a
     * later acceptance cannot pretend the check passed.
     */
    async function runVerifier(
      workerId: string,
      workerLabel: string,
      workerOutput: string | null,
    ): Promise<CheckRun> {
      // A cancelled call or a disposed plugin must not start another worker.
      if (cancelled()) {
        return { id: null, verdict: null, report: "", text: "\n\nThe call was cancelled, so no check unit was started." };
      }
      const brief = buildVerifierBrief({ task, workerTitle: workerLabel, workerOutput });
      const verifierExec = reconcile({ ...workerExec });
      let verifierId: string;
      try {
        verifierId = (
          await spawnWorker(verifierExec, `${workerLabel} (check)`, environmentFor(workerEnvironmentId), {
            brief,
            verifierFor: workerId,
            pluginInitiated: true,
            kind: "review",
          })
        ).id;
      } catch (cause) {
        bb.log.warn(`check unit for ${workerId} could not start: ${String(cause)}`);
        const why = `no check unit could start (${String(cause)})`;
        await storeCheck(workerId, undefined, "rejected", "", why);
        return { id: null, verdict: null, report: "", text: `\n\nNo check unit ran: ${String(cause)}. That leaves this unit unverified, so it cannot be accepted and dependent units will not start on it.` };
      }
      // Bind the checker before it can report: a stale check cannot overwrite a
      // newer result, and a recovery cannot start a second checker while this
      // one is still live.
      await mutateState(orchestratorId, (current) => ({
        ...current,
        delegations: current.delegations.map((delegation) =>
          delegation.threadId === workerId
            ? {
                ...delegation,
                verifiedBy: verifierId,
                checkClaim: { token: verifierId, at: Date.now(), threadId: verifierId },
              }
            : delegation,
        ),
      }));
      const checkStartedAt = Date.now();
      const checked = await settle(verifierId, signal);
      const report = (checked.output ?? "").trim();
      // The check's verdict is evidence. The orchestrator still judges the unit;
      // the plugin records the check's own result so it can gate acceptance.
      const parsed = checked.running ? null : parseCheckVerdict(report);
      const problem =
        checked.running
          ? cancelled()
            ? "the call was cancelled while the check unit was still running"
            : "the check unit was still running when the call's deadline passed"
          : parsed === null || parsed.verdict === null
            ? (parsed?.reasoning ?? "the check left no verdict")
            : null;
      await storeCheck(workerId, verifierId, parsed?.verdict ?? "rejected", report, problem, checked.status);
      // A chain's outcome follows its latest check: a pass settles it, a fail
      // takes the earlier resolution back, and a check still running settles
      // nothing yet.
      await recordChainOutcome(
        orchestratorId,
        workerId,
        parsed === null ? undefined : parsed.verdict === "accepted" ? workerId : null,
        { since: checkStartedAt },
      );
      let advice =
        parsed === null || parsed.verdict === null
          ? `\n\nThe check left no verdict this plugin can trust (${problem}), so it counts as failed: you cannot accept this unit, and dependent units will not start on it.`
          : `\n\nThe check's verdict is ${parsed.verdict === "accepted" ? "pass" : "fail"}. You still judge this unit with orchestrator_review.`;
      // The advisory judge is opt-in per scope and additionally needs a stored
      // key. Only minimized evidence leaves the machine, and a failure is named
      // instead of disappearing. It draws on what is left of this call's
      // deadline and on the call's cancellation, so a stalled endpoint cannot
      // hold a delegation past the timeout it advertised.
      if (parsed !== null && parsed.verdict !== null && settingsFor(projectId).judgeAdvisory) {
        const key = await judgeKey();
        if (key === null) {
          advice += "\nAdvisory judge: not asked, because no OpenRouter key is stored.";
        } else {
          const outcome = await judgeCheckVerdict(key, report, fetch, {
            remainingMs: remainingMs(),
            ...(signal === undefined ? {} : { signal }),
          });
          advice += outcome.ok
            ? `\nAdvisory judge: ${outcome.opinion.agrees ? "agrees" : "disagrees"}. ${outcome.opinion.rationale}`
            : `\nAdvisory judge: failed — ${outcome.error}.`;
        }
      }
      return {
        id: verifierId,
        verdict: parsed?.verdict ?? null,
        report,
        text: `\n\nCheck unit ${verifierId} ran the same brief.${advice}${
          checked.running
            ? ` ${cancelled() ? "The call was cancelled while it was still running" : "It was still running when the deadline passed"}, so its check is recorded as failed until it reports.`
            : report === ""
              ? " It produced no final text, so its check is recorded as failed."
              : `\n\n${report.length > 8_000 ? `${report.slice(0, 8_000)}\n\n[truncated]` : report}`
        }`,
      };
    }

    /**
     * What a worktree unit leaves behind, named so it can be reviewed or merged.
     * An environment that cannot be read still names the id, because that is the
     * handle every `bb environment` command takes.
     */
    async function worktreeNote(environmentId: string | null): Promise<string> {
      if (unitWorkspace !== "worktree" || environmentId === null) return "";
      try {
        const environment = await bb.sdk.environments.get({ environmentId });
        const branch = environment.branchName;
        const where = branch === null ? `environment ${environmentId}` : `branch \`${branch}\``;
        // The merge brief is written out, because the orchestrator cannot merge by
        // hand: the watchdog counts that as doing the work.
        const land = `delegate a merge unit with \`workspace: "shared"\`: "Merge ${where} into this checkout and report what conflicts instead of resolving them."`;
        return `\n\nThis unit ran in its own worktree on ${where}. Nothing is merged from it: \`bb environment diff ${environmentId}\` shows what it changed. To land it, ${land}`;
      } catch {
        return `\n\nThis unit ran in its own worktree (environment ${environmentId}). Nothing is merged from it. To land it, delegate a merge unit with \`workspace: "shared"\` naming that environment.`;
      }
    }

    /**
     * The worker's report, an independent check when one was asked for, and a
     * revision when that check fails. A revision is this plugin's own decision,
     * so it does not count against the fan-out caps; it is bounded by the
     * scope's revision budget and never loops.
     */
    async function finish(
      workerId: string,
      workerLabel: string,
      settled: SettledWorker,
    ): Promise<string> {
      let text = `${report(workerId, settled)}${await worktreeNote(workerEnvironmentId)}`;
      // Checking a worker that never ran is pointless: there is nothing to
      // inspect, and the orchestrator has to re-delegate that unit anyway.
      if (!checkUnit || settled.running || settled.status === "error") return text;
      const revisionEligible = unitKind === "build" || verify === true;
      const maxRevisions = settingsFor(projectId).maxRevisions;
      let targetId = workerId;
      let targetLabel = workerLabel;
      let targetSettled = settled;
      for (;;) {
        // A cancelled call or a disposed plugin starts no further worker, check
        // or revision: the work the user stopped is not spent on another one.
        if (cancelled()) {
          text += "\n\nThe call was cancelled, so no further check or revision ran.";
          return text;
        }
        const check = await runVerifier(targetId, targetLabel, targetSettled.output);
        text += check.text;
        if (check.verdict !== "rejected" || !revisionEligible) return text;
        // A check that failed while the call was being cancelled still buys no
        // revision, and the consumer is told why none ran.
        if (cancelled()) {
          text += "\n\nThe call was cancelled, so no further check or revision ran.";
          return text;
        }
        // The chain depth is claimed atomically against the durable record, so
        // two rejections cannot both read the same spent count and pass.
        const claim = await claimRevision(orchestratorId, targetId, maxRevisions);
        if (claim === null) {
          text += `\nThe revision budget (${maxRevisions}) is spent, so this unit is reported as rejected: record it and re-delegate the unit to a worker.`;
          return text;
        }
        const depth = claim.depth;
        const brief = buildRevisionBrief({
          task,
          workerTitle: targetLabel,
          previousOutput: targetSettled.output,
          notes: check.report,
        });
        // The claim was taken after the check; a cancellation that landed while
        // it was being taken hands the slot back instead of spawning a worker.
        if (cancelled()) {
          await releaseRevision(orchestratorId, targetId, claim.previousResolvedBy, claim.previousResolvedAt);
          text += `\nThe call was cancelled, so revision ${depth} did not start.`;
          return text;
        }
        let revision: { id: string; environmentId: string | null };
        try {
          revision = await spawnWorker(
            workerExec,
            `${workerTitle} (revision ${depth})`,
            environmentFor(workerEnvironmentId),
            {
              brief,
              pluginInitiated: true,
              revisionOf: targetId,
              revisionRoot: claim.rootId,
              revisionDepth: depth,
            },
          );
        } catch (cause) {
          // The unit finished and its check ran, so a revision that cannot
          // start is reported beside the result instead of replacing it. The
          // claim is handed back: an unstarted revision spent nothing.
          await releaseRevision(orchestratorId, targetId, claim.previousResolvedBy, claim.previousResolvedAt);
          const why = cause instanceof Error ? cause.message : String(cause);
          text += `\nThe check failed, but the revision could not start: ${why}. Record the unit as rejected and re-delegate it yourself.`;
          return text;
        }
        const revisionSettled = await settle(revision.id, signal);
        text += `\n\nThe check failed, so the unit was re-delegated on the same execution as revision ${depth}: worker ${revision.id}${
          revisionSettled.running
            ? " (still running)"
            : ` (status ${revisionSettled.status ?? "unknown"})`
        }.`;
        if (revisionSettled.running || revisionSettled.status === "error") return text;
        targetId = revision.id;
        targetLabel = `${workerLabel} (revision ${depth})`;
        targetSettled = revisionSettled;
      }
    }

    const fallback = workerConfig.fallback;
    let workerId: string;
    /** The checkout the unit's workers run in, reused by its check unit and retry. */
    let workerEnvironmentId: string | null = null;
    try {
      const spawned = await spawnWorker(workerExec, workerTitle, environmentFor(null), {
        ...(after !== undefined && after.length > 0 ? { after } : {}),
      });
      workerId = spawned.id;
      workerEnvironmentId = spawned.environmentId;
    } catch (cause) {
      // A cap is our own refusal, not a provider that could not start: send
      // it straight back so the orchestrator changes what it is doing.
      if (cause instanceof WorkerBudgetError) throw cause;
      // A spawn that never started a worker is the clearest case for the
      // fallback: the provider could not serve the requested execution at all.
      if (fallback === undefined) throw cause;
      return await retryOnFallback(
        fallback,
        `Worker could not start on \`${workerExec.model ?? "the project default"}\`: ${String(cause)}`,
      );
    }

    if (waitForResult === false) {
      const retry = fallback === undefined ? "" : " If it fails, re-delegate it on the configured fallback.";
      return `Delegated without waiting.\nWorker thread ${workerId}, titled "${workerTitle}"\nCheck on it later and fold its result into your report.${retry}${await worktreeNote(workerEnvironmentId)}`;
    }

    const first = await settle(workerId, signal);
    if (first.running || first.status !== "error") {
      return await finish(workerId, workerTitle, first);
    }
    // One resume on the same execution when no fallback is set: a failed worker
    // gets a second attempt, and that attempt is not retried again.
    if (fallback === undefined) {
      return await retryOnFallback({}, `Worker ${workerId} failed.`, "resume");
    }
    return await retryOnFallback(fallback, `Worker ${workerId} failed.`);
  }

  bb.agents.registerTool({
    name: DELEGATE_TOOL,
    description:
      "Hand one unit of work to a worker thread and get its result back. Optionally pin its providerId and model before it starts. The only way an orchestrator-mode thread gets work done. The worker cannot see this conversation, so `task` must be a complete, self-contained brief: goal, context, constraints, and what done means.",
    instructions:
      "In orchestrator mode, delegate every unit of real work with orchestrator_delegate instead of doing it yourself. Fan out independent units in parallel; sequence only genuine dependencies.",
    presentation: {
      label: {
        pending: "Delegating to a worker thread",
        completed: "Delegated to a worker thread",
      },
    },
    parameters: delegateParameters,
    execute: delegateTask,
  });

  /**
   * Record a verdict on a worker this thread delegated. The review tool and the
   * `review` CLI both write it, so an orchestrator whose session lacks the tool can
   * still judge its workers.
   */
  async function recordVerdict(
    threadId: string,
    workerThreadId: string,
    verdict: ReviewVerdict,
    notes: string | undefined,
    verifiedBy: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = await getState(threadId);
    const known = state?.delegations ?? [];
    const target = known.find((delegation) => delegation.threadId === workerThreadId);
    if (target === undefined) {
      const ids = known.map((delegation) => delegation.threadId).join(", ");
      throw new Error(
        `This thread has no worker ${workerThreadId}.${ids === "" ? " It has delegated nothing yet." : ` Workers it delegated: ${ids}.`}`,
      );
    }
    // An independent check that failed is evidence against the work. Accepting
    // anyway would turn the check into decoration, and the plugin never records
    // acceptance itself: a pass in a model's report is not a verdict. A chain a
    // later revision resolved is the exception: the finding was fixed there.
    const blocked = checkBlockReason(target, known);
    if (verdict === "accepted" && blocked !== null) {
      throw new Error(
        `Worker ${workerThreadId} cannot be accepted on its report: ${blocked}. ${
          target.verify === true && (target.check === null || target.check === undefined || target.check.problem != null)
            ? `If its check never ran, run \`${CHECK_TOOL}\` for it to run that check now; otherwise reject it explicitly to have a corrected unit delegated.`
            : `Re-delegate it with the check's findings (record rejected, and the plugin re-delegates the build unit once), or reject it explicitly and re-delegate a corrected unit.`
        }`,
      );
    }
    const updated = await mutateState(threadId, (current) => ({
      ...current,
      delegations: current.delegations.map((delegation) =>
        delegation.threadId === workerThreadId
          ? {
              ...delegation,
              verdict,
              notes: notes ?? delegation.notes ?? null,
              reviewedAt: Date.now(),
              ...(verifiedBy === undefined ? {} : { verifiedBy }),
            }
          : delegation,
      ),
    }));
    // Accepting a revision settles its chain: the original's failed check and
    // recorded rejection no longer refuse acceptance or a dependent unit.
    if (verdict === "accepted" && target.revisionOf != null) {
      await recordChainOutcome(threadId, workerThreadId, target.threadId);
    }
    // Recording a verdict is the moment the orchestrator demonstrably read the
    // result, which is what retention waits for.
    await maybeArchive(threadId, workerThreadId);
    const reviewed = updated?.delegations.find((delegation) => delegation.threadId === workerThreadId);
    if (reviewed?.verifiedBy != null) {
      await maybeArchive(threadId, reviewed.verifiedBy);
    }
    const remaining = unreviewedOf(updated?.delegations ?? []).length;
    const tail =
      remaining === 0
        ? " Every worker has a verdict."
        : ` ${remaining} worker${remaining === 1 ? "" : "s"} still unjudged.`;
    if (verdict === "accepted") {
      return `Recorded accepted for ${workerThreadId}.${tail}`;
    }
    // A rejected build unit is re-delegated here, with the reviewer's notes,
    // inside the scope's revision budget. The orchestrator is told what ran.
    const revision = await reviseRejected(threadId, target, notes, signal).catch((cause) => {
      bb.log.warn(`revision after rejecting ${workerThreadId} failed: ${String(cause)}`);
      return `\nNo revision ran: ${String(cause)}.`;
    });
    return `Recorded rejected for ${workerThreadId}. Do not fix it yourself.${revision}${tail}`;
  }

  bb.agents.registerTool({
    name: REVIEW_TOOL,
    description:
      "Record your verdict on one worker's output. Call it once per worker whose result you used, before you report, because the watchdog checks for it. `rejected` means the unit is re-delegated to a worker, never patched by you.",
    instructions:
      "Judge every worker whose result you used and record the verdict with orchestrator_review before you finish the turn.",
    presentation: {
      label: {
        pending: "Recording a worker review",
        completed: "Recorded a worker review",
      },
    },
    parameters: z.object({
      workerThreadId: z
        .string()
        .min(1)
        .max(120)
        .describe("The worker thread whose output you judged."),
      verdict: z
        .enum(REVIEW_VERDICTS)
        .describe("accepted, or rejected when the result is wrong or incomplete."),
      notes: z
        .string()
        .max(2_000)
        .optional()
        .describe(
          "What you checked and what you concluded. On a rejected build unit these notes are the revision brief, so name what is wrong and what to change.",
        ),
      verifiedBy: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("The check unit's thread id, when one ran."),
    }),
    async execute({ workerThreadId, verdict, notes, verifiedBy }, { threadId, signal }) {
      if (threadId === undefined) {
        throw new Error(`${REVIEW_TOOL} needs a thread context.`);
      }
      return recordVerdict(threadId, workerThreadId, verdict, notes, verifiedBy, signal);
    },
  });

  bb.agents.registerTool({
    name: CHECK_TOOL,
    description:
      "Run the independent check a worker is still waiting for. Use it only for a worker the plugin reports as pending its check, such as a revision whose review call ended before its check ran.",
    instructions:
      "A unit that asks for an independent check but has none is pending, not passed. When a worker is pending its check, run orchestrator_check for it instead of accepting it or re-delegating the same unit. If that check is still running, or a checker exists that the ledger does not name, the call is refused and the unit stays claimed: nothing is duplicated, and a checker that settled is recorded from what it actually reported.",
    presentation: {
      label: {
        pending: "Running a worker's independent check",
        completed: "Ran a worker's independent check",
      },
    },
    parameters: z.object({
      workerThreadId: z
        .string()
        .min(1)
        .max(120)
        .describe("The worker thread whose pending independent check to run."),
    }),
    async execute({ workerThreadId }, { threadId, signal }) {
      if (threadId === undefined) {
        throw new Error(`${CHECK_TOOL} needs a thread context.`);
      }
      return recoverCheck(threadId, workerThreadId, signal);
    },
  });

  bb.agents.configure((context) => {
    // The mirror is the only source of truth here. `configure` is synchronous
    // and receives no createdAt, so it cannot tell a thread created under the
    // new-thread default from one that merely predates it, and guessing here is
    // what once governed every mirror-less thread in the app. The dispatch
    // hook, which does have createdAt, is the single place the default lands.
    const metadata = context.pluginMetadata as Record<string, unknown>;
    const mirror = readMirror(metadata);
    const enabled = mirror !== null && mirror.enabled;
    if (!enabled) {
      // A worker this plugin spawned owns one unit, and it is the last thread
      // that should fan out again. The provider's own subagent tool cannot be
      // removed from here — `configure` only adds — so the rule is told, not
      // enforced, and the worker is the one that has to keep the brief whole.
      const spawnedBy = metadata["workerFor"];
      if (
        typeof spawnedBy === "string" &&
        spawnedBy.trim() !== "" &&
        settingsFor(context.project.id).workerSubagents === "blocked"
      ) {
        return { tools: [], skills: [], instructions: WORKER_SUBAGENT_RULE };
      }
      return { tools: [], skills: [] };
    }
    // The context carries the project, so a session's contract is the one resolved
    // for the project it belongs to rather than the plugin-wide default.
    const settings = settingsFor(context.project.id);
    const enforcement = mirror?.enforcement ?? settings.enforcement;
    const state = cache?.[context.thread.id];
    const reminders =
      state === undefined || state.violations.length === 0
        ? undefined
        : state.violations.slice(-5).map((violation) => violation.detail);
    return {
      tools: [DELEGATE_TOOL, REVIEW_TOOL, CHECK_TOOL],
      skills: [],
      instructions: buildInstructions({
        enforcement,
        allowReadCommands: settings.allowReadCommands,
        reminders,
        workerConfig: workerFor(context.project.id),
        extra: rulesFor(context.project.id),
        preset: settings.contractPreset,
        maxRevisions: settings.maxRevisions,
        modelPolicy: settings.workerModelPolicy,
        workspace: settings.workerWorkspace,
        subagents: settings.orchestratorSubagents,
      }),
    };
  });

  // --- layer 2: the dispatch checkpoint ------------------------------------

  const childQueue = childMessageQueue(bb, async (threadId) => {
    if (disposed || (await getState(threadId))?.enabled !== true || disposed) return false;
    const thread = await bb.sdk.threads.get({ threadId });
    return !disposed && (await getState(threadId))?.enabled === true && !disposed &&
      settingsFor(thread.projectId).childMessageDelivery === "queued";
  });

  bb.events.on("message.queued", ({ entry }) => {
    if (childQueue.owned(entry)) return childQueue.prepare(entry.threadId);
  });
  // Once a leading batch leaves, the next child becomes the queue's prefix.
  bb.events.on("message.dispatched", ({ entry }) => childQueue.prepare(entry.threadId));
  bb.events.on("message.cancelled", ({ entry }) => childQueue.prepare(entry.threadId));

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
            headUnknown: !head.ok,
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
      if (state.enabled) {
        const settings = settingsFor(ctx.project.id);
        if (
          settings.childMessageDelivery === "queued" &&
          (ctx.queuedMessages.length > 0 || ctx.attempt === "join-turn" || ctx.thread.status === "active")
        ) {
          const messages = ctx.queuedMessages.length > 0 ? ctx.queuedMessages : [ctx];
          // A mixed group may contain a user message or an unrelated sender.
          // Decide for the whole group without delaying either of those.
          const senders = new Set<string>();
          for (const message of messages) {
            if (
              message.initiator !== "agent" ||
              message.senderThreadId === null ||
              message.senderThreadId === "mixed"
            ) {
              senders.clear();
              break;
            }
            senders.add(message.senderThreadId);
          }
          if (senders.size > 0) {
            const children = await Promise.all(
              [...senders].map(async (senderThreadId) =>
                (await bb.sdk.threads.get({ threadId: senderThreadId })).parentThreadId === threadId,
              ),
            );
            if (children.every(Boolean)) {
              if (ctx.attempt === "join-turn" || ctx.thread.status === "active") {
                return {
                  action: "wait" as const,
                  reason: "Child messages are queued until the orchestrator finishes its current turn.",
                };
              }
              if (await childQueue.defer(threadId, ctx.queuedMessages)) {
                return { action: "wait" as const, reason: CHILD_BATCH_WAIT_REASON };
              }
            }
          }
        }
        // A dispatch is where a new turn begins, so this is where the per-turn
        // delegation budget starts counting.
        if (ctx.attempt === "start-turn") {
          await mutateState(threadId, (current) => ({ ...current, turnStartedAt: Date.now() }));
        }
        scheduleScan(threadId, 0);
      }
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
    // Resolved once per scan: the project a thread belongs to cannot change
    // mid-scan, and the classifier reads two values from it per row.
    const scanThread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const scanSettings = settingsFor(scanThread?.projectId);
    const providerId = scanThread?.providerId;
    const stored = await getState(threadId);
    const state = await refreshWorkerRecords(threadId, stored);
    if (state !== undefined && !state.enabled && state.workerOf !== null) {
      await scanWorker(threadId, state, providerId, scanSettings);
      return;
    }
    if (state === undefined || !state.enabled) return;
    const enforcement = effectiveEnforcement(state);
    if (enforcement === "instruct") return;
    // The cursor could not be seeded when the mode was switched on. Seed it from
    // the first readable timeline and judge nothing in that scan: an unknown
    // head must never be read as "everything so far is new".
    if (state.headUnknown === true) {
      try {
        const head = await timelineHead(threadId);
        if (!head.ok) return;
        await mutateState(threadId, (current) => ({
          ...current,
          lastSeq: Math.max(current.lastSeq, head.seq),
          headUnknown: false,
        }));
        bb.log.info(`seeded ${threadId} at sequence ${head.seq} after an unreadable head`);
      } catch (cause) {
        bb.log.warn(`head seeding failed for ${threadId}: ${String(cause)}`);
      }
      return;
    }

    const timeline = await bb.sdk.threads.timeline({
      threadId,
      includeNestedRows: "true",
      ...(state.lastSeq > 0 ? { afterSequence: String(state.lastSeq) } : {}),
    });
    // Incremental responses carry row patches instead of full rows. Nested
    // rows keep work visible after a completed turn collapses to a summary.
    const rows = asScanRows(timeline.delta?.upsertRows ?? timeline.rows);
    // A worker may have been recorded while the timeline request was in flight,
    // and a thread this orchestrator owns can exist without a delegation row.
    // A child keeps `parentThreadId`; a fork keeps `sourceThreadId` and a null
    // parent. Hidden threads are included, because a worker kept out of the
    // sidebar is still owned. The classifier exempts `bb thread tell` for any
    // of them: a correction sent to a thread this orchestrator owns is
    // coordination, not work. Each read is one page, and a failed read
    // contributes nothing, so the scan keeps the delegation record and the
    // page that did succeed instead of throwing out of the scan.
    async function listedIds(
      filter: { parentThreadId: string } | { sourceThreadId: string },
    ): Promise<string[]> {
      try {
        const children = await bb.sdk.threads.list({
          ...filter,
          includeHidden: true,
          limit: MAX_CHILD_THREADS,
        });
        return children.flatMap((child) => (typeof child.id === "string" ? [child.id] : []));
      } catch {
        return [];
      }
    }
    // A worker spawned with `bb thread spawn` records no parent, so ownership
    // falls back to the project: a thread there created after this orchestrator
    // is one it could have spawned. An older thread in the project is someone
    // else's work. A failed read contributes nothing, as for the parent pages.
    async function projectThreadIds(): Promise<string[]> {
      const projectId = scanThread?.projectId;
      const floor = scanThread?.createdAt;
      if (typeof projectId !== "string" || typeof floor !== "number") return [];
      try {
        const threads = await bb.sdk.threads.list({
          projectId,
          includeHidden: true,
          limit: MAX_CHILD_THREADS,
        });
        return threads.flatMap((thread) =>
          typeof thread.id === "string" &&
          thread.id !== threadId &&
          typeof thread.createdAt === "number" &&
          thread.createdAt >= floor
            ? [thread.id]
            : [],
        );
      } catch {
        return [];
      }
    }
    const [childIds, forkIds, projectIds] = await Promise.all([
      listedIds({ parentThreadId: threadId }),
      listedIds({ sourceThreadId: threadId }),
      projectThreadIds(),
    ]);
    const workerThreadIds = [...new Set([
      ...((await getState(threadId))?.delegations.map((worker) => worker.threadId) ?? []),
      ...childIds,
      ...forkIds,
      ...projectIds,
    ])];
    const enabledAtMs = state.enabledAt === null ? 0 : Date.parse(state.enabledAt);
    // A missing or malformed maxSeq must not poison the cursor: Math.max(2, undefined) is NaN, which persists as null.
    const reportedMaxSeq = typeof timeline.maxSeq === "number" && Number.isFinite(timeline.maxSeq) ? timeline.maxSeq : 0;
    let maxSeq = Math.max(state.lastSeq, reportedMaxSeq);
    const graceTurnIds = [...state.graceTurnIds];
    const fresh: Violation[] = [];
    // The turn the batch is about: the newest row that produced a violation.
    // Block mode stops and nudges this turn, not the first one in the batch.
    let liveTurnKey: string | null = null;
    let liveSeq = -1;
    for (const row of rows) {
      const seq = typeof row.sourceSeqEnd === "number" ? row.sourceSeqEnd : 0;
      if (seq > maxSeq) maxSeq = seq;
      if (seq !== 0 && seq <= state.lastSeq) continue;
      try {
        // A later turn can reuse a row id, so the sequence disambiguates a genuine second delivery from a new act.
        if (state.seenRowIds.includes(seenKey(row))) continue;
        const turnId = row.turnId ?? null;
        // Which turns predate the enable is decided by `startedAt` where the row
        // carries one: an earlier timestamp is history, and history must not
        // spend a grace slot. A row without one is a partial or delta row (the
        // timeline puts startedAt on the completed summary, not on every
        // patch), so "unknown" counts as present and the first post-enable turn
        // is still excused.
        const startedAt = typeof row.startedAt === "number" ? row.startedAt : enabledAtMs;
        if (
          turnId !== null &&
          !graceTurnIds.includes(turnId) &&
          graceTurnIds.length < state.graceSlots &&
          startedAt >= enabledAtMs
        ) {
          graceTurnIds.push(turnId);
        }
        // Turns that ran before the session could gain the contract are never
        // judged, only recorded.
        if (turnId !== null && graceTurnIds.includes(turnId)) continue;
        const violation = classifyRow(row, {
          // The delegate-only contract runs no shell commands, so its watchdog judges reads as work too.
          allowReadCommands: scanSettings.allowReadCommands && scanSettings.contractPreset !== "delegate-only",
          workerThreadIds,
          subagents: scanSettings.orchestratorSubagents,
          providerId,
        });
        if (violation !== null) {
          fresh.push(violation);
          if (seq >= liveSeq) {
            liveSeq = seq;
            // A turn with no id cannot share the sentinel with the next such
            // turn: "unknown" would suppress every later stop. The row id is
            // unique per delivery, so the key still names one live turn.
            liveTurnKey = turnId ?? `unknown:${violation.id}`;
          }
        }
      } catch (cause) {
        // A malformed row must not wedge the watchdog: the cursor still advances
        // past it, so the next scan keeps enforcing instead of failing forever.
        bb.log.warn(`scan skipped a malformed row in ${threadId}: ${String(cause)}`);
      }

    }

    if (fresh.length === 0 && maxSeq === state.lastSeq) return;

    const updated = await mutateState(threadId, (current) => {
      // A scan re-delivers rows it already classified. Appending them again
      // inflated the "dropped" counter and evicted unique keys early, so only a
      // key the ring does not already hold is recorded.
      const seen = [...current.seenRowIds];
      const known = new Set(seen);
      for (const row of rows) {
        const key = seenKey(row);
        if (known.has(key)) continue;
        known.add(key);
        seen.push(key);
      }
      const violations = [...current.violations, ...fresh];
      const keptSeen = seen.slice(-MAX_SEEN_ROWS);
      const keptViolations = violations.slice(-MAX_VIOLATIONS);
      return {
        ...current,
        lastSeq: Math.max(current.lastSeq, maxSeq),
        graceTurnIds,
        seenRowIds: keptSeen,
        violations: keptViolations,
        lost: {
          violations: (current.lost?.violations ?? 0) + (violations.length - keptViolations.length),
          delegations: current.lost?.delegations ?? 0,
          seenRows: (current.lost?.seenRows ?? 0) + (seen.length - keptSeen.length),
        },
      };
    });
    if (fresh.length === 0) return;

    bb.log.warn(
      `${threadId} did direct work ${fresh.length} time(s): ${fresh
        .map((violation) => violation.detail)
        .join("; ")}`,
    );
    bb.realtime.publish(STATE_CHANGED, { at: Date.now(), threadId, violations: fresh.length });
    await intervene(threadId, updated, fresh, enforcement, liveTurnKey ?? fresh[fresh.length - 1]!.id);
  }

  /**
   * A worker this plugin spawned. Its scope decides whether it may start subagents.
   * The provider's own subagent tool cannot be removed, so a launch is answered
   * with a correction instead of being prevented.
   */
  async function scanWorker(
    threadId: string,
    state: ThreadState,
    providerId: string | undefined,
    settings: SettingsView,
  ): Promise<void> {
    if (settings.workerSubagents !== "blocked") return;
    const timeline = await bb.sdk.threads.timeline({
      threadId,
      includeNestedRows: "true",
      ...(state.lastSeq > 0 ? { afterSequence: String(state.lastSeq) } : {}),
    });
    const rows = asScanRows(timeline.delta?.upsertRows ?? timeline.rows);
    const reportedMaxSeq =
      typeof timeline.maxSeq === "number" && Number.isFinite(timeline.maxSeq) ? timeline.maxSeq : 0;
    let maxSeq = Math.max(state.lastSeq, reportedMaxSeq);
    const seen = [...state.seenRowIds];
    const started: string[] = [];
    let launchTurn = "";
    for (const row of rows) {
      const seq = typeof row.sourceSeqEnd === "number" ? row.sourceSeqEnd : 0;
      if (seq > maxSeq) maxSeq = seq;
      if (seq !== 0 && seq <= state.lastSeq) continue;
      const key = seenKey(row);
      if (seen.includes(key)) continue;
      seen.push(key);
      const names = subagentsOf(row, providerId);
      if (names === null || names.length === 0) continue;
      started.push(...names);
      launchTurn = row.turnId ?? row.id;
    }
    const updated = await mutateState(threadId, (current) => {
      const kept = seen.slice(-MAX_SEEN_ROWS);
      return {
        ...current,
        lastSeq: Math.max(current.lastSeq, maxSeq),
        seenRowIds: kept,
        lost: {
          violations: current.lost?.violations ?? 0,
          delegations: current.lost?.delegations ?? 0,
          seenRows: (current.lost?.seenRows ?? 0) + (seen.length - kept.length),
        },
      };
    });
    if (started.length === 0 || updated === undefined) return;
    if (updated.lastNudgeTurnId === launchTurn || updated.nudgeCount >= settings.maxNudges) return;
    const names = [...new Set(started)].map((name) => `\`${name}\``).join(", ");
    bb.log.warn(`worker ${threadId} started subagent ${names}`);
    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{
          type: "text",
          text: `You started subagent ${names} yourself. Worker subagents are blocked in this scope: finish this unit with your own tools and start no subagents.`,
          mentions: [],
        }],
      });
      await mutateState(threadId, (current) => ({
        ...current,
        nudgeCount: current.nudgeCount + 1,
        lastNudgeTurnId: launchTurn,
      }));
    } catch (cause) {
      bb.log.warn(`worker nudge failed for ${threadId}: ${String(cause)}`);
    }
  }

  async function intervene(
    threadId: string,
    state: ThreadState | undefined,
    violations: readonly Violation[],
    enforcement: EnforcementLevel,
    /** Names the live turn for `lastStopTurnId`/`lastNudgeTurnId`. */
    liveTurnKey: string,
  ): Promise<void> {
    if (state === undefined) return;

    if (enforcement === "block" && state.lastStopTurnId !== liveTurnKey) {
      try {
        await bb.sdk.threads.stop({ threadId });
        await mutateState(threadId, (current) => ({ ...current, lastStopTurnId: liveTurnKey }));
        bb.log.warn(`stopped ${threadId} for doing direct work`);
      } catch (cause) {
        bb.log.warn(`stop failed for ${threadId}: ${String(cause)}`);
      }
    }

    if (state.lastNudgeTurnId === liveTurnKey) return;
    if (state.nudgeCount >= settingsFor(await projectOfThread(threadId)).maxNudges) return;
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
        violationNudges: current.violationNudges + 1,
        lastNudgeTurnId: liveTurnKey,
      }));
    } catch (cause) {
      bb.log.warn(`nudge failed for ${threadId}: ${String(cause)}`);
    }
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    void (async () => {
      const state = await getState(thread.id);
      if (state?.enabled === true || state?.workerOf) scheduleScan(thread.id);
    })();
  });

  bb.events.on("thread.idle", ({ thread }) => {
    void (async () => {
      await syncDelegationFor(thread.id, thread.status);
      const state = await getState(thread.id);
      if (state?.enabled === true) {
        scheduleScan(thread.id, 250);
        await checkReviews(thread.id);
      } else if (state?.workerOf) {
        scheduleScan(thread.id, 250);
      }
    })();
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    void (async () => {
      await syncDelegationFor(thread.id, thread.status, error);
    })();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    void mutateState(thread.id, () => null);
  });

  /**
   * The orchestrator whose delegation this worker is, if any. A worker that
   * settles while its orchestrator is not watching it is only visible through
   * this lookup. A delegation made with `waitForResult: false` settles that way.
   */
  function ownerOf(workerThreadId: string): string | undefined {
    for (const [threadId, state] of Object.entries(cache ?? {})) {
      if (state.delegations.some((delegation) => delegation.threadId === workerThreadId)) {
        return threadId;
      }
    }
    return undefined;
  }

  /**
   * Keep a delegation's record in step when its worker settles on its own, and
   * carry the failure text across so the orchestrator is told why, not just
   * that it errored.
   */
  async function syncDelegationFor(
    workerThreadId: string,
    status: string,
    failure?: string | null,
  ): Promise<void> {
    await readAll();
    const owner = ownerOf(workerThreadId);
    if (owner === undefined) return;
    await mutateState(owner, (current) => ({
      ...current,
      delegations: current.delegations.map((delegation) =>
        delegation.threadId === workerThreadId
          ? {
              ...delegation,
              status,
              ...(failure === undefined || failure === null ? {} : { failure }),
            }
          : delegation,
      ),
    }));
    // The session snapshot now names the model, which only exists once the
    // worker has run; the spawn-time record has the provider alone.
    if (isSettledStatus(status)) await recordResolved(owner, workerThreadId);
    await checkReviews(owner);
  }

  /**
   * BB's current children of one orchestrator, read live. A child is current
   * when BB's own list would show it: not archived, not deleted. Hidden threads
   * count, because a hidden child still runs and still burns a slot.
   *
   * The count comes from `threads.list` with `includeHidden`, paged by
   * `limit`/`offset`: `threads.count` accepts no `includeHidden`, so its total
   * leaves every hidden child out. A short page ends the walk and makes the
   * total exact. A read that fills every page is checked with one more row and
   * answered as unavailable when that row exists, because a capped total would
   * understate the tree. Any failed page does the same: a partial count would
   * be a number nobody can act on, and the ledger is never substituted for it.
   */
  const childCountCache = new Map<string, { at: number; value: ChildCounts }>();
  const childCountPending = new Map<string, Promise<ChildCounts>>();

  async function readChildCounts(threadId: string): Promise<ChildCounts> {
    const seen = new Set<string>();
    let total = 0;
    let running = 0;
    const absorb = (children: Awaited<ReturnType<typeof bb.sdk.threads.list>>): void => {
      for (const child of children) {
        // The route already leaves archived and deleted threads out of a
        // filtered read. A host that returns one anyway must not inflate the
        // number the strip presents as fact.
        if (child.archivedAt !== null || child.deletedAt !== null) continue;
        // An offset read taken while a child is being created can repeat a row
        // across the page boundary; the same thread is still one child.
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        total += 1;
        if (RUNNING_CHILD_STATUS_SET.has(child.status)) running += 1;
      }
    };
    for (let page = 0; page < CHILD_COUNT_MAX_PAGES; page += 1) {
      const children = await bb.sdk.threads.list({
        parentThreadId: threadId,
        includeHidden: true,
        archived: false,
        limit: CHILD_COUNT_PAGE_SIZE,
        offset: page * CHILD_COUNT_PAGE_SIZE,
      });
      absorb(children);
      if (children.length < CHILD_COUNT_PAGE_SIZE) {
        return { available: true, total, running, error: null };
      }
    }
    // Every page was full. One row past the cap proves whether the walk stopped
    // at the end of the tree or only at its budget.
    const beyond = await bb.sdk.threads.list({
      parentThreadId: threadId,
      includeHidden: true,
      archived: false,
      limit: 1,
      offset: CHILD_COUNT_MAX_PAGES * CHILD_COUNT_PAGE_SIZE,
    });
    const more = beyond.some((child) => child.archivedAt === null && child.deletedAt === null);
    if (!more) return { available: true, total, running, error: null };
    return {
      available: false,
      total: 0,
      running: 0,
      error: `BB lists more than ${CHILD_COUNT_MAX_PAGES * CHILD_COUNT_PAGE_SIZE} current children, so the count would be short`,
    };
  }

  async function childCountsOf(threadId: string): Promise<ChildCounts> {
    const cached = childCountCache.get(threadId);
    if (cached !== undefined && Date.now() - cached.at < CHILD_COUNT_TTL_MS) return cached.value;
    const pending = childCountPending.get(threadId);
    if (pending !== undefined) return pending;
    const read = (async (): Promise<ChildCounts> => {
      try {
        const value = await readChildCounts(threadId);
        childCountCache.set(threadId, { at: Date.now(), value });
        return value;
      } catch (cause) {
        // Cached like a success: a state read that fires per event must not turn
        // a failing host into a query storm. The label says unknown either way.
        const value: ChildCounts = {
          available: false,
          total: 0,
          running: 0,
          error: cause instanceof Error ? cause.message : String(cause),
        };
        childCountCache.set(threadId, { at: Date.now(), value });
        return value;
      } finally {
        childCountPending.delete(threadId);
      }
    })();
    childCountPending.set(threadId, read);
    return read;
  }

  /**
   * Bring every worker record that can still change up to date from BB. The
   * `thread.idle`/`thread.failed` events cover waited-on workers, but a worker
   * delegated with `waitForResult: false` may settle with no such event in this
   * process; without this refresh it would count as running forever and hold a
   * parallel slot it no longer uses. Only records that currently look running
   * are read, so a settled ledger costs nothing.
   */
  async function refreshWorkerRecords(
    threadId: string,
    state: ThreadState | undefined,
  ): Promise<ThreadState | undefined> {
    if (state === undefined) return state;
    const running = state.delegations.filter((delegation) => isRunningStatus(delegation.status));
    if (running.length === 0) return state;
    const read: ({ id: string; status: string; prior: string | null } | null)[] = await Promise.all(
      running.map(async (delegation) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId: delegation.threadId });
          return { id: delegation.threadId, status: thread.status, prior: delegation.status };
        } catch {
          // A deleted or unreadable worker keeps its last known state.
          return null;
        }
      }),
    );
    const changed = read.filter(
      (entry): entry is { id: string; status: string; prior: string | null } =>
        entry !== null && entry.status !== entry.prior,
    );

    if (changed.length === 0) return state;
    const next = await mutateState(threadId, (current) => ({
      ...current,
      delegations: current.delegations.map((delegation) => {
        const update = changed.find((entry) => entry.id === delegation.threadId);
        return update === undefined ? delegation : { ...delegation, status: update.status };
      }),
    }));
    for (const entry of changed) {
      if (!isRunningStatus(entry.status)) await recordResolved(threadId, entry.id);
    }
    // Read the records back: `recordResolved` wrote after `next` was captured.
    return (await getState(threadId)) ?? next ?? state;
  }

  /**
   * A cycle reachable from the requested dependencies, as the path that closes
   * it, or null. The recorded graph is the authority: an edge is a delegation's
   * `after` list, and a node revisited on the current path is the cycle.
   */
  function findDependencyCycle(
    delegations: readonly Delegation[],
    requested: readonly string[],
  ): string[] | null {
    const edges = new Map<string, readonly string[]>();
    for (const delegation of delegations) {
      edges.set(delegation.threadId, delegation.after ?? []);
    }
    const settledNodes = new Set<string>();
    const visit = (id: string, path: readonly string[]): string[] | null => {
      const at = path.indexOf(id);
      if (at >= 0) return [...path.slice(at), id];
      if (settledNodes.has(id)) return null;
      settledNodes.add(id);
      const next = [...path, id];
      for (const dependency of edges.get(id) ?? []) {
        const found = visit(dependency, next);
        if (found !== null) return found;
      }
      return null;
    };
    for (const id of requested) {
      const found = visit(id, []);
      if (found !== null) return found;
    }
    return null;
  }

  /**
   * A poll slice for a worker that is still running. `threads.wait` holds until
   * the deadline, so a stall check needs the wait broken into slices.
   */
  const STALL_POLL_MS = 15_000;
  /**
   * How long a running worker may record no progress before the plugin treats
   * it as stalled. Progress is an advance of the thread's own `updatedAt` or of
   * its timeline sequence, so a provider turn that is genuinely reasoning is not
   * steered while a hung turn is still caught; the window is deliberately
   * longer than one slow model turn.
   */
  const STALL_WINDOW_MS = 300_000;
  /**
   * The resume message. It continues the same session and the same unit, so no
   * second worker is spawned and no side effect is repeated; a stall resume is
   * only ever sent to a worker whose status is `active` and whose thread has
   * recorded no progress for the whole window.
   */
  const STALL_RESUME_TEXT =
    "You appear to have stopped before finishing this unit. Continue from where you are, do not restart the work, and report what you ran and what you changed.";

  interface SettledWorker {
    status: string | null;
    output: string | null;
    /** Still working when the deadline passed. */
    running: boolean;
    /** Stopped waiting on a worker whose window elapsed with no resume budget left. */
    stalled: boolean;
    /** Resume messages this wait sent. The durable count includes them. */
    resumes: number;
  }

  /**
   * Take one resume from a worker's durable budget. The count lives on the
   * delegation record and is claimed inside the same serialized mutation, so
   * two waiters watching the same worker — its own settle and a dependent's
   * `after` check — share one budget instead of one each.
   */
  async function claimStallResume(
    ownerThreadId: string,
    workerId: string,
    maxResumes: number,
  ): Promise<boolean> {
    let claimed = false;
    await mutateState(ownerThreadId, (current) => {
      const delegation = current.delegations.find((entry) => entry.threadId === workerId);
      if (delegation === undefined) return current;
      const spent = delegation.stallResumes ?? 0;
      if (spent >= maxResumes) return current;
      claimed = true;
      return {
        ...current,
        delegations: current.delegations.map((entry) =>
          entry.threadId === workerId ? { ...entry, stallResumes: spent + 1 } : entry,
        ),
      };
    });
    return claimed;
  }

  /** The worker's timeline sequence: any advance is recorded progress. */
  async function workerProgress(workerId: string): Promise<number> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId: workerId });
      const maxSeq = (timeline as { maxSeq?: unknown }).maxSeq;
      return typeof maxSeq === "number" && Number.isFinite(maxSeq) ? maxSeq : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Wait for a worker's promise, but stop waiting when the tool call is
   * cancelled. The wait itself is left to settle on its own: aborting is not
   * permission to stop the worker, only to stop blocking the caller.
   */
  async function waitOrAbort(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      await promise;
      return;
    }
    if (signal.aborted) return;
    let wake: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      wake = () => resolve();
      signal.addEventListener("abort", wake, { once: true });
    });
    try {
      await Promise.race([promise.then(() => undefined, () => undefined), aborted]);
    } finally {
      if (wake !== undefined) signal.removeEventListener("abort", wake);
    }
  }

  /**
   * Wait for one worker, resuming it when it is genuinely stalled, and read what
   * it said. A resume is sent only for `active` with no recorded progress for
   * {@link STALL_WINDOW_MS}, at most `maxResumes` times across every waiter, and
   * through `threads.send` on the same session: a stalled worker is continued,
   * never duplicated, so its side effects are not repeated. Cancelling the tool
   * call stops the wait and the resumes, never the worker.
   */
  async function waitForWorker(
    workerId: string,
    timeoutMs: number,
    options: { ownerThreadId: string; maxResumes: number; signal?: AbortSignal },
  ): Promise<SettledWorker> {
    const deadline = Date.now() + timeoutMs;
    const signal = options.signal;
    let status: string | null = null;
    let lastActivity = Date.now();
    let lastUpdatedAt = 0;
    let lastSeq = -1;
    let resumes = 0;
    let stalled = false;
    while (true) {
      const iterationStart = Date.now();
      const remaining = deadline - Date.now();
      if (remaining <= 0 || (signal !== undefined && signal.aborted)) break;
      try {
        await waitOrAbort(
          bb.sdk.threads.wait({
            threadId: workerId,
            status: "idle",
            timeoutMs: Math.min(remaining, STALL_POLL_MS),
          }),
          signal,
        );
      } catch {
        // An errored thread rejects the wait instead of reaching idle, and a
        // timeout lands here too. The status read below decides which.
      }
      if (signal !== undefined && signal.aborted) break;
      let info: { status: string; updatedAt: number } | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId: workerId });
        info = { status: thread.status, updatedAt: thread.updatedAt };
        status = thread.status;
      } catch {
        info = null;
      }
      if (status === null || status === "idle" || status === "error" || disposed) break;
      if (info !== null && info.updatedAt > lastUpdatedAt) {
        lastUpdatedAt = info.updatedAt;
        lastActivity = Date.now();
      }
      // Only a live turn can be stalled; `starting` and `pending` are waiting on
      // the machine, and `stopping` is on its way out. Timeline progress counts
      // as progress even when `updatedAt` has not moved.
      if (status === "active") {
        const seq = await workerProgress(workerId);
        if (seq > lastSeq) {
          lastSeq = seq;
          lastActivity = Date.now();
        }
      }
      if (status === "active" && Date.now() - lastActivity >= STALL_WINDOW_MS) {
        const claimed = await claimStallResume(options.ownerThreadId, workerId, options.maxResumes);
        if (!claimed) {
          stalled = true;
          break;
        }
        try {
          await bb.sdk.threads.send({
            threadId: workerId,
            mode: "auto",
            input: [{ type: "text", text: STALL_RESUME_TEXT, mentions: [] }],
          });
          resumes += 1;
          lastActivity = Date.now();
          bb.log.warn(
            `worker ${workerId} recorded no progress for ${Math.round(STALL_WINDOW_MS / 1000)}s; sent resume ${resumes} (budget ${options.maxResumes})`,
          );
        } catch (cause) {
          bb.log.warn(`stall resume for ${workerId} failed: ${String(cause)}`);
          break;
        }
      }
      // A wait that resolved immediately — a rejected wait, or a host that
      // returns at once — must not turn this into a spin. A real wait already
      // spent its slice, so this only pauses the fast path.
      if (Date.now() - iterationStart < 1_000) {
        const pause = Math.min(5_000, Math.max(0, deadline - Date.now()));
        if (pause > 0) {
          await waitOrAbort(new Promise<void>((resolve) => setTimeout(resolve, pause)), signal);
        }
      }
    }
    if (status !== "idle" && status !== "error") {
      try {
        status = (await bb.sdk.threads.get({ threadId: workerId })).status;
      } catch {
        // Keep the last status read; it is still the most recent fact.
      }
    }
    const running = status !== "idle" && status !== "error";
    let output: string | null = null;
    if (!running) {
      try {
        const result = await bb.sdk.threads.output({ threadId: workerId });
        output = (result as { output?: string | null }).output ?? null;
      } catch (cause) {
        bb.log.warn(`worker output read failed for ${workerId}: ${String(cause)}`);
      }
    }
    return { status, output, running, stalled, resumes };
  }

  /**
   * What a worker actually ran on, read back from BB. The provider comes from
   * the thread; the model comes from the provider session's snapshot, which is
   * the only resolved-model field BB exposes. Reasoning level and service tier
   * are reported by neither, so they are named as unreported rather than echoed
   * from the request.
   */
  async function captureResolved(workerId: string): Promise<ResolvedExecution | null> {
    let providerId: string | null = null;
    try {
      providerId = (await bb.sdk.threads.get({ threadId: workerId })).providerId ?? null;
    } catch {
      providerId = null;
    }
    let model: string | null = null;
    try {
      const context = await bb.sdk.threads.context({ threadId: workerId });
      model = context.usage?.snapshot?.model ?? null;
    } catch {
      model = null;
    }
    if (providerId === null && model === null) return null;
    return {
      providerId,
      model,
      source: model === null ? "thread" : "session",
      at: Date.now(),
      unreported: ["reasoningLevel", "serviceTier"],
    };
  }

  /** Store what a worker resolved to on its delegation record. */
  async function recordResolved(ownerThreadId: string, workerId: string): Promise<void> {
    const resolved = await captureResolved(workerId);
    if (resolved === null) return;
    await mutateState(ownerThreadId, (current) => ({
      ...current,
      delegations: current.delegations.map((delegation) =>
        delegation.threadId === workerId ? { ...delegation, resolved } : delegation,
      ),
    }));
  }

  /** A stored execution record back in the shape `threads.spawn` takes. */
  function executionFromRecord(record: Delegation["execution"]): WorkerExecution {
    if (record === null || record === undefined) return {};
    return {
      ...(record.providerId === null ? {} : { providerId: record.providerId }),
      ...(record.model === null ? {} : { model: record.model }),
      ...(record.reasoningLevel === null || !isOneOf(REASONING_LEVELS, record.reasoningLevel)
        ? {}
        : { reasoningLevel: record.reasoningLevel }),
      ...(record.serviceTier === null || !isOneOf(SERVICE_TIERS, record.serviceTier)
        ? {}
        : { serviceTier: record.serviceTier }),
      ...(record.permissionMode === null || !isOneOf(PERMISSION_MODES, record.permissionMode)
        ? {}
        : { permissionMode: record.permissionMode }),
    };
  }

  /** How long a rejection-driven revision is waited on. The same 900 s a delegation defaults to. */
  const REVISION_WAIT_MS = 900_000;

  /** Recovery checks one unit may spend. Each one is a whole worker, so this is small. */
  const MAX_CHECK_ATTEMPTS = 2;

  /**
   * How long a check claim holds before another run may take the unit over: long
   * enough for a checker to report within its own wait, short enough that a
   * checker that died without reporting cannot wedge the unit.
   */
  const CHECK_CLAIM_TTL_MS = REVISION_WAIT_MS + 120_000;

  /** Distinguishes two claims taken in the same millisecond. */
  let checkTokenSeq = 0;

  /**
   * Store a check's result on the unit it inspected, and mark the checker it came
   * from as settled, in one write. Acceptance and dependants both read this
   * record, so a check that could not produce a verdict it can stand behind is
   * stored as `rejected` with `problem` naming why: silence must never read as a
   * pass. `checkerId` is the check unit that produced it; a write from a checker
   * a newer attempt replaced is refused, so a stale pass cannot undo a newer
   * failure. Returns whether the result was stored.
   */
  async function storeCheckFor(
    ownerThreadId: string,
    workerId: string,
    checkerId: string | undefined,
    verdict: ReviewVerdict,
    report: string,
    problem: string | null,
    checkerStatus?: string | null,
  ): Promise<boolean> {
    let stored = false;
    await mutateState(ownerThreadId, (current) => {
      const unit = current.delegations.find((delegation) => delegation.threadId === workerId);
      if (unit === undefined || !checkWriteAllowed(unit.verifiedBy, checkerId)) return current;
      stored = true;
      return {
        ...current,
        delegations: current.delegations.map((delegation) => {
          if (delegation.threadId === workerId) {
            return {
              ...delegation,
              check: {
                verdict,
                detail: report.slice(0, 4_000),
                at: Date.now(),
                ...(problem === null ? {} : { problem }),
              },
              // The claim ends with the result it was held for. The binding stays,
              // so a superseded checker's late write is still refused.
              checkClaim: null,
            };
          }
          // A checker that has settled stops counting as running, in the same
          // write that stores what it found.
          if (
            checkerId !== undefined &&
            delegation.threadId === checkerId &&
            checkerStatus !== undefined &&
            checkerStatus !== null
          ) {
            return { ...delegation, status: checkerStatus };
          }
          return delegation;
        }),
      };
    });
    return stored;
  }

  /** A recovery check this process has reserved, before its worker exists. */
  interface CheckReservation {
    /** The claim this run holds until its verdict is stored. */
    token: string;
    /** The attempt number this run spends. */
    attempt: number;
  }

  /**
   * Take a unit's one check slot before its worker starts. The eligibility rules,
   * the attempt budget and the write happen in one serialized mutation, so two
   * concurrent calls cannot both see a free unit and both spawn a checker, and a
   * claim from a live checker blocks a second one. Refusals are returned as text
   * because they are the orchestrator's correction, not an internal failure.
   */
  async function reserveCheck(
    ownerThreadId: string,
    unitId: string,
    liveStatus: string | null,
  ): Promise<CheckReservation | { refuse: string }> {
    // An expired claim is not assumed dead: reconcile it against the checker BB
    // knows before another one may start. This costs a read only once a claim
    // has actually outlived its TTL.
    const stale = await reconcileStaleClaim(ownerThreadId, unitId);
    if (stale !== null) return { refuse: stale };
    const token = `check-${Date.now().toString(36)}-${(checkTokenSeq += 1).toString(36)}`;
    let outcome: CheckReservation | { refuse: string } | null = null;
    await mutateState(ownerThreadId, (current) => {
      const unit = current.delegations.find((entry) => entry.threadId === unitId);
      if (unit === undefined) {
        outcome = { refuse: `This thread has no worker ${unitId}.` };
        return current;
      }
      const claim = unit.checkClaim ?? null;
      if (claim !== null && Date.now() - claim.at < CHECK_CLAIM_TTL_MS) {
        outcome = {
          refuse: `Worker ${unitId} already has a check in flight (${claim.token}), so no second one was started. Wait for it to finish; an expired claim is reconciled against its checker rather than duplicated.`,
        };
        return current;
      }
      const checker = current.delegations.find(
        (entry) => entry.verifierFor === unitId && isRunningStatus(entry.status),
      );
      if (checker !== undefined) {
        outcome = {
          refuse: `A check unit for ${unitId} is still running (${checker.threadId}), so no second one was started. Wait for it to settle.`,
        };
        return current;
      }
      if (liveStatus === "error" || unit.status === "error") {
        outcome = {
          refuse: `Worker ${unitId} ended in error, so there is no finished work to check and nothing may be accepted on its behalf. Re-delegate the unit instead.`,
        };
        return current;
      }
      if (isRunningStatus(liveStatus) || isRunningStatus(unit.status)) {
        outcome = {
          refuse: `Worker ${unitId} is still running (${liveStatus ?? unit.status ?? "unknown"}). Wait for it to settle, then run its check.`,
        };
        return current;
      }
      const resolved = resolvedByOf(unit, current.delegations);
      if (resolved !== null) {
        outcome = {
          refuse: `This unit's chain was already settled by ${resolved}, so its earlier failed check is a fixed finding and is not re-rolled. Reject the unit to have it revised again within the budget.`,
        };
        return current;
      }
      const spent = unit.checkAttempts ?? 0;
      if (spent >= MAX_CHECK_ATTEMPTS) {
        outcome = {
          refuse: `Worker ${unitId} has spent its ${MAX_CHECK_ATTEMPTS} check attempts, so no further check was started. Re-delegate the unit, or judge its output with \`orchestrator_review\`.`,
        };
        return current;
      }
      outcome = { token, attempt: spent + 1 };
      return {
        ...current,
        delegations: current.delegations.map((entry) =>
          entry.threadId === unitId
            ? { ...entry, checkAttempts: spent + 1, checkClaim: { token, at: Date.now() } }
            : entry,
        ),
      };
    });
    return outcome ?? { refuse: `Worker ${unitId} could not be checked.` };
  }

  /**
   * Take only the unit's exclusive claim, for a check whose attempt budget and
   * eligibility its caller already settled (a revision runs its own check right
   * after it starts). The claim is what a recovery call sees in flight, so the
   * two cannot both start a checker for one unit. Returns the refusal text, or
   * null when the claim was taken.
   */
  async function claimCheck(
    ownerThreadId: string,
    unitId: string,
    token: string,
  ): Promise<string | null> {
    // Same rule as a reservation: a stale claim is resolved against its checker,
    // never simply taken over.
    const stale = await reconcileStaleClaim(ownerThreadId, unitId);
    if (stale !== null) return stale;
    let refusal: string | null = null;
    await mutateState(ownerThreadId, (current) => {
      const unit = current.delegations.find((entry) => entry.threadId === unitId);
      if (unit === undefined) return current;
      const claim = unit.checkClaim ?? null;
      if (claim !== null && Date.now() - claim.at < CHECK_CLAIM_TTL_MS) {
        refusal = `Worker ${unitId} already has a check in flight (${claim.token}), so no second one was started. Wait for it to finish; an expired claim is reconciled against its checker rather than duplicated.`;
        return current;
      }
      return {
        ...current,
        delegations: current.delegations.map((entry) =>
          entry.threadId === unitId ? { ...entry, checkClaim: { token, at: Date.now() } } : entry,
        ),
      };
    });
    return refusal;
  }

  /**
   * Hand back a check slot that never produced a check unit. The attempt is
   * refunded because no worker ran; only the reservation this call made is
   * removed, so a claim another call now holds is never cleared underneath it.
   */
  async function releaseCheck(
    ownerThreadId: string,
    unitId: string,
    token: string,
    refund: boolean,
  ): Promise<void> {
    try {
      await mutateState(ownerThreadId, (current) => ({
        ...current,
        delegations: current.delegations.map((entry) =>
          entry.threadId !== unitId || entry.checkClaim?.token !== token
            ? entry
            : {
                ...entry,
                checkClaim: null,
                ...(refund
                  ? { checkAttempts: Math.max(0, (entry.checkAttempts ?? 1) - 1) }
                  : {}),
              },
        ),
      }));
    } catch (cause) {
      bb.log.warn(`check reservation for ${unitId} could not be released: ${String(cause)}`);
    }
  }

  /** Whether a claim token is the reservation a run takes before its worker exists. */
  function isReservationToken(token: string): boolean {
    return token.startsWith("check-");
  }

  /**
   * Name the checker thread on a unit's claim. Written on its own, before the
   * ledger row, so the unit's owner is durable even when that larger write fails:
   * an expired claim can then be resolved against the live thread instead of
   * being mistaken for a dead reservation. Retried once, because losing the name
   * is what lets a second checker start behind a live one.
   */
  async function holdClaim(
    ownerThreadId: string,
    unitId: string,
    token: string,
    checkerId: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mutateState(ownerThreadId, (current) => ({
          ...current,
          delegations: current.delegations.map((entry) =>
            entry.threadId === unitId
              ? { ...entry, checkClaim: { token, at: Date.now(), threadId: checkerId } }
              : entry,
          ),
        }));
        return true;
      } catch (cause) {
        bb.log.warn(
          `check claim for ${unitId} could not name ${checkerId} (attempt ${attempt + 1}): ${String(cause)}`,
        );
      }
    }
    return false;
  }

  /**
   * The unit each unrecorded child names as the one it inspects. A checker is
   * spawned with `checkFor` in its own plugin metadata, which is definitive; a
   * title is not. `null` means BB could not answer, which is not "no owner" — a
   * caller must fall back to a rule that never attributes on a guess.
   */
  async function checkOwnersOf(
    threadIds: readonly string[],
  ): Promise<Map<string, string | null> | null> {
    if (threadIds.length === 0) return new Map();
    try {
      const listed = await bb.sdk.threads.experimental_listPluginMetadata({
        threadIds: [...threadIds],
      });
      const owners = new Map<string, string | null>();
      for (const row of listed.threads) {
        const owner = row.metadata["checkFor"];
        owners.set(row.threadId, typeof owner === "string" ? owner : null);
      }
      return owners;
    } catch (cause) {
      // The metadata route is experimental, so a host that cannot answer must
      // read as "unknown", never as "this checker belongs to nobody".
      bb.log.warn(
        `plugin metadata for ${threadIds.length} child thread(s) could not be read: ${String(cause)}`,
      );
      return null;
    }
  }

  /**
   * The checker a reservation spawned but never recorded. Its own metadata is
   * the only definitive owner: `null` means the run spawned none, and `"unknown"`
   * means BB could not be read — neither releases a claim on a guess.
   * `"ambiguous"` means more than one child could be it, and `"unattributed"`
   * means the only match is by title while the metadata names no unit, so the
   * caller refuses instead of adopting it: one unit's checker must never be
   * stored as another's evidence.
   */
  async function findUnrecordedChecker(
    ownerThreadId: string,
    unit: Delegation,
    since: number,
  ): Promise<string | null | "unknown" | "ambiguous" | "unattributed"> {
    let children: Awaited<ReturnType<typeof bb.sdk.threads.list>>;
    try {
      children = await bb.sdk.threads.list({
        parentThreadId: ownerThreadId,
        includeHidden: true,
        limit: MAX_CHILD_THREADS,
      });
    } catch {
      return "unknown";
    }
    // A full page may omit the checker; never release its claim on a partial list.
    if (children.length >= MAX_CHILD_THREADS) return "unknown";
    const recorded = new Set((await getState(ownerThreadId))?.delegations.map((entry) => entry.threadId) ?? []);
    const unrecorded = children.filter(
      (child) =>
        typeof child.id === "string" &&
        !recorded.has(child.id) &&
        (typeof child.createdAt !== "number" || child.createdAt >= since),
    );
    if (unrecorded.length === 0) return null;
    const owners = await checkOwnersOf(unrecorded.map((child) => child.id as string));
    const title = `${unit.title} (check)`;
    if (owners !== null) {
      // `checkFor` is written at spawn, so it survives a ledger write that did
      // not: it is the one field that says which unit a checker inspects.
      const named = unrecorded.filter((child) => owners.get(child.id as string) === unit.threadId);
      if (named.length === 1) return named[0]!.id;
      if (named.length > 1) return "ambiguous";
      // A readable namespace that names no unit is evidence too: a title-only
      // match is some other unit's child, or a checker from before `checkFor`
      // existed, and neither may be attributed to this unit.
      return unrecorded.some((child) => child.title === title) ? "unattributed" : null;
    }
    // A title is not proof of ownership, even when only one child matches.
    // Keep the claim until BB can provide the checker's metadata.
    return unrecorded.filter((child) => child.title === title).length > 1 ? "ambiguous" : "unknown";
  }

  /**
   * Resolve a check claim that has outlived its TTL before another check may take
   * the unit, and answer with the refusal text when the unit must stay claimed.
   *
   * A claim names its checker as soon as BB spawns one, so expiry is never a
   * guess: a checker that is still running keeps the unit and has its claim
   * refreshed, a checker that settled records the result it actually produced
   * (fail-closed when it left no verdict), and a read BB cannot answer refuses
   * instead of starting a second worker. Only a claim whose run never produced a
   * worker at all is released, so an unrecorded checker is never duplicated and
   * its silence is never read as a pass. When two unrecorded children could be
   * the checker, or a title-only match names no unit while the metadata route
   * answers, the claim is refused rather than attributed by title: another
   * unit's work must never become this unit's evidence.
   */
  async function reconcileStaleClaim(ownerThreadId: string, unitId: string): Promise<string | null> {
    const unit = (await getState(ownerThreadId))?.delegations.find((entry) => entry.threadId === unitId);
    const claim = unit?.checkClaim ?? null;
    if (unit === undefined || claim === null) return null;
    if (Date.now() - claim.at < CHECK_CLAIM_TTL_MS) return null;
    let checkerId = claim.threadId ?? (isReservationToken(claim.token) ? null : claim.token);
    if (checkerId === null) {
      const found = await findUnrecordedChecker(ownerThreadId, unit, claim.at);
      if (found === "unknown") {
        return `Worker ${unitId} still holds check claim ${claim.token}, whose checker cannot be identified because BB's child list is incomplete or ownership metadata could not be read. No second check was started. Inspect the children of this thread, then retry.`;
      }
      if (found === "ambiguous") {
        return `Worker ${unitId} still holds check claim ${claim.token}, and more than one unrecorded child could be its checker, so none was adopted: a title is not proof of which worker a check inspects. No second check was started. Inspect those threads, then judge worker ${unitId} with \`orchestrator_review\` yourself.`;
      }
      if (found === "unattributed") {
        return `Worker ${unitId} still holds check claim ${claim.token}, and the only unrecorded child that matches its check title does not name this unit as the one it checks, so it was not adopted: a title is not proof of what a check inspects. No second check was started. Inspect that thread, then judge worker ${unitId} with \`orchestrator_review\` yourself.`;
      }
      if (found === null) {
        // No worker was ever spawned, so releasing the reservation cannot
        // orphan one. The attempt stays spent: the budget counts runs, not luck.
        await releaseCheck(ownerThreadId, unitId, claim.token, false);
        return null;
      }
      checkerId = found;
      await holdClaim(ownerThreadId, unitId, claim.token, checkerId);
    }
    let status: string | null = null;
    try {
      status = (await bb.sdk.threads.get({ threadId: checkerId })).status ?? null;
    } catch (cause) {
      return `Worker ${unitId}'s check is ${checkerId}, whose status BB could not read (${String(cause)}), so no second check was started. Inspect that thread, then retry.`;
    }
    if (isRunningStatus(status)) {
      await holdClaim(ownerThreadId, unitId, claim.token, checkerId);
      return `The independent check for worker ${unitId} is still running as ${checkerId}, so no second check was started. Wait for it to settle.`;
    }
    let report = "";
    try {
      report = ((await bb.sdk.threads.output({ threadId: checkerId })).output ?? "").trim();
    } catch (cause) {
      bb.log.warn(`recovered check ${checkerId} for ${unitId} left its output unreadable: ${String(cause)}`);
    }
    // Bind the checker before its result, so the record names the checker it came
    // from and a stale write from any other one is refused.
    await mutateState(ownerThreadId, (current) => ({
      ...current,
      delegations: current.delegations.map((entry) =>
        entry.threadId === unitId
          ? {
              ...entry,
              verifiedBy: checkerId,
              checkClaim: { token: claim.token, at: Date.now(), threadId: checkerId },
            }
          : entry,
      ),
    }));
    const parsed = parseCheckVerdict(report);
    const problem =
      parsed.verdict === null ? (parsed.reasoning === "" ? "the check left no verdict" : parsed.reasoning) : null;
    const stored = await storeCheckFor(
      ownerThreadId,
      unitId,
      checkerId,
      parsed.verdict ?? "rejected",
      report,
      problem,
      status,
    );
    if (stored) {
      // `since` keeps a resolution recorded after this checker started: only
      // evidence newer than the check may overrule it.
      await recordChainOutcome(ownerThreadId, unitId, parsed.verdict === "accepted" ? unitId : null, {
        since: claim.at,
      });
      const found =
        parsed.verdict === null
          ? `left no verdict this plugin can trust (${problem}), so it counts as failed`
          : `reported ${parsed.verdict === "accepted" ? "pass" : "fail"}`;
      // Its result is now the unit's evidence, so nothing starts a second check
      // for it. The caller is told what was recovered, not that a new check ran.
      return `The independent check for worker ${unitId} had already run as ${checkerId}. Its result was recovered from that thread — it ${found} — so no second check was started.`;
    }
    // Another checker was bound while this one was read, so its result is not
    // evidence for this unit. Nothing starts behind it either.
    return `Worker ${unitId}'s check claim named ${checkerId}, whose result could not be recorded because a newer check owns the unit now. No second check was started.`;
  }

  /**
   * Record a spawned check unit in its owner's ledger and bind it to the unit it
   * inspects, in one mutation. One write means a failed record cannot leave a
   * checker the ledger does not name; the caller keeps the check claim and its
   * parallel slot when this returns false. Idempotent, so it can be retried.
   */
  async function bindCheck(
    ownerThreadId: string,
    unit: Delegation,
    checker: { id: string; title: string; brief: string; environmentId: string | null },
  ): Promise<boolean> {
    try {
      await mutateState(ownerThreadId, (current) => {
        if (!current.delegations.some((entry) => entry.threadId === unit.threadId)) return current;
        const known = current.delegations.some((entry) => entry.threadId === checker.id);
        const next = known
          ? current.delegations
          : trimDelegations([
              ...current.delegations,
              {
                threadId: checker.id,
                title: checker.title,
                task: checker.brief.slice(0, 20_000),
                createdAt: Date.now(),
                status: null,
                verifierFor: unit.threadId,
                verifiedBy: null,
                verdict: null,
                kind: "review" as const,
                environmentId: checker.environmentId,
                execution: unit.execution ?? null,
              },
            ]);
        return {
          ...current,
          delegations: next.map((entry) =>
            entry.threadId === unit.threadId
              ? {
                  ...entry,
                  verifiedBy: checker.id,
                  checkClaim: { token: checker.id, at: Date.now(), threadId: checker.id },
                }
              : entry,
          ),
          lost: {
            violations: current.lost?.violations ?? 0,
            seenRows: current.lost?.seenRows ?? 0,
            delegations:
              (current.lost?.delegations ?? 0) +
              Math.max(0, current.delegations.length + (known ? 0 : 1) - next.length),
          },
        };
      });
    } catch (cause) {
      bb.log.warn(`check unit ${checker.id} could not be recorded for ${unit.threadId}: ${String(cause)}`);
      return false;
    }
    // The checker's own row names its owner, which is what a scan uses to keep it
    // visible. It does not gate a duplicate check, so a failure here is logged.
    try {
      await mutateState(checker.id, (current) => ({ ...current, workerOf: ownerThreadId }));
    } catch (cause) {
      bb.log.warn(`check unit ${checker.id} could not be linked to ${ownerThreadId}: ${String(cause)}`);
    }
    return true;
  }

  /** What one independent check run produced, and the text to hand the orchestrator. */
  interface IndependentCheck {
    /** The check unit's thread id, when one was spawned at all. */
    id: string | null;
    /** The parsed verdict, or null when no trustworthy one was stored. */
    verdict: ReviewVerdict | null;
    /** The check's report, used as the reviewer's notes for a further revision. */
    report: string;
    /** The check never stored a verdict, so the unit is still pending one. */
    pending: boolean;
    /** Text appended to whatever report the caller is building. */
    text: string;
  }

  /**
   * Run one unit's independent check outside the delegation call that created
   * it. A manual rejection revises a unit from the review path, and a call that
   * was cancelled before its check started leaves a unit that still needs one;
   * both come through here. A check that cannot be started or finished stores no
   * verdict, so the record stays honestly pending and `orchestrator_check` can
   * run it later. A cancelled call never starts a worker.
   *
   * `check` is set by a recovery run: its reservation has already spent one
   * attempt and holds the unit's claim, and an orchestrator-requested check
   * counts against the turn it was asked in.
   */
  async function runIndependentCheck(
    ownerThreadId: string,
    unit: Delegation,
    workerOutput: string | null,
    options: {
      projectId: string;
      signal?: AbortSignal;
      check?: { token: string; countPerTurn: boolean };
    },
  ): Promise<IndependentCheck> {
    const retry = "Run `orchestrator_check` for it once it is idle.";
    const notRun = (why: string): IndependentCheck => ({
      id: null,
      verdict: null,
      report: "",
      pending: true,
      text: `\n\nNo independent check ran (${why}), so worker ${unit.threadId} stays pending its check. ${retry}`,
    });
    // A reservation that never became a worker hands its attempt back, so a
    // refusal or a cancellation cannot burn the unit's check budget. A check the
    // revision path starts holds its own claim instead, which is released
    // without refunding an attempt it never spent.
    let claimToken: string | null = options.check?.token ?? null;
    const refundAttempt = options.check !== undefined;
    const abandoned = async (why: string): Promise<IndependentCheck> => {
      if (claimToken !== null) {
        await releaseCheck(ownerThreadId, unit.threadId, claimToken, refundAttempt);
      }
      return notRun(why);
    };
    if (disposed || (options.signal !== undefined && options.signal.aborted)) {
      return await abandoned("the call was cancelled");
    }
    // The revision path has no caller-side reservation, so the claim is taken
    // here — before any budget call or spawn — and a concurrent recovery sees it
    // in flight instead of starting a second checker for the same revision.
    if (options.check === undefined) {
      const token = `check-${Date.now().toString(36)}-${(checkTokenSeq += 1).toString(36)}`;
      const refusal = await claimCheck(ownerThreadId, unit.threadId, token);
      if (refusal !== null) return notRun(refusal);
      claimToken = token;
    }
    const settings = settingsFor(options.projectId);
    const countPerTurn = options.check?.countPerTurn === true;
    const exec = executionFromRecord(unit.execution);
    const brief = buildVerifierBrief({ task: unit.task, workerTitle: unit.title, workerOutput });
    // One check is one more worker, so the fan-out cap bounds it too. No claim
    // is held when this refuses, so nothing has to be handed back.
    try {
      await assertWithinBudget(ownerThreadId, countPerTurn, options.projectId);
    } catch (cause) {
      return await abandoned(cause instanceof Error ? cause.message : String(cause));
    }
    // A cancellation that landed while the slot was being taken must not start
    // a worker; both slots go back.
    if (disposed || (options.signal !== undefined && options.signal.aborted)) {
      releaseClaim(ownerThreadId, countPerTurn);
      return await abandoned("the call was cancelled while its check was being set up");
    }
    let verifierId: string;
    let tracked = false;
    try {
      const thread = await bb.sdk.threads.spawn({
        projectId: options.projectId,
        parentThreadId: ownerThreadId,
        title: `${unit.title} (check)`,
        prompt: brief,
        ...exec,
        ...(Object.keys(exec).length === 0 ? {} : { executionInputSources: executionSources(exec) }),
        // `checkFor` is definitive ownership, written before the ledger row, so a
        // failed record leaves BB able to say which unit this checker inspects.
        pluginMetadata: { workerFor: ownerThreadId, checkFor: unit.threadId },
        environment:
          unit.environmentId === null || unit.environmentId === undefined
            ? { type: "project-default" }
            : { type: "reuse", environmentId: unit.environmentId },
      });
      verifierId = thread.id;
      // Name the checker on the unit's claim before the larger ledger write:
      // the claim survives a failed record and is what a later call reconciles
      // against, so a live checker is never mistaken for a dead reservation.
      if (claimToken !== null) {
        await holdClaim(ownerThreadId, unit.threadId, claimToken, thread.id);
      }
      // One retry: a single failed ledger write must not leave a checker the
      // ledger does not name.
      for (let attempt = 0; attempt < 2 && !tracked; attempt += 1) {
        tracked = await bindCheck(ownerThreadId, unit, {
          id: thread.id,
          title: `${unit.title} (check)`,
          brief,
          environmentId: thread.environmentId ?? null,
        });
      }
    } catch (cause) {
      // The spawn itself failed, so no worker exists and both slots go back.
      releaseClaim(ownerThreadId, countPerTurn);
      bb.log.warn(`check unit for ${unit.threadId} could not start: ${String(cause)}`);
      return await abandoned(String(cause));
    }
    if (!tracked) {
      // The checker exists but the ledger does not name it. Its durable claim is
      // what stops a second check, so the process-local reservation is not kept:
      // one failed ledger write must not spend a parallel slot for the life of
      // the process. It keeps counting while it runs, though, through the stray
      // map, so releasing the reservation cannot let the cap be exceeded.
      releaseClaim(ownerThreadId, countPerTurn);
      strayCheckers.set(verifierId, { ownerThreadId, countPerTurn });
      bb.log.warn(`check unit ${verifierId} for ${unit.threadId} is running unrecorded`);
      return {
        id: verifierId,
        verdict: null,
        report: "",
        pending: true,
        text: `\n\nCheck unit ${verifierId} started for worker ${unit.threadId}, but this thread's record could not be written, so it is not listed among the workers. It still counts against the parallel cap while it runs, and the unit stays claimed: do not start another check. Inspect ${verifierId} directly, and judge worker ${unit.threadId} yourself once it reports.`,
      };
    }
    // Released only after the record lands, so the check counts against the cap
    // from the moment it is visible.
    releaseClaim(ownerThreadId, countPerTurn);
    const checkStartedAt = Date.now();
    const checked = await waitForWorker(verifierId, REVISION_WAIT_MS, {
      ownerThreadId,
      maxResumes: settings.maxStallResumes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const report = (checked.output ?? "").trim();
    // A check still running has not reported, so storing anything for it would
    // invent evidence. The record stays pending and the claim stays with it, so
    // a second check cannot start while this one is still live.
    if (checked.running) {
      return {
        id: verifierId,
        verdict: null,
        report,
        pending: true,
        text: `\n\nThe independent check for worker ${unit.threadId} is still running as ${verifierId}, so that unit stays pending its check. ${retry}`,
      };
    }
    const parsed = parseCheckVerdict(report);
    const passes = parsed.verdict === "accepted";
    const problem =
      parsed.verdict === null ? (parsed.reasoning === "" ? "the check left no verdict" : parsed.reasoning) : null;
    const stored = await storeCheckFor(
      ownerThreadId,
      unit.threadId,
      verifierId,
      parsed.verdict ?? "rejected",
      report,
      problem,
      checked.status,
    );
    if (!stored) {
      // A newer attempt owns this unit now, so this result is not evidence for
      // it. It was stored by the current check or not at all.
      return {
        id: verifierId,
        verdict: parsed.verdict,
        report,
        pending: true,
        text: `\n\nCheck unit ${verifierId} finished, but a newer check now owns worker ${unit.threadId}, so this result was not recorded. Its claim still decides that unit's check.`,
      };
    }
    // A chain's outcome follows its latest check: a pass settles it, a fail
    // takes the earlier resolution back. Recovery only runs for a chain that has
    // no resolution, so a stale check cannot revoke a settled one.
    await recordChainOutcome(ownerThreadId, unit.threadId, passes ? unit.threadId : null, {
      since: checkStartedAt,
    });
    // The checker is evidence for this unit, so retention and the ledger keep it
    // like any other check unit once it has reported.
    try {
      await recordResolved(ownerThreadId, verifierId);
      await maybeArchive(ownerThreadId, verifierId);
    } catch (cause) {
      bb.log.warn(`check unit ${verifierId} could not be tidied up: ${String(cause)}`);
    }
    const verdictText =
      parsed.verdict === null
        ? `The check left no verdict this plugin can trust (${problem}), so it counts as failed.`
        : `The check's verdict is ${passes ? "pass" : "fail"}.`;
    const next =
      passes
        ? " This settles the chain: earlier attempts in it can be accepted and dependent units can start on it."
        : " Reject this unit to have it revised again within the budget, or re-delegate it yourself.";
    return {
      id: verifierId,
      verdict: parsed.verdict,
      report,
      pending: false,
      text: `\n\nCheck unit ${verifierId} ran the same brief. ${verdictText}${next}${
        report === ""
          ? " It produced no final text, so its check is recorded as failed."
          : `\n\n${report.length > 8_000 ? `${report.slice(0, 8_000)}\n\n[truncated]` : report}`
      }`,
    };
  }

  /**
   * Run the independent check a unit is still waiting for. Only a record whose
   * check never produced a verdict it can stand behind is eligible: a stored
   * pass or fail is evidence, not something to re-roll.
   */
  async function recoverCheck(
    ownerThreadId: string,
    workerThreadId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = await getState(ownerThreadId);
    const unit = state?.delegations.find((entry) => entry.threadId === workerThreadId);
    if (unit === undefined) {
      throw new Error(`This thread has no worker ${workerThreadId}.`);
    }
    if (unit.verifierFor !== undefined) {
      throw new Error(
        `Worker ${workerThreadId} is itself a check unit: it is evidence for the unit it inspected, and is never checked itself.`,
      );
    }
    if (unit.verify !== true) {
      throw new Error(
        `Worker ${workerThreadId} never asked for an independent check, so there is none to run. Judge it with \`orchestrator_review\`.`,
      );
    }
    if (unit.check !== null && unit.check !== undefined && (unit.check.problem === null || unit.check.problem === undefined)) {
      throw new Error(
        `Worker ${workerThreadId} already has a check this plugin can trust (${unit.check.verdict}). Record a verdict on it, or reject it to have it revised.`,
      );
    }
    let status = unit.status;
    try {
      status = (await bb.sdk.threads.get({ threadId: workerThreadId })).status;
    } catch {
      // The stored status is the last fact; running it on an unknown status is
      // still bounded by the check unit's own wait.
    }
    if (isRunningStatus(status)) {
      throw new Error(
        `Worker ${workerThreadId} is still running (${status ?? "unknown"}). Wait for it to settle, then run its check.`,
      );
    }
    if (status === "error") {
      throw new Error(
        `Worker ${workerThreadId} ended in error, so there is no finished work to check and nothing may be accepted on its behalf. Re-delegate the unit instead.`,
      );
    }
    let output: string | null = null;
    try {
      output = (await bb.sdk.threads.output({ threadId: workerThreadId })).output ?? null;
    } catch (cause) {
      bb.log.warn(`worker output read failed for ${workerThreadId}: ${String(cause)}`);
    }
    const projectId =
      (await projectOfThread(ownerThreadId)) ??
      (await bb.sdk.threads.get({ threadId: ownerThreadId })).projectId;
    // The slot is taken atomically, before any worker starts: a second call, or a
    // check unit an earlier call left running, is refused instead of racing this
    // one, and a chain a later revision settled is never re-rolled.
    const reserved = await reserveCheck(ownerThreadId, workerThreadId, status);
    if ("refuse" in reserved) throw new Error(reserved.refuse);
    const check = await runIndependentCheck(ownerThreadId, unit, output, {
      projectId,
      check: { token: reserved.token, countPerTurn: true },
      ...(signal === undefined ? {} : { signal }),
    });
    return check.text.trim();
  }

  /**
   * The original unit a record belongs to: the root of its revision chain. A
   * revision names its root when it is written; a record stored by an older build
   * is followed through `revisionOf`, and one whose parent was trimmed is treated
   * as its own root.
   */
  function chainRootOf(entry: Delegation, delegations: readonly Delegation[]): string {
    if (entry.revisionRoot !== null && entry.revisionRoot !== undefined && entry.revisionRoot !== "") {
      return entry.revisionRoot;
    }
    let current = entry;
    const seen = new Set<string>([entry.threadId]);
    for (;;) {
      const parentId = current.revisionOf ?? null;
      if (parentId === null || seen.has(parentId)) return current.threadId;
      seen.add(parentId);
      const parent = delegations.find((candidate) => candidate.threadId === parentId);
      if (parent === undefined) return parentId;
      current = parent;
    }
  }

  function rootRecordOf(delegation: Delegation, delegations: readonly Delegation[]): Delegation {
    const rootId = chainRootOf(delegation, delegations);
    return delegations.find((entry) => entry.threadId === rootId) ?? delegation;
  }

  /**
   * The revision that settled this chain, when one did: its own check passed or
   * the orchestrator accepted it. A resolved chain is what turns the original's
   * failed check into a fixed finding instead of a permanent refusal.
   */
  function resolvedByOf(delegation: Delegation, delegations: readonly Delegation[]): string | null {
    return rootRecordOf(delegation, delegations).resolvedBy ?? null;
  }

  /**
   * Why a worker cannot be accepted or used as a dependency, or null when its
   * check passed or its chain was resolved by a later attempt. A check that left
   * no usable verdict is stored as `rejected` with the reason in `problem`, so an
   * unparseable report blocks instead of reading as success.
   */
  function checkBlockReason(delegation: Delegation, delegations: readonly Delegation[]): string | null {
    const check = delegation.check;
    if (check === null || check === undefined) {
      // A unit that asked for an independent check and has no stored verdict is
      // unverified, not passed: a call cancelled or a plugin disposed before the
      // checker started leaves exactly this record. Reading it as success would
      // let a later acceptance or dependent unit rely on a check that never ran.
      return delegation.verify === true && resolvedByOf(delegation, delegations) === null
        ? "its independent check never ran"
        : null;
    }
    if (check.verdict === "accepted") return null;
    if (resolvedByOf(delegation, delegations) !== null) return null;
    return check.problem === null || check.problem === undefined
      ? "it failed its independent check"
      : `its independent check left no verdict this plugin can trust (${check.problem})`;
  }

  /**
   * Record the chain's outcome on its root: the attempt whose own check passed or
   * that the orchestrator accepted, or nothing when a later attempt failed.
   * `undefined` leaves it alone, for a check that has not reported yet. `since`
   * is when the check that is reporting started: a resolution recorded after it
   * is newer evidence and is not taken back by a result from before it.
   */
  async function recordChainOutcome(
    ownerThreadId: string,
    workerId: string,
    resolvedBy: string | null | undefined,
    options: { since?: number } = {},
  ): Promise<void> {
    if (resolvedBy === undefined) return;
    await mutateState(ownerThreadId, (current) => {
      const worker = current.delegations.find((entry) => entry.threadId === workerId);
      if (worker === undefined) return current;
      const root = rootRecordOf(worker, current.delegations);
      // The root's own passing check is the chain's own check: nothing to reconcile.
      if (root.threadId === workerId && resolvedBy !== null) return current;
      if ((root.resolvedBy ?? null) === resolvedBy) return current;
      // A failure from a check that was already running when the chain was
      // settled does not unsettle it: that resolution is the newer evidence.
      if (
        resolvedBy === null &&
        root.resolvedBy !== null &&
        root.resolvedBy !== undefined &&
        options.since !== undefined &&
        (root.resolvedAt ?? 0) > options.since
      ) {
        return current;
      }
      const resolvedAt = resolvedBy === null ? null : Date.now();
      return {
        ...current,
        delegations: current.delegations.map((entry) =>
          entry.threadId === root.threadId ? { ...entry, resolvedBy, resolvedAt } : entry,
        ),
      };
    });
  }

  /**
   * Take the next revision slot on a unit chain. The read, the budget check and
   * the increment happen inside one serialized mutation, so two concurrent
   * rejections cannot both see the same spent count. The count lives on the
   * chain's root, so an automatic check-driven revision, a later manual rejection
   * of any member, and a revision of a revision all spend one budget. Returns the
   * chain depth — revisions now spent — and the root it was claimed on, or null
   * when the cap is already reached. A claim also clears the chain's resolution:
   * the outcome is unsettled until an attempt passes its check or is accepted.
   */
  async function claimRevision(
    ownerThreadId: string,
    parentThreadId: string,
    maxRevisions: number,
  ): Promise<{
    depth: number;
    rootId: string;
    previousResolvedBy: string | null;
    previousResolvedAt: number | null;
  } | null> {
    let claim: {
      depth: number;
      rootId: string;
      previousResolvedBy: string | null;
      previousResolvedAt: number | null;
    } | null = null;
    await mutateState(ownerThreadId, (current) => {
      const parent = current.delegations.find((entry) => entry.threadId === parentThreadId);
      if (parent === undefined) return current;
      // A trimmed root still has a figure through the revision's own snapshot.
      const root = rootRecordOf(parent, current.delegations);
      const spent = root.revisions ?? parent.revisions ?? 0;
      if (spent >= maxRevisions) return current;
      const depth = spent + 1;
      // Kept so a revision that never starts hands the chain's prior resolution
      // back instead of leaving a settled chain permanently unsettled.
      claim = {
        depth,
        rootId: root.threadId,
        previousResolvedBy: root.resolvedBy ?? null,
        previousResolvedAt: root.resolvedAt ?? null,
      };
      return {
        ...current,
        delegations: current.delegations.map((entry) =>
          entry.threadId === root.threadId
            ? { ...entry, revisions: depth, resolvedBy: null, resolvedAt: null }
            : entry,
        ),
      };
    });
    return claim;
  }

  /**
   * Hand a claimed revision slot back when the revision never started, and
   * restore the chain resolution the claim cleared. The prior resolution is not
   * restored when it was the rejected record itself: an explicit rejection of
   * the attempt that settled a chain leaves it unsettled, which is what the
   * rejection means. Nothing is restored over a resolution recorded meanwhile.
   */
  async function releaseRevision(
    ownerThreadId: string,
    parentThreadId: string,
    previousResolvedBy: string | null = null,
    previousResolvedAt: number | null = null,
  ): Promise<void> {
    await mutateState(ownerThreadId, (current) => {
      const parent = current.delegations.find((entry) => entry.threadId === parentThreadId);
      if (parent === undefined) return current;
      const root = rootRecordOf(parent, current.delegations);
      const restore =
        previousResolvedBy !== null &&
        previousResolvedBy !== parent.threadId &&
        (root.resolvedBy ?? null) === null;
      return {
        ...current,
        delegations: current.delegations.map((entry) =>
          entry.threadId === root.threadId
            ? {
                ...entry,
                revisions: Math.max(0, (entry.revisions ?? 0) - 1),
                ...(restore ? { resolvedBy: previousResolvedBy, resolvedAt: previousResolvedAt } : {}),
              }
            : entry,
        ),
      };
    });
  }

  /**
   * Re-delegate a rejected build unit on its recorded execution, carrying the
   * reviewer's notes into the brief. Bounded by the scope's revision budget and
   * by the unit's own record of what it has already spent, so a rejection cannot
   * turn into a loop; bounded by the fan-out cap as well, because a revision is
   * still a running worker. Returns the text to append to the verdict, or ""
   * when no revision was warranted.
   */
  async function reviseRejected(
    ownerThreadId: string,
    delegation: Delegation,
    notes: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    // The same rule the check loop uses: a build is checked by default, and any
    // unit that asked for `verify: true` is revised on a rejection too. A unit
    // outside that rule is told so instead of being refused in silence, which
    // is what invited a duplicate delegation.
    if (delegation.kind !== "build" && delegation.verify !== true) {
      return "\nNo revision ran: this unit is not a build and has no independent check, so re-delegate it yourself with the findings.";
    }
    if (notes === undefined || notes.trim() === "") {
      return "\nNo revision ran: record the reviewer's findings in `notes`, and a rejected build unit is re-delegated with them.";
    }
    const projectId =
      (await projectOfThread(ownerThreadId)) ??
      (await bb.sdk.threads.get({ threadId: ownerThreadId })).projectId;
    const settings = settingsFor(projectId);
    if (disposed || (signal !== undefined && signal.aborted)) {
      return "\nNo revision ran: the review call was cancelled. Record the verdict again to re-delegate it.";
    }
    const claim = await claimRevision(ownerThreadId, delegation.threadId, settings.maxRevisions);
    if (claim === null) {
      return `\nNo revision ran: this unit has spent its ${settings.maxRevisions}-revision budget. Re-delegate the unit yourself with a new brief.`;
    }
    const depth = claim.depth;
    const exec = executionFromRecord(delegation.execution);
    // The rejected attempt did report: the orchestrator read that report and
    // rejected it with `notes`. Telling the revision it reported nothing would
    // make it guess at what already exists, so the final text is carried across
    // (trimmed by the brief builder). Only the reason a read failed is logged —
    // the report itself is worker text and may hold anything, so it never
    // reaches a log line.
    let previousOutput: string | null = null;
    try {
      previousOutput = (await bb.sdk.threads.output({ threadId: delegation.threadId })).output ?? null;
    } catch (cause) {
      bb.log.warn(
        `the report of rejected worker ${delegation.threadId} could not be read: ${String(cause)}`,
      );
    }
    const brief = buildRevisionBrief({
      task: delegation.task,
      workerTitle: delegation.title,
      previousOutput,
      notes: notes.trim(),
    });
    let spawned!: { id: string; environmentId: string | null };
    let startedId: string | null = null;
    // The revision consumes a parallel slot like any other worker, so the
    // fan-out cap bounds it too.
    try {
      await assertWithinBudget(ownerThreadId, false, projectId);
    } catch (cause) {
      // No budget was checked against a held claim, so only the chain slot goes
      // back.
      await releaseRevision(ownerThreadId, delegation.threadId, claim.previousResolvedBy, claim.previousResolvedAt);
      bb.log.warn(`revision for ${delegation.threadId} could not start: ${String(cause)}`);
      return `\nNo revision ran: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    // A call cancelled while the slot was being claimed must not start a worker.
    // Both slots go back here: the parallel claim taken above and the chain
    // revision, which is why this return cannot be left to the later finally.
    if (disposed || (signal !== undefined && signal.aborted)) {
      releaseClaim(ownerThreadId, false);
      await releaseRevision(ownerThreadId, delegation.threadId, claim.previousResolvedBy, claim.previousResolvedAt);
      return `\nNo revision ran: the review call was cancelled while revision ${depth} was being set up. Record the verdict again to re-delegate it.`;
    }
    try {
      const args: Parameters<typeof bb.sdk.threads.spawn>[0] = {
        projectId,
        parentThreadId: ownerThreadId,
        title: `${delegation.title} (revision ${depth})`,
        prompt: brief,
        ...exec,
        ...(Object.keys(exec).length === 0 ? {} : { executionInputSources: executionSources(exec) }),
        pluginMetadata: { workerFor: ownerThreadId },
        // The unit's own checkout when it had one, so a revision continues the
        // working tree it is fixing instead of opening a second one.
        environment:
          delegation.environmentId === null || delegation.environmentId === undefined
            ? { type: "project-default" }
            : { type: "reuse", environmentId: delegation.environmentId },
      };
      const thread = await bb.sdk.threads.spawn(args);
      startedId = thread.id;
      spawned = { id: thread.id, environmentId: thread.environmentId ?? null };
      await mutateState(spawned.id, (current) => ({ ...current, workerOf: ownerThreadId }));
      await mutateState(ownerThreadId, (current) => {
        const next = trimDelegations([
          ...current.delegations,
          {
            threadId: spawned.id,
            title: `${delegation.title} (revision ${depth})`,
            task: brief.slice(0, 20_000),
            createdAt: Date.now(),
            status: null,
            revisionOf: delegation.threadId,
            revisionRoot: claim.rootId,
            revisions: depth,
            ...(delegation.verify === true ? { verify: true } : {}),
            kind: delegation.kind ?? ("build" as const),
            environmentId: spawned.environmentId,
            execution: delegation.execution ?? null,
          },
        ]);
        return {
          ...current,
          delegations: next,
          lost: {
            violations: current.lost?.violations ?? 0,
            seenRows: current.lost?.seenRows ?? 0,
            delegations:
              (current.lost?.delegations ?? 0) +
              Math.max(0, current.delegations.length + 1 - next.length),
          },
        };
      });
    } catch (cause) {
      // The revision never landed, so the chain slot is handed back and the
      // reason is reported instead of thrown away.
      await releaseRevision(ownerThreadId, delegation.threadId, claim.previousResolvedBy, claim.previousResolvedAt);
      bb.log.warn(`revision for ${delegation.threadId} could not start: ${String(cause)}`);
      const why = cause instanceof Error ? cause.message : String(cause);
      return startedId === null
        ? `\nNo revision ran: the revision worker could not start (${why}). Re-delegate the unit yourself.`
        : `\nThe revision started as worker ${startedId} but could not be recorded (${why}). Check it before re-delegating.`;
    } finally {
      // Released only after the record lands, so a check queued in between sees
      // the running revision instead of a free slot and passing at cap - 1.
      releaseClaim(ownerThreadId, false);
    }
    const settled = await waitForWorker(spawned.id, REVISION_WAIT_MS, {
      ownerThreadId,
      maxResumes: settings.maxStallResumes,
      ...(signal === undefined ? {} : { signal }),
    });
    await mutateState(ownerThreadId, (current) => ({
      ...current,
      delegations: current.delegations.map((entry) =>
        entry.threadId === spawned.id ? { ...entry, status: settled.status } : entry,
      ),
    }));
    await recordResolved(ownerThreadId, spawned.id);
    const body = (settled.output ?? "").trim();
    const head = `\n\nRe-delegated the rejected unit as revision ${depth}: worker ${spawned.id}${
      settled.running ? " (still running)" : ` (status ${settled.status ?? "unknown"})`
    }.`;
    // The revision carries the unit's `verify: true`, so it owes an independent
    // check of its own. Running it here is what keeps a manually revised unit
    // acceptable: a record that asks for a check and never gets one is refused
    // forever. A revision that has not finished leaves the check pending, which
    // `orchestrator_check` can run once it settles.
    const check =
      settled.running || settled.status === "error"
        ? null
        : await runIndependentCheck(ownerThreadId, {
            ...delegation,
            threadId: spawned.id,
            title: `${delegation.title} (revision ${depth})`,
            task: brief.slice(0, 20_000),
            environmentId: spawned.environmentId,
          }, settled.output, { projectId, ...(signal === undefined ? {} : { signal }) });
    const checkNote =
      check !== null
        ? check.text
        : `\n\nThe revision is not finished, so its independent check has not run yet. Run \`orchestrator_check\` for ${spawned.id} once it settles; until then it cannot be accepted and no dependent unit may start on it.`;
    return `${head}${checkNote}\n\n${body === "" ? "(the revision produced no final text; open it before you judge it)" : body.length > 8_000 ? `${body.slice(0, 8_000)}\n\n[truncated]` : body}`;
  }

  /**
   * Archive a worker the retention policy covers. Called where the plugin learns
   * the orchestrator has read a result: when it settles a worker it was waiting
   * on, and when a verdict is recorded. The second place matters because a
   * delegation made with `waitForResult: false` is never settled here, and
   * retention that only worked for waited delegations would be a trap.
   */
  async function maybeArchive(ownerThreadId: string, workerId: string): Promise<void> {
    const retention = settingsFor(await projectOfThread(ownerThreadId)).workerRetention;
    if (retention === "keep") return;
    const state = await getState(ownerThreadId);
    const delegation = state?.delegations.find((entry) => entry.threadId === workerId);
    if (delegation === undefined) return;
    if (retention === "archive-checks" && delegation.verifierFor === undefined) {
      return;
    }
    try {
      await bb.sdk.threads.archive({ threadId: workerId });
      bb.log.info(`archived worker ${workerId} (retention: ${retention})`);
    } catch (cause) {
      bb.log.warn(`could not archive worker ${workerId}: ${String(cause)}`);
    }
  }

  /**
   * Refuse a delegation that would exceed either fan-out cap. Both counts come
   * from this plugin's own records, so the orchestrator is told which cap it hit
   * and what to do about it.
   */
  async function assertWithinBudget(
    threadId: string,
    countPerTurn: boolean,
    projectId: string,
  ): Promise<void> {
    const settings = settingsFor(projectId);
    // Inside the write queue, and counting the claims already in flight: a check
    // that reads the state beside another claim lets two simultaneous
    // delegations both pass their cap.
    await enqueue(async () => {
      const state = await getState(threadId);
      if (state === undefined) return;
      // A checker whose ledger row never landed is still a running worker; it is
      // counted here until BB reports it settled, so releasing its process-local
      // slot did not bypass the cap either.
      await pruneStrayCheckers(threadId, state);
      const strays = [...strayCheckers.values()].filter((entry) => entry.ownerThreadId === threadId);
      const pending = pendingClaims.get(threadId) ?? { parallel: 0, turn: 0 };
      if (settings.maxParallelWorkers > 0) {
        // A timed-out worker keeps its status (`active`), so counting only
        // `null` let every delegation past a deadline escape the cap.
        const inFlight =
          state.delegations.filter((delegation) => isRunningStatus(delegation.status)).length +
          pending.parallel +
          strays.length;
        if (inFlight >= settings.maxParallelWorkers) {
          throw new WorkerBudgetError(
            `${inFlight} workers are still running and this plugin caps parallel workers at ${settings.maxParallelWorkers}. Wait for one to finish, or raise maxParallelWorkers (0 removes the cap).`,
          );
        }
      }
      // The per-turn cap governs what the orchestrator chose to fan out. A check
      // unit or a fallback retry is this plugin's own decision, and counting it
      // would let a tight cap silently defeat `verify: true`.
      if (countPerTurn && settings.maxDelegationsPerTurn > 0) {
        // Until the first dispatch of a session there is no turn yet, so the
        // window starts when the mode was enabled rather than being ignored.
        const enabledAtMs = state.enabledAt === null ? 0 : Date.parse(state.enabledAt);
        const since = Math.max(state.turnStartedAt, Number.isNaN(enabledAtMs) ? 0 : enabledAtMs);
        const thisTurn =
          state.delegations.filter((delegation) => delegation.createdAt >= since).length +
          pending.turn +
          strays.filter((entry) => entry.countPerTurn).length;
        if (thisTurn >= settings.maxDelegationsPerTurn) {
          throw new WorkerBudgetError(
            `This turn has delegated ${thisTurn} workers and this plugin caps a turn at ${settings.maxDelegationsPerTurn}. Fold what came back into a report, or raise maxDelegationsPerTurn (0 removes the cap).`,
          );
        }
      }
      reserveClaim(threadId, countPerTurn);
    });
  }

  /**
   * The marker for the unjudged set when a reminder is due, or undefined when the
   * gate is closed: not enabled, instruct level, nothing unjudged, already
   * reminded for this set, or out of reminders.
   */
  function reviewNudgeMarker(state: ThreadState, maxNudges: number): string | undefined {
    if (!state.enabled) return undefined;
    if (effectiveEnforcement(state) === "instruct") return undefined;
    const unreviewed = unreviewedOf(state.delegations);
    if (unreviewed.length === 0) return undefined;
    const marker = unreviewed
      .map((delegation) => delegation.threadId)
      .sort()
      .join(",");
    if (state.lastReviewNudge === marker) return undefined;
    if (state.nudgeCount >= maxNudges) return undefined;
    return marker;
  }

  /**
   * The review gate: a turn that ended with workers nobody judged gets one
   * reminder, and only while its orchestrator is idle, since a nudge sent mid-turn
   * would queue behind the very work it is asking about.
   *
   * A finished turn cannot be stopped after the fact, so `block` behaves as
   * `guard` here. That limit is documented rather than papered over.
   *
   * It draws on the same per-thread reminder budget as the watchdog: one budget for
   * corrections, whichever gate spends it, which `describeState` now reports split
   * by gate.
   */
  async function checkReviews(threadId: string): Promise<void> {
    const maxNudges = settingsFor(await projectOfThread(threadId)).maxNudges;
    // Cheap guard first: an unrelated idle event should not cost a thread read.
    const before = await getState(threadId);
    if (reviewNudgeMarker(before ?? emptyState(Date.now()), maxNudges) === undefined) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "idle" && thread.status !== "error") return;
    } catch (cause) {
      bb.log.warn(`review gate could not read ${threadId}: ${String(cause)}`);
      return;
    }
    // Claim inside the serialized mutation: two events for the same unjudged set
    // must not both send a reminder and spend two of the budget.
    let claimed: { titles: string[]; count: number; marker: string; enforcement: EnforcementLevel } | undefined;
    await mutateState(threadId, (current) => {
      const marker = reviewNudgeMarker(current, maxNudges);
      if (marker === undefined) return current;
      const unreviewed = unreviewedOf(current.delegations);
      claimed = {
        titles: unreviewed.map((delegation) => delegation.title),
        count: unreviewed.length,
        marker,
        enforcement: effectiveEnforcement(current),
      };
      return {
        ...current,
        nudgeCount: current.nudgeCount + 1,
        reviewNudges: current.reviewNudges + 1,
        lastReviewNudge: marker,
      };
    });
    if (claimed === undefined) return;
    const { titles, count, marker, enforcement } = claimed;
    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: buildReviewNudge(titles, enforcement),
            mentions: [],
          },
        ],
      });
      bb.log.warn(`${threadId} ended a turn with ${count} unjudged worker(s)`);
    } catch (cause) {
      bb.log.warn(`review nudge failed for ${threadId}: ${String(cause)}`);
      // Give the reminder back: the marker would otherwise mute the gate for this set.
      await mutateState(threadId, (current) =>
        current.lastReviewNudge === marker
          ? {
              ...current,
              nudgeCount: Math.max(0, current.nudgeCount - 1),
              reviewNudges: Math.max(0, current.reviewNudges - 1),
              lastReviewNudge: null,
            }
          : current,
      ).catch(() => undefined);
    }
  }

  // --- RPC -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    get_state: async ({ threadId }) => {
      const state = await refreshWorkerRecords(threadId, await getState(threadId));
      return toDto(
        threadId,
        state,
        await childCountsOf(threadId),
        settingsFor(await projectOfThread(threadId)),
        retainedThreadCount(),
      );
    },
    set_enabled: async ({ threadId, enabled, enforcement }) => {
      const state = await setEnabled(threadId, enabled, enforcement ?? null);
      return toDto(
        threadId,
        state,
        await childCountsOf(threadId),
        settingsFor(await projectOfThread(threadId)),
        retainedThreadCount(),
      );
    },
    get_default: async () => ({ enabled: live.defaultForNewThreads }),
    set_default: async ({ enabled }) => ({ enabled: await setDefault(enabled) }),
    get_contract: async ({ threadId }) => ({
      text: await contractText(threadId),
      extra: extraInstructions,
      limit: EXTRA_INSTRUCTION_LIMIT,
    }),
    set_contract: async ({ extra }) => {
      // Store first: the returned text has to be the text this write produced,
      // not the one it replaced.
      const stored = await setExtraInstructions(extra);
      return { text: await contractText(null), extra: stored, limit: EXTRA_INSTRUCTION_LIMIT };
    },
    get_worker_execution: async () => live.worker,
    get_project_worker: async ({ projectId }) => workerFor(projectId),
    set_project_worker: async ({ projectId, config }) => writeProjectWorker(projectId, config),
    get_project_rules: async ({ projectId }) => ({
      text: await contractText(null, projectId),
      extra: rulesFor(projectId),
      limit: EXTRA_INSTRUCTION_LIMIT,
    }),
    set_project_rules: async ({ projectId, extra }) => {
      await writeProjectRules(projectId, extra);
      return {
        text: await contractText(null, projectId),
        extra: rulesFor(projectId),
        limit: EXTRA_INSTRUCTION_LIMIT,
      };
    },
    get_scope_settings: async ({ projectId }) => scopeSettings(projectId),
    set_scope_setting: async ({ projectId, key, value }) => {
      if (projectId === null) {
        // The global record always carries a value, so there is nothing to clear:
        // an inherit click at that scope would have nowhere to fall back to.
        if (value === null) {
          throw new Error("The global scope has no inherited value to fall back to; send the value to store.");
        }
        // A computed key widens the literal to an index signature, which only the
        // cast narrows back; the schema above already checked the key.
        await writeSettings({ [key]: value } as Partial<OrchestratorSettings>);
      } else {
        const current = { ...(projectSettings[projectId] ?? {}) };
        if (value === null) delete current[key];
        else Object.assign(current, { [key]: value });
        await writeProjectSettings(projectId, current);
      }
      return scopeSettings(projectId);
    },
    get_judge: async () => ({ configured: await judgeKeyConfigured() }),
    set_worker_execution: async (next) => setWorkerConfig(next),
    clear_violations: async ({ threadId }) => {
      const state = await clearViolations(threadId);
      return toDto(
        threadId,
        state,
        await childCountsOf(threadId),
        settingsFor(await projectOfThread(threadId)),
        retainedThreadCount(),
      );
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

  /**
   * The settings flags a `scope` call names, in the stored shape. One mapping for
   * both scopes, so a flag cannot mean one field at the global scope and another
   * at a project's.
   */
  interface ScopeSettingsFlags {
    enforcement?: EnforcementLevel;
    "read-commands"?: "on" | "off";
    "max-nudges"?: number;
    "max-parallel"?: number;
    "max-per-turn"?: number;
    "contract-preset"?: ContractPresetId;
    "model-policy"?: WorkerModelPolicy;
    retention?: WorkerRetention;
    "worker-workspace"?: WorkerWorkspace;
    "child-messages"?: "queued" | "immediate";
    "orchestrator-subagents"?: OrchestratorSubagentPolicy;
    "worker-subagents"?: WorkerSubagentPolicy;
    "max-revisions"?: number;
    "max-stall-resumes"?: number;
    "judge-advisory"?: "on" | "off";
  }

  function settingsPatch(options: ScopeSettingsFlags): Partial<OrchestratorSettings> {
    return {
      ...(options.enforcement === undefined ? {} : { enforcement: options.enforcement }),
      ...(options["read-commands"] === undefined
        ? {}
        : { allowReadCommands: options["read-commands"] === "on" }),
      ...(options["max-nudges"] === undefined ? {} : { maxNudges: options["max-nudges"] }),
      ...(options["max-parallel"] === undefined ? {} : { maxParallelWorkers: options["max-parallel"] }),
      ...(options["max-per-turn"] === undefined ? {} : { maxDelegationsPerTurn: options["max-per-turn"] }),
      ...(options["contract-preset"] === undefined
        ? {}
        : { contractPreset: options["contract-preset"] }),
      ...(options["model-policy"] === undefined
        ? {}
        : { workerModelPolicy: options["model-policy"] }),
      ...(options.retention === undefined ? {} : { workerRetention: options.retention }),
      ...(options["worker-workspace"] === undefined
        ? {}
        : { workerWorkspace: options["worker-workspace"] }),
      ...(options["child-messages"] === undefined
        ? {}
        : { childMessageDelivery: options["child-messages"] }),
      ...(options["orchestrator-subagents"] === undefined
        ? {}
        : { orchestratorSubagents: options["orchestrator-subagents"] }),
      ...(options["worker-subagents"] === undefined
        ? {}
        : { workerSubagents: options["worker-subagents"] }),
      ...(options["max-revisions"] === undefined ? {} : { maxRevisions: options["max-revisions"] }),
      ...(options["max-stall-resumes"] === undefined
        ? {}
        : { maxStallResumes: options["max-stall-resumes"] }),
      ...(options["judge-advisory"] === undefined
        ? {}
        : { judgeAdvisory: options["judge-advisory"] === "on" }),
    };
  }

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

  /**
   * Ask for the judge key in BB's own form, then store it through the one secret
   * setting. The value exists only in the submitted result and this function's
   * local: it is not an option, not a form payload field, not what the timeline
   * row keeps, and not part of what this command prints.
   *
   * A cancellation writes nothing, so a key stored earlier survives it. Every
   * refusal is a typed CLI failure rather than a quiet success.
   */
  async function setupJudgeKey(ctx: PluginCliContext): Promise<void> {
    const threadId = ctx.threadId?.trim() ?? "";
    if (threadId === "") {
      throw new PluginCliError("setup-jev needs a bb thread to show the form in", {
        code: "thread_required",
        hint: "Run it from inside a bb thread, where the form renders in that thread's composer.",
      });
    }
    if (ctx.signal?.aborted === true) {
      throw new PluginCliError("the form was cancelled before it opened, so nothing was stored", {
        code: "cancelled",
      });
    }
    const configured = await judgeKeyConfigured();
    const result = await bb.ui.requestInput(
      {
        threadId,
        rendererId: SETUP_JEV_RENDERER,
        title: "OpenRouter key for the advisory judge",
        // Status only. The form receives no key, and nothing here is persisted
        // verbatim anywhere the transcript can read it.
        payload: { configured },
        // BB stores this description before the settings write finishes. Do not
        // claim the key was saved until the CLI returns successfully.
        describeSubmission: (submitted) => {
          readJudgeKey(submitted);
          return {
            title: "Judge key submitted",
            detail: "Saving to a private file. The CLI result reports whether it succeeded.",
          };
        },
      },
      ctx.signal === undefined ? undefined : { signal: ctx.signal },
    );
    if (result.outcome === "cancelled") {
      const reason = /^[a-z][a-z-]*$/.test(result.reason) ? result.reason : "cancelled";
      throw new PluginCliError(`the form was cancelled (${reason}), so the stored key is unchanged`, {
        code: "cancelled",
      });
    }
    judgeStore.write(readJudgeKey(result.value));
    judgeKeyPresent = true;
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
  }

  /** The stored presets, one line each. */
  function describePresets(presets: WorkerConfig["presets"]): string {
    const entries = Object.entries(presets ?? {});
    return entries.length === 0
      ? ""
      : entries
          .map(([name, execution]) => `\n  preset ${name}: ${describeWorkerExecution(execution)}`)
          .join("");
  }

  /** The retry target, named after the execution it belongs to. */
  function describeFallback(fallback: WorkerConfig["fallback"]): string {
    return fallback === undefined
      ? ""
      : `\nA failed worker is retried on: ${describeWorkerExecution(fallback)}`;
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

  function describeState(
    threadId: string,
    state: OrchestratorStateDto,
    scope: { projectId: string; overridden: readonly string[] } | null = null,
  ): string {
    const lines = [
      `thread ${threadId}`,
      `  scope:             ${scope === null ? "global" : `project ${scope.projectId}${scope.overridden.length === 0 ? " (inherits everything)" : ` (overrides: ${scope.overridden.join(", ")})`}`}`,
      `  orchestrator mode: ${state.enabled ? "ON" : "off"}`,
      `  enforcement:       ${state.effectiveEnforcement}${
        state.enforcement === null ? " (plugin default)" : " (thread override)"
      }`,
      `  violations:        ${state.violations.length}`,
      `  nudges sent:       ${state.nudgeCount} of ${state.maxNudges} (${state.violationNudges} direct work, ${state.reviewNudges} unjudged workers)`,
      `  delegations:       ${state.delegations.length}`,
      `  workers run as:    ${describeWorkerExecution(state.workerExecution)}`,
      `  reviews:           ${state.reviewed} judged, ${state.unreviewed} waiting`,
      `  fan-out cap:       ${
        state.maxParallelWorkers === 0 ? "none" : `${state.maxParallelWorkers} in flight`
      }, ${state.maxDelegationsPerTurn === 0 ? "none" : `${state.maxDelegationsPerTurn} per turn`}`,
      `  children now:      ${
        state.children.available
          ? `${state.children.total} child thread${state.children.total === 1 ? "" : "s"}, ${state.children.running} running (read from BB)`
          : `unknown: BB could not give an exact count (${state.children.error ?? "no reason reported"})`
      }`,
      `  ledger (history):  ${state.workers.total} delegations recorded, ${state.workers.settled} settled, ${state.workers.running} last recorded running, ${state.workers.waiting} waiting for a verdict`,
      `  decisions:         ${state.workers.accepted} accepted, ${state.workers.rejected} rejected, ${state.workers.unconfirmed} with no confirmed execution`,
      `  advisory judge:    ${state.judge.advisory ? (state.judge.configured ? "on" : "opt-in on, no key stored") : "off"}`,
      `  threads retained:  ${state.retention.threads} in durable state (nothing is evicted)`,
      `  record caps:       ${state.retention.caps.delegations} workers, ${state.retention.caps.violations} violations, ${state.retention.caps.seenRows} seen rows per thread`,
      `  records dropped:   ${state.retention.lost.delegations} workers, ${state.retention.lost.violations} violations, ${state.retention.lost.seenRows} seen rows`,
    ];
    if (state.delegations.length > 0) {
      lines.push("  recent workers:");
      for (const delegation of state.delegations.slice(-5)) {
        const requested = delegation.execution
          ? [delegation.execution.providerId, delegation.execution.model, delegation.execution.reasoningLevel, delegation.execution.serviceTier]
              .filter((part): part is string => typeof part === "string" && part !== "")
              .join(" ") || "inherited"
          : "inherited";
        const resolved =
          delegation.resolved === null || delegation.resolved === undefined
            ? "not confirmed by BB"
            : `${delegation.resolved.providerId ?? "?"} / ${delegation.resolved.model ?? "model not reported"} (${delegation.resolved.source})`;
        const verdict =
          delegation.verdict ??
          (delegation.check?.verdict === "rejected"
            ? delegation.resolvedBy === null || delegation.resolvedBy === undefined
              ? "check failed"
              : `check failed, fixed by ${delegation.resolvedBy}`
            : "unjudged");
        lines.push(`    - ${delegation.threadId} [${delegation.status ?? "unknown"}, ${verdict}]: asked ${requested}; ran ${resolved}`);
      }
    }
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
            const projectId = await projectOfThread(threadId);
            const state = toDto(
              threadId,
              await getState(threadId),
              await childCountsOf(threadId),
              settingsFor(projectId),
              retainedThreadCount(),
            );
            const scope =
              projectId === null ? null : { projectId, overridden: Object.keys(projectSettings[projectId] ?? {}) };
            return render(input.options.json, state, describeState(threadId, state, scope));
          },
        }),
        review: cliCommand({
          summary: "Record your verdict on one worker's output, for when the review tool is not loaded in this session",
          options: {
            worker: { type: "string", required: true, description: "The worker thread whose output you judged" },
            verdict: { type: "enum", required: true, values: [...REVIEW_VERDICTS], description: "accepted, or rejected" },
            notes: { type: "string", description: "What you checked and what you concluded" },
            "verified-by": { type: "string", description: "The check unit's thread id, when one ran" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            // Only the thread the command runs in may judge. A --thread override would let a
            // worker name its orchestrator and accept its own output.
            if (ctx.threadId === undefined || ctx.threadId === "") {
              throw new PluginCliError("no thread to judge from", {
                code: "thread_required",
                hint: "Run this inside the orchestrator's bb thread.",
              });
            }
            const text = await recordVerdict(
              ctx.threadId,
              input.options.worker,
              input.options.verdict,
              input.options.notes,
              input.options["verified-by"],
            );
            return render(input.options.json, { message: text }, text);
          },
        }),
        check: cliCommand({
          summary: "Run a worker's pending independent check, for when the check tool is not loaded in this session",
          options: {
            worker: { type: "string", required: true, description: "The worker thread whose check has not run" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            // Same rule as review: the check runs for the calling orchestrator's
            // own worker, never on another thread's ledger.
            if (ctx.threadId === undefined || ctx.threadId === "") {
              throw new PluginCliError("no thread to check from", {
                code: "thread_required",
                hint: "Run this inside the orchestrator's bb thread.",
              });
            }
            const text = await recoverCheck(ctx.threadId, input.options.worker);
            return render(input.options.json, { message: text }, text);
          },
        }),
        delegate: cliCommand({
          summary: "Delegate to a worker when the native tool is unavailable",
          options: {
            ...threadOption,
            task: { type: "string", required: true, description: "Complete, self-contained worker brief (1–20,000 characters)" },
            title: { type: "string", description: "Worker title (at most 200 characters)" },
            provider: { type: "string", aliases: ["provider-id", "providerId"], description: "Pin the worker's registered provider before it starts (1–120 characters)" },
            model: { type: "string", description: "Pin the worker's model before it starts (1–200 characters)" },
            "no-wait": { type: "boolean", description: "Return immediately so other units can be delegated" },
            verify: { type: "boolean", description: "Run an independent check after the worker finishes; cannot be combined with --no-wait" },
            timeout: { type: "integer", min: 10, max: 3600, description: "Wait timeout in seconds (default 900)" },
            hidden: { type: "boolean", description: "Keep the worker out of the sidebar" },
            workspace: {
              type: "enum",
              values: ["shared", "worktree"],
              description: "Where this unit runs: shared (the orchestrator's checkout) or worktree. Required when the scope's worker workspace is mixed",
            },
            kind: {
              type: "enum",
              values: [...WORKER_PRESETS],
              description: "The unit kind: build, review or research. Picks the workspace under mixed and decides whether the unit is checked",
            },
          },
          async run(input, ctx) {
            // A --thread that is not the calling thread would let a worker delegate on another orchestrator's behalf.
            if (
              input.options.thread !== undefined &&
              ctx.threadId !== undefined &&
              input.options.thread.trim() !== ctx.threadId
            ) {
              throw new PluginCliError("delegation runs in the calling thread only", {
                code: "thread_mismatch",
                hint: "Run this inside the orchestrator's own bb thread, without --thread.",
              });
            }
            const threadId = resolveThreadId(input.options.thread, ctx);
            const parsed = delegateParameters.safeParse({
              task: input.options.task,
              title: input.options.title,
              provider: input.options.provider,
              model: input.options.model,
              waitForResult: input.options["no-wait"] !== true,
              verify: input.options.verify,
              timeoutSeconds: input.options.timeout,
              hidden: input.options.hidden,
              workspace: input.options.workspace,
              kind: input.options.kind,
            });
            if (!parsed.success) {
              throw new PluginCliError("invalid delegation arguments", {
                code: "invalid_arguments",
                hint: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
              });
            }
            const output = await delegateTask(parsed.data, {
              ...ctx, threadId,
              projectId: input.options.thread === undefined ? ctx.projectId : undefined,
            });
            return render(input.options.json, { output }, output);
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
            const dto = toDto(
              threadId,
              state,
              await childCountsOf(threadId),
              settingsFor(await projectOfThread(threadId)),
              retainedThreadCount(),
            );
            return render(
              input.options.json,
              dto,
              `Orchestrator mode ON for ${threadId} (${dto.effectiveEnforcement}).\n` +
                "Running turns are notified now. If the native tool is unavailable, use bb orchestrator-mode delegate.",
            );
          },
        }),
        off: cliCommand({
          summary: "Turn orchestrator mode off for a thread",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const state = await setEnabled(threadId, false, null);
            const dto = toDto(
              threadId,
              state,
              await childCountsOf(threadId),
              settingsFor(await projectOfThread(threadId)),
              retainedThreadCount(),
            );
            return render(input.options.json, dto, `Orchestrator mode off for ${threadId}.`);
          },
        }),
        scope: cliCommand({
          summary: "Show or change what one scope uses: the globals, or one project",
          options: {
            global: {
              type: "boolean",
              description:
                "Read or write the global values every project inherits; the settings section's Global scope",
            },
            project: { type: "string", description: "Project id to read or write its overrides" },
            inherit: {
              type: "enum",
              values: [...SETTINGS_KEYS],
              description: "Clear one settings override, so the project inherits it again",
            },
            "inherit-all": {
              type: "boolean",
              description: "Clear every override for this project: settings, worker execution and rules",
            },
            enforcement: {
              type: "enum",
              values: [...ENFORCEMENT_LEVELS],
              description: "Write that scope's enforcement level",
            },
            "read-commands": {
              type: "enum",
              values: ["on", "off"],
              description: "Write that scope's read-only command allowance",
            },
            "child-messages": {
              type: "enum",
              values: ["queued", "immediate"],
              description: "Queue child messages until the orchestrator's turn ends, or deliver immediately",
            },
            "max-nudges": {
              type: "integer",
              min: 0,
              max: 1000,
              description: "Write that scope's reminder cap",
            },
            "max-parallel": {
              type: "integer",
              min: 0,
              max: 1000,
              description: "Write that scope's parallel worker cap",
            },
            "max-per-turn": {
              type: "integer",
              min: 0,
              max: 1000,
              description: "Write that scope's per-turn delegation cap",
            },
            "contract-preset": {
              type: "enum",
              values: [...CONTRACT_PRESETS],
              description: "Write that scope's contract level: standard, review-heavy, or delegate-only",
            },
            "model-policy": {
              type: "enum",
              values: [...WORKER_MODEL_POLICIES],
              description:
                "Write that scope's worker model policy: pinned (the default) holds every worker on the stored execution or a stored preset, flexible lets a delegation choose its own",
            },
            retention: {
              type: "enum",
              values: [...WORKER_RETENTION],
              description: "Write that scope's worker retention policy",
            },
            "worker-workspace": {
              type: "enum",
              values: [...WORKER_WORKSPACES],
              description: "Write that scope's worker workspace: shared or worktree",
            },
            "orchestrator-subagents": {
              type: "enum",
              values: [...ORCHESTRATOR_SUBAGENT_POLICIES],
              description:
                "Write that scope's orchestrator subagent policy: none (the default) starts no subagents, all allows any identified subagent within existing authority",
            },
            "max-revisions": {
              type: "integer",
              min: 0,
              max: 5,
              description:
                "Write that scope's revision budget: how many times one unit chain may be re-delegated after a failed check or a rejected review",
            },
            "max-stall-resumes": {
              type: "integer",
              min: 0,
              max: 5,
              description:
                "Write that scope's stall budget: how many resume messages a worker with no timeline progress may receive before it is reported as stuck",
            },
            "judge-advisory": {
              type: "enum",
              values: ["on", "off"],
              description:
                "Opt in or out of sending minimized check evidence to the advisory judge; a stored key alone does not enable it",
            },
            "worker-subagents": {
              type: "enum",
              values: [...WORKER_SUBAGENT_POLICIES],
              description:
                "Write that scope's worker subagent policy: blocked (the default) tells every worker it owns its unit, allowed leaves its provider's subagents alone",
            },
            "worker-provider": { type: "string", description: "Write this project's worker provider" },
            "worker-model": { type: "string", description: "Write this project's worker model" },
            "clear-worker": {
              type: "boolean",
              description: "Clear this project's worker execution, so it inherits the global one",
            },
            rules: { type: "string", description: "Write this project's appended rules" },
            "clear-rules": { type: "boolean", description: "Clear this project's appended rules" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const projectOption = input.options.project;
            const projectId =
              typeof projectOption === "string" && projectOption.trim() !== "" ? projectOption.trim() : undefined;
            const global = input.options.global === true;
            if (global && projectId !== undefined) {
              throw new PluginCliError(
                "--global reads and writes the values every project inherits, so it cannot be combined with --project.",
                { code: "conflicting_scope" },
              );
            }
            const list = async () => {
              const ids = new Set([
                ...Object.keys(projectSettings),
                ...Object.keys(projectWorker),
                ...Object.keys(projectRules),
              ]);
              const rows = [...ids].sort().map((id) => ({
                projectId: id,
                overridden: Object.keys(projectSettings[id] ?? {}),
                worker: projectWorker[id] === undefined ? null : describeWorkerExecution(workerFor(id)),
                rules: projectRules[id] === undefined ? null : projectRules[id],
              }));
              return render(input.options.json, rows, rows.length === 0
                ? "no project overrides; every project inherits the global configuration"
                : rows
                    .map(
                      (row) =>
                        `${row.projectId}\n  settings: ${row.overridden.length === 0 ? "inherits" : row.overridden.join(", ")}\n  workers:  ${row.worker ?? "inherits"}\n  rules:    ${row.rules === null ? "inherits" : `${row.rules.length} chars`}`,
                    )
                    .join("\n"));
            };
            if (projectId === undefined || projectId === "") {
              if (!global) return list();
              // The global worker execution and the global rules have their own
              // commands; a flag for either here would write a second copy of the
              // same value, and `--inherit` has nothing above the globals to fall
              // back to.
              const misplaced: string[] = [
                ...(["inherit", "worker-provider", "worker-model", "rules"] as const).filter(
                  (flag) => input.options[flag] !== undefined,
                ),
                ...(["inherit-all", "clear-worker", "clear-rules"] as const).filter(
                  (flag) => input.options[flag] === true,
                ),
              ];
              if (misplaced.length > 0) {
                throw new PluginCliError(
                  `--global writes the values every project inherits; ${misplaced.map((flag) => `--${flag}`).join(", ")} ${misplaced.length === 1 ? "belongs" : "belong"} to one project.`,
                  {
                    code: "project_only_flag",
                    hint: "The global worker execution is `bb orchestrator-mode worker`; the global rules are `bb orchestrator-mode contract --rules <text>`.",
                  },
                );
              }
              const patch = settingsPatch(input.options);
              if (Object.keys(patch).length > 0) await writeSettings(patch);
              const values = globalsView();
              // One binding for the JSON field and the line that prints it, so the
              // two cannot describe different executions.
              const worker = describeWorkerExecution(workerDefaults());
              return render(
                input.options.json,
                {
                  scope: "global",
                  values,
                  worker,
                  rules: extraInstructions,
                  newThreads: live.defaultForNewThreads,
                  contract: await contractText(null, null),
                },
                [
                  "global: what every project inherits",
                  `  enforcement:          ${values.enforcement}`,
                  `  read commands:        ${values.allowReadCommands ? "allowed" : "all commands are work"}`,
                  `  reminders per thread: ${values.maxNudges}`,
                  `  fan-out cap:          ${values.maxParallelWorkers === 0 ? "none" : `${values.maxParallelWorkers} in flight`}, ${values.maxDelegationsPerTurn === 0 ? "none" : `${values.maxDelegationsPerTurn} per turn`}`,
                  `  contract shape:       ${values.contractPreset}`,
                  `  worker model policy:  ${values.workerModelPolicy}`,
                  `  worker retention:     ${values.workerRetention}`,
                  `  worker workspace:     ${values.workerWorkspace}`,
                  `  child messages:       ${values.childMessageDelivery}`,
                  `  orchestrator subagents: ${values.orchestratorSubagents}`,
                  `  worker subagents:        ${values.workerSubagents}`,
                  `  workers run as:       ${worker}${describeFallback(live.worker.fallback)}${describePresets(live.worker.presets)}`,
                  `  rules:                ${extraInstructions === "" ? "none" : `${extraInstructions.length} characters`}`,
                  `  new threads default:  ${live.defaultForNewThreads ? "on" : "off"}`,
                ].join("\n"),
              );
            }

            if (input.options["inherit-all"] === true) {
              await writeProjectRules(projectId, "");
              await writeProjectWorker(projectId, null);
              await writeProjectSettings(projectId, {});
            }
            if (input.options.inherit !== undefined) {
              const current = { ...(projectSettings[projectId] ?? {}) };
              delete current[input.options.inherit];
              await writeProjectSettings(projectId, current);
            }
            const patch = settingsPatch(input.options);
            if (Object.keys(patch).length > 0) {
              await writeProjectSettings(projectId, { ...(projectSettings[projectId] ?? {}), ...patch });
            }
            const workerPatch = {
              ...(input.options["worker-provider"] === undefined
                ? {}
                : { providerId: input.options["worker-provider"] }),
              ...(input.options["worker-model"] === undefined ? {} : { model: input.options["worker-model"] }),
            };
            if (Object.keys(workerPatch).length > 0) {
              await writeProjectWorker(projectId, { ...(projectWorker[projectId] ?? {}), ...workerPatch });
            }
            if (input.options["clear-worker"] === true) await writeProjectWorker(projectId, null);
            if (input.options.rules !== undefined) await writeProjectRules(projectId, input.options.rules);
            if (input.options["clear-rules"] === true) await writeProjectRules(projectId, "");

            const values = settingsFor(projectId);
            const view = {
              projectId,
              overridden: Object.keys(projectSettings[projectId] ?? {}),
              values,
              worker: describeWorkerExecution(workerFor(projectId)),
              rules: projectRules[projectId] ?? null,
              contract: await contractText(null, projectId),
            };
            return render(
              input.options.json,
              view,
              [
                `project ${projectId}`,
                `  settings overridden: ${view.overridden.length === 0 ? "none (inherits the globals)" : view.overridden.join(", ")}`,
                `  enforcement:         ${values.enforcement}${view.overridden.includes("enforcement") ? " (project)" : " (global)"}`,
                `  read commands:       ${values.allowReadCommands ? "allowed" : "all commands are work"}${view.overridden.includes("allowReadCommands") ? " (project)" : " (global)"}`,
                `  reminders per thread: ${values.maxNudges}${view.overridden.includes("maxNudges") ? " (project)" : " (global)"}`,
                `  fan-out cap:         ${values.maxParallelWorkers === 0 ? "none" : `${values.maxParallelWorkers} in flight`}, ${values.maxDelegationsPerTurn === 0 ? "none" : `${values.maxDelegationsPerTurn} per turn`}`,
                `  contract shape:      ${values.contractPreset}${view.overridden.includes("contractPreset") ? " (project)" : " (global)"}`,
                `  worker model policy: ${values.workerModelPolicy}${view.overridden.includes("workerModelPolicy") ? " (project)" : " (global)"}`,
                `  worker retention:    ${values.workerRetention}${view.overridden.includes("workerRetention") ? " (project)" : " (global)"}`,
                `  worker workspace:    ${values.workerWorkspace}${view.overridden.includes("workerWorkspace") ? " (project)" : " (global)"}`,
                `  child messages:      ${values.childMessageDelivery}${view.overridden.includes("childMessageDelivery") ? " (project)" : " (global)"}`,
                `  orchestrator subagents: ${values.orchestratorSubagents}${view.overridden.includes("orchestratorSubagents") ? " (project)" : " (global)"}`,
                `  worker subagents:       ${values.workerSubagents}${view.overridden.includes("workerSubagents") ? " (project)" : " (global)"}`,
                `  revisions per unit: ${values.maxRevisions}${view.overridden.includes("maxRevisions") ? " (project)" : " (global)"}`,
                `  stall resumes:      ${values.maxStallResumes}${view.overridden.includes("maxStallResumes") ? " (project)" : " (global)"}`,
                `  advisory judge:     ${values.judgeAdvisory ? "on" : "off"}${view.overridden.includes("judgeAdvisory") ? " (project)" : " (global)"}`,
                `  workers run as:      ${view.worker}`,
                `  project rules:       ${view.rules === null ? "inherits the global rules" : `${view.rules.length} characters`}`,
              ].join("\n"),
            );
          },
        }),
        contract: cliCommand({
          summary: "Print the exact instructions this plugin injects into a thread",
          options: {
            thread: {
              type: "string",
              description: "Thread id. Defaults to this thread, or to a new one when absent.",
              aliases: ["t"],
            },
            rules: {
              type: "string",
              description: "Replace the project rules appended to the contract",
            },
            "clear-rules": {
              type: "boolean",
              description: "Remove the project rules",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = input.options.thread?.trim() || ctx.threadId || null;
            if (input.options["clear-rules"] === true) {
              await setExtraInstructions("");
            } else if (input.options.rules !== undefined) {
              await setExtraInstructions(input.options.rules);
            }
            const text = await contractText(threadId);
            return render(
              input.options.json,
              {
                threadId,
                chars: text.length,
                ceiling: INSTRUCTION_LIMIT,
                extra: extraInstructions,
                extraLimit: EXTRA_INSTRUCTION_LIMIT,
                text,
              },
              text,
            );
          },
        }),
        violations: cliCommand({
          summary: "List the direct work a thread did, or clear the record",
          options: { ...threadOption, clear: { type: "boolean", description: "Clear the record" } },
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            if (input.options.clear === true) {
              const state = await clearViolations(threadId);
              return render(
                input.options.json,
                toDto(
                  threadId,
                  state,
                  await childCountsOf(threadId),
                  settingsFor(await projectOfThread(threadId)),
                  retainedThreadCount(),
                ),
                `Cleared for ${threadId}.`,
              );
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
        "setup-jev": cliCommand({
          summary: "Store the advisory judge's OpenRouter key from a form, never from an argument",
          description:
            "Opens a password form in this thread's composer and saves what it submits to a private file. The key is never an argument, never printed and never kept in the transcript; cancelling leaves any stored key alone, and the advisory judge stays off until it is opted into for the scope.",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input, ctx) {
            await setupJudgeKey(ctx);
            return render(
              input.options.json,
              { configured: true },
              "Judge key saved in a private file, never shown again. The advisory judge stays off until it is opted into for the scope.",
            );
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
            "fallback-provider": {
              type: "string",
              description: "Provider to retry a failed worker on; needs --fallback-model",
            },
            "fallback-model": {
              type: "string",
              description: "Model to retry a failed worker on; needs --fallback-provider",
            },
            "fallback-permission": {
              type: "enum",
              values: [...PERMISSION_MODES],
              description: "Permission mode for a retried worker",
            },
            "clear-fallback": {
              type: "boolean",
              description: "Stop retrying failed workers",
            },
            preset: {
              type: "enum",
              values: [...WORKER_PRESETS],
              description:
                "Write these execution flags to a named preset instead of to the worker execution",
            },
            "clear-preset": {
              type: "enum",
              values: [...WORKER_PRESETS],
              description: "Delete a named preset",
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
            const fallbackProvider = input.options["fallback-provider"];
            const fallbackModel = input.options["fallback-model"];
            const fallbackPermission = input.options["fallback-permission"];
            // A patch, not a replacement: each flag below is merged over the
            // stored fallback, so `--fallback-permission` alone keeps its
            // provider and model.
            const fallbackPatch: WorkerExecution = {
              ...(fallbackProvider === undefined ? {} : { providerId: fallbackProvider }),
              ...(fallbackModel === undefined ? {} : { model: fallbackModel }),
              ...(fallbackPermission === undefined
                ? {}
                : { permissionMode: fallbackPermission as PermissionMode }),
            };
            const hasFallbackPatch = Object.keys(fallbackPatch).length > 0;
            const clearing = input.options.clear === true;
            const clearFallback = input.options["clear-fallback"] === true;
            const presetName = input.options.preset;
            const clearPreset = input.options["clear-preset"];
            if (
              !clearing &&
              !clearFallback &&
              !hasFallbackPatch &&
              clearPreset === undefined &&
              Object.keys(chosen).length === 0
            ) {
              // Nothing named a value to write, so this is a read: `--preset
              // build` on its own asks for a preset with no contents, and
              // storing `{}` would leave a no-op preset a delegation could name.
              return render(
                input.options.json,
                live.worker,
                `Workers run as: ${describeWorkerExecution(workerDefaults())}${describeFallback(live.worker.fallback)}${describePresets(live.worker.presets)}`,
              );
            }
            // Each flag changes one thing and leaves the rest of the stored
            // configuration alone, so `worker --permission auto` on an existing
            // choice does not drop its provider and model.
            let next: WorkerConfig | null = null;
            if (!clearing) {
              if (presetName !== undefined || clearPreset !== undefined) {
                // A preset edit leaves the worker execution and the retry target
                // untouched.
                next = { ...live.worker };
                const presets = { ...(next.presets ?? {}) };
                if (presetName !== undefined && Object.keys(chosen).length > 0) {
                  presets[presetName] = { ...presets[presetName], ...chosen };
                } else if (clearPreset !== undefined) {
                  delete presets[clearPreset];
                }
                next.presets = Object.keys(presets).length === 0 ? undefined : presets;
              } else {
                next = { ...workerDefaults(), ...chosen };
                if (!clearFallback) {
                  const target = { ...live.worker.fallback, ...fallbackPatch };
                  if (target.providerId !== undefined || target.model !== undefined) {
                    next.fallback = target;
                  }
                }
              }
            }
            const stored = await setWorkerConfig(next);
            return render(
              input.options.json,
              stored,
              `Workers run as: ${describeWorkerExecution(stored)}${describeFallback(stored.fallback)}${describePresets(stored.presets)}`,
            );
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    disposed = true;
    childQueue.dispose();
    for (const timer of scanTimers.values()) clearTimeout(timer);
    scanTimers.clear();
    scanning.clear();
  });

  bb.background.service("worker-catalog", {
    async start(signal) {
      let lastReported = "";
      while (!signal.aborted) {
        try {
          const discovered = await loadWorkerCatalog(bb, signal);
          if (signal.aborted || disposed) return;
          catalog = discovered;
          catalogReady = true;
          // Use the current mirrors, including edits made while discovery was
          // pending. Do not rewrite saved choices merely because discovery ran.
          live.worker = storedWorkerConfig(live.worker);
          for (const [projectId, config] of Object.entries(projectWorker)) {
            projectWorker[projectId] = storedWorkerConfig(config);
          }
          bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
          // A provider that could not list its models is retried, so its models join the catalog once it can.
          if (discovered.unavailable.length === 0) return;
          const reported = discovered.unavailable.join(", ");
          if (reported !== lastReported) {
            lastReported = reported;
            bb.log.warn(`worker providers unavailable, retrying: ${reported}`);
          }
        } catch (cause) {
          if (signal.aborted || disposed) return;
          bb.log.warn(`worker provider catalog unavailable; preserving saved choices and retrying: ${String(cause)}`);
        }
        // Own the retry timer through the service's abort signal; discovery
        // failure must neither fail activation nor leak a timer after reload.
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await whileActive(new Promise<void>((resolve) => {
            retryTimer = setTimeout(resolve, 30_000);
          }), signal);
        } catch { return; }
        finally { clearTimeout(retryTimer); }
      }
    },
  });

  bb.background.service("queue-recovery", {
    async start(signal) {
      // Abort precedes onDispose in the host lifecycle. Stop nested recovery
      // consumers now, before any late SDK result can touch a stale context.
      const stop = () => { disposed = true; childQueue.dispose(); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        if (signal.aborted || disposed) return;
        try {
          const waiting = await whileActive(bb.sdk.threads.queue.list({ waitHolder: `plugin:${bb.pluginId}` }), signal);
          if (signal.aborted || disposed) return;
          await whileActive(Promise.all([...new Set(waiting.map((entry) => entry.threadId))].map(childQueue.prepare)), signal);
        } catch (cause) {
          if (signal.aborted || disposed) return;
          bb.log.warn(`child queue recovery failed: ${String(cause)}`);
        }
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
  });
  bb.log.info(`loaded (enforcement=${live.enforcement})`);
}
