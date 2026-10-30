// Frontend for the orchestrator-mode plugin.
//
// One composer customization with three surfaces over one shared controller:
//
//   banner  (always mounted)  owns the data: it holds the plugin's RPC client,
//                             keeps the thread's state fresh and renders the
//                             visible strip when the mode is on. It returns
//                             null when the mode is off
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
import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_PermissionModePicker as PermissionModePicker,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposer,
  useRealtime,
  useRpc,
  useSdk,
  type PluginComposerApi,
  type ExperimentalProviderModelPickerValue,
  type PluginComposerScope,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ContractDto, OrchestratorStateDto, ScopeSettingsDto, SettingsViewDto, rpcContract } from "./server";
import {
  CONTRACT_PRESET_DESCRIPTIONS,
  CONTRACT_PRESETS,
  ENFORCEMENT_DESCRIPTIONS,
  ENFORCEMENT_LEVELS,
  INSTRUCTION_LIMIT,
  isOneOf,
  REASONING_LEVELS,
  SERVICE_TIERS,
  ORCHESTRATOR_SUBAGENT_POLICIES,
  ORCHESTRATOR_SUBAGENT_POLICY_DESCRIPTIONS,
  WORKER_MODEL_POLICIES,
  WORKER_MODEL_POLICY_DESCRIPTIONS,
  WORKER_RETENTION,
  WORKER_RETENTION_DESCRIPTIONS,
  WORKER_SUBAGENT_POLICIES,
  WORKER_SUBAGENT_POLICY_DESCRIPTIONS,
  WORKER_WORKSPACE_DESCRIPTIONS,
  WORKER_WORKSPACES,
  type EnforcementLevel,
  type WorkerConfig,
  type WorkerExecution,
  type WorkerPresetName,
} from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import "./app.css";

/** The presets the settings section edits, in the order it shows them. */
const PRESET_ROWS: { name: WorkerPresetName; label: string; hint: string }[] = [
  { name: "build", label: "Build", hint: "the execution used for build units" },
  { name: "review", label: "Review", hint: "the execution used for review units" },
  { name: "research", label: "Research", hint: "the execution used for research units" },
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

function controllerFor(view: PluginComposerApi): Controller | null {
  const key = scopeKey(view.scope);
  return key === null ? null : (registry.get(key) ?? null);
}

/** The picker's value as a stored execution. A reasoning level or tier this plugin does not store is dropped. */
function executionOf(next: ExperimentalProviderModelPickerValue): Partial<WorkerExecution> {
  const { reasoningLevel, serviceTier, ...rest } = next;
  return {
    ...rest,
    ...(isOneOf(REASONING_LEVELS, reasoningLevel) ? { reasoningLevel } : {}),
    ...(isOneOf(SERVICE_TIERS, serviceTier) ? { serviceTier } : {}),
  };
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
 * One child thread as BB's own list reports it. This is an identity that exists
 * right now; a delegation record is history and never becomes one of these.
 */
interface LiveChild {
  id: string;
  /** The child's title, BB's first-message fallback, or a neutral placeholder. */
  label: string;
  /** BB's own status for the child: `starting`, `active`, `idle`, `error`, … */
  status: string;
  /** Kept out of the sidebar, but still a child and still counted. */
  hidden: boolean;
}

/**
 * What one read of BB's child list produced. `rows: null` means there is no
 * identity to report — not read yet, or nothing to read — which is not the same
 * as "the list named none". The thread id is carried so a scope change can
 * never draw another thread's children.
 */
interface LiveChildren {
  threadId: string;
  rows: LiveChild[] | null;
  error: string | null;
}

/** How many child robots the crew draws before it counts the rest. */
const CREW_LIMIT = 8;
/** How many rows one read asks for; a parent with more reports the rest as a count. */
const CREW_READ_LIMIT = 50;
/**
 * The statuses BB counts as a working child, mirroring the server's
 * `RUNNING_CHILD_STATUSES`, so a robot's state matches the running count beside
 * it. Anything else BB lists is a child that is not working right now.
 */
const WORKING_CHILD_STATUSES = ["starting", "active", "stopping"] as const;


/**
 * Owns the data for one composer. Mounted as a `bare` banner in every thread
 * and new-thread composer, so it exists even when the mode is off and even in
 * compact layout, where the action button does not render.
 */
function OrchestratorHost() {
  const view = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const key = scopeKey(view.scope);
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;

  const [state, setState] = useState<OrchestratorStateDto | null>(null);
  const [defaultEnabled, setDefaultEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveChildren | null>(null);
  /** Rises per read, so a slow answer can never overwrite a newer one. */
  const liveRead = useRef(0);
  const sdk = useSdk();

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

  /**
   * Read BB's current children from BB's own thread list, so the crew draws the
   * threads that exist now instead of this plugin's records. Only called when
   * BB's count says children exist: with no known children there is no identity
   * to claim, and a failed read clears the crew and says why, because a record
   * is never a substitute for a thread that is there.
   */
  const readChildren = useCallback(
    async (counts: OrchestratorStateDto["children"]) => {
      if (threadId === null) return;
      const token = liveRead.current + 1;
      liveRead.current = token;
      if (!counts.available || counts.total === 0) {
        // Nothing to name: leave the row unreported rather than claiming an
        // empty list, so a later child cannot flash a "none listed" line. The
        // same value is kept by reference, so a state read costs no render.
        setLive((current) =>
          current !== null && current.threadId === threadId && current.rows === null
            ? current
            : { threadId, rows: null, error: null },
        );
        return;
      }
      try {
        const listed = await sdk.threads.list({
          parentThreadId: threadId,
          // Archived rows are history, not children: left in, they would spend
          // the read limit on threads BB's own list does not show, and a live
          // child could be pushed off the page by rows this row must not draw.
          archived: false,
          includeHidden: true,
          limit: CREW_READ_LIMIT,
        });
        if (liveRead.current !== token) return;
        setLive({
          threadId,
          error: null,
          rows: listed
            // The route already applies these; checking again keeps a page
            // that was read before an archive from drawing a thread BB has
            // since retired, and keeps a stranger out of this thread's crew.
            .filter(
              (child) =>
                child.parentThreadId === threadId &&
                child.archivedAt === null &&
                child.deletedAt === null,
            )
            .map((child) => ({
              id: child.id,
              label: child.title ?? child.titleFallback ?? "Untitled child",
              status: child.status,
              hidden: child.visibility === "hidden",
            })),
        });
      } catch (cause) {
        if (liveRead.current !== token) return;
        setLive({ threadId, rows: [], error: message(cause) });
      }
    },
    [sdk, threadId],
  );

  // BB's count is the trigger: a child appearing, settling or going back to
  // work changes it, and each state read is already a fresh object.
  useEffect(() => {
    if (!enabled || threadId === null || state === null) return;
    void readChildren(state.children);
  }, [enabled, threadId, state, readChildren]);

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

  const applyClearViolations = useCallback(async () => {
    if (threadId === null) return;
    setBusy(true);
    try {
      setState(await rpc.call("clear_violations", { threadId }));
      toast.success("Cleared the direct-work record");
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setBusy(false);
    }
  }, [rpc, threadId]);

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

  // The strip and toggle indicate the mode; leave editable draft text alone.
  if (key === null || !enabled) return null;

  if (threadId === null) {
    return (
      <div className="orch" data-testid="orch-strip-new-thread">
        <div className="orch__head">
          <Icon name={ICON_NAME} className="orch__mark" />
          <div className="orch__heading">
            <span className="orch__title">New threads start as orchestrators</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="orch__off"
            disabled={busy}
            onClick={() => void applyEnabled(false)}
          >
            Turn off
          </Button>
        </div>
        <p className="orch__lede">
          The thread you are about to create will delegate every unit of work instead of doing
          it itself.
        </p>
      </div>
    );
  }

  const enforcement = state?.effectiveEnforcement ?? "guard";
  const violations = state?.violations ?? [];
  const recent = violations.slice(-3);
  const delegations = state?.delegations ?? [];
  const workers = state?.workers;
  const retention = state?.retention;
  const lostTotal = retention === undefined
    ? 0
    : retention.lost.delegations + retention.lost.violations + retention.lost.seenRows;

  return (
    <div
      className="orch"
      data-violations={violations.length > 0 ? "true" : "false"}
      data-testid="orch-strip-thread"
    >
      <div className="orch__head">
        <Icon name={ICON_NAME} className="orch__mark" />
        <div className="orch__heading">
          <span className="orch__title">Orchestrator mode</span>
          <span className="orch__chip" data-level={enforcement}>
            {enforcement}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="orch__off"
          disabled={busy}
          onClick={() => void applyEnabled(false)}
        >
          Turn off
        </Button>
      </div>

      <p className="orch__lede">
        {ENFORCEMENT_DESCRIPTIONS[enforcement]} This thread reads, plans, asks, delegates and
        reports.
      </p>

      <ChildCrew counts={state?.children ?? null} live={live} threadId={threadId} />

      {state === null ? null : (
        <div className="orch__counts">
          {/* The live answer to "how many children are there now", read from BB's
              own thread tree. It is never derived from the ledger. */}
          <div
            className="orch__stats"
            role="group"
            aria-label="Child threads in BB right now"
            data-testid="orch-children"
          >
            {state.children.available ? (
              <>
                <span className="orch__count">
                  <b>{state.children.total}</b>{" "}
                  {state.children.total === 1 ? "child" : "children"}
                </span>
                <span
                  className="orch__count"
                  data-live={state.children.running > 0 ? "true" : "false"}
                  data-testid="orch-children-running"
                >
                  <span className="orch__dot" aria-hidden="true" />
                  <b>{state.children.running}</b> running
                </span>
              </>
            ) : (
              <span className="orch__unknown" data-testid="orch-children-unknown">
                <span className="orch__dot" data-state="unknown" aria-hidden="true" />
                Children unknown: BB could not be read
                {state.children.error === null ? "" : ` (${state.children.error})`}
              </span>
            )}
          </div>
          {/* History: what this thread recorded, which outlives the threads. */}
          {workers === undefined ? null : (
            <div
              className="orch__stats orch__stats--ledger"
              role="group"
              aria-label="Delegation ledger: records kept by this thread"
              data-testid="orch-ledger-stats"
            >
              <span>
                <b>{workers.total}</b> recorded
              </span>
              <span>
                <b>{workers.settled}</b> finished
              </span>
              <span>
                <b>{workers.waiting}</b> awaiting a verdict
              </span>
            </div>
          )}
        </div>
      )}

      {violations.length === 0 ? null : (
        <div className="orch__alert" role="alert" data-testid="orch-alert">
          <div className="orch__alert-head">
            <span className="orch__alert-title">
              Direct work caught
              <span className="orch__alert-count">{violations.length}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="orch__alert-clear"
              disabled={busy}
              onClick={() => void applyClearViolations()}
            >
              Clear
            </Button>
          </div>
          <ul className="orch__alert-list">
            {recent.map((violation) => (
              <li key={violation.id}>{violation.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {delegations.length === 0 ? null : (
        <details className="orch__ledger">
          <summary>
            <span className="orch__ledger-label">Worker ledger</span>
            <span className="orch__ledger-count">
              {workers?.accepted ?? 0} accepted · {workers?.rejected ?? 0} rejected ·{" "}
              {workers?.unconfirmed ?? 0} unconfirmed
            </span>
          </summary>
          <ul>
            {delegations
              .slice(-6)
              .reverse()
              .map((delegation) => (
                <li key={delegation.threadId}>
                  <span className="orch__ledger-head">
                    <span className="orch__ledger-name">{delegation.title}</span>
                    <span className="orch__ledger-state" data-state={botOf(delegation).state}>
                      {stateLabel(botOf(delegation).state, delegation)}
                    </span>
                  </span>
                  <span className="orch__ledger-run">{askedLine(delegation)}</span>
                  <span className="orch__ledger-ran">{ranLine(delegation)}</span>
                </li>
              ))}
          </ul>
        </details>
      )}

      <div className="orch__meta">
        <span>
          Kept {retention?.threads ?? 0} thread{retention?.threads === 1 ? "" : "s"}
        </span>
        <span>
          {lostTotal === 0
            ? "No records dropped"
            : `${retention?.lost.delegations ?? 0} workers, ${retention?.lost.violations ?? 0} violations, ${retention?.lost.seenRows ?? 0} seen rows dropped at the per-thread caps`}
        </span>
        <span>
          {state?.judge?.advisory === true
            ? state.judge.configured
              ? "Advisory judge on"
              : "Advisory judge: no key"
            : "Advisory judge off"}
        </span>
      </div>
    </div>
  );
}

type DelegationDto = OrchestratorStateDto["delegations"][number];

type BotState = "running" | "accepted" | "rejected" | "failed" | "waiting" | "checking";

const RUNNING_STATUSES = ["active", "starting", "pending", "stopping"] as const;

/** What one worker's robot says, from its own record only. */
function botOf(delegation: DelegationDto): { state: BotState; label: string } {
  const status = delegation.status;
  const running = status === null || (RUNNING_STATUSES as readonly string[]).includes(status);
  const state: BotState = running
    ? "running"
    : status === "error"
      ? "failed"
      : delegation.verdict === "rejected" ||
          (delegation.check?.verdict === "rejected" &&
            (delegation.resolvedBy === null || delegation.resolvedBy === undefined))
        ? "rejected"
        : delegation.verdict === "accepted" || delegation.resolvedBy != null
          ? "accepted"
          : delegation.verifierFor === undefined
            ? "waiting"
            : "checking";
  const parts = [
    delegation.title,
    delegation.kind === null || delegation.kind === undefined ? null : `${delegation.kind} unit`,
    running ? `running (${status ?? "starting"})` : status === "error" ? "failed" : "finished",
    delegation.verdict === null || delegation.verdict === undefined ? null : `review ${delegation.verdict}`,
    // A failed check a later revision fixed is not the worker's current state.
    delegation.check === null || delegation.check === undefined
      ? null
      : delegation.check.verdict === "accepted"
        ? "check pass"
        : delegation.resolvedBy === null || delegation.resolvedBy === undefined
          ? "check failed"
          : `check failed, fixed by ${delegation.resolvedBy}`,
  ].filter((part): part is string => part !== null);
  return { state, label: parts.join(" · ") };
}

/** The robot glyph: one authored drawing, in the host's text color. */
function RobotMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <rect x="3.25" y="5.25" width="9.5" height="7.5" rx="2" />
        <path d="M8 5.25V3.4" />
        <path d="M1.6 7.4v3m12.8-3v3" />
      </g>
      <circle cx="8" cy="2.35" r="0.9" fill="currentColor" />
      <circle cx="6" cy="9" r="0.95" fill="currentColor" />
      <circle cx="10" cy="9" r="0.95" fill="currentColor" />
    </svg>
  );
}

/** One word for what a worker's record says, from its own fields only. */
function stateLabel(state: BotState, delegation: DelegationDto): string {
  switch (state) {
    case "running":
      return delegation.status === null ? "starting" : `running · ${delegation.status}`;
    case "accepted":
      return "accepted";
    case "rejected":
      return delegation.check?.verdict === "rejected" ? "check failed" : "rejected";
    case "failed":
      return "failed";
    case "checking":
      return "check unit";
    case "waiting":
      return "awaiting verdict";
  }
}

/** What a current child's robot can say. A thread has a status, never a verdict. */
type LiveBotState = "running" | "idle" | "failed";

/** What one current child's robot says, from BB's own row and nothing else. */
function childBot(child: LiveChild): { state: LiveBotState; label: string } {
  const state: LiveBotState =
    child.status === "error"
      ? "failed"
      : (WORKING_CHILD_STATUSES as readonly string[]).includes(child.status)
        ? "running"
        : "idle";
  const parts = [
    child.label,
    child.status,
    child.hidden ? "hidden from the sidebar" : null,
  ].filter((part): part is string => part !== null);
  return { state, label: parts.join(" · ") };
}

/**
 * One robot per child thread BB has right now, drawn from BB's own child list.
 * The crew is never drawn from the delegation ledger: those records outlive the
 * threads they name, so a record count beside a live count would be two
 * different answers to the same question.
 *
 * Every branch here is a claim, and each one is something that was read:
 * `counts` decides whether a count exists at all, `live` decides which threads
 * can be named, and no data means no claim.
 */
function ChildCrew({
  counts,
  live,
  threadId,
}: {
  counts: OrchestratorStateDto["children"] | null;
  live: LiveChildren | null;
  threadId: string;
}) {
  // No read yet, or BB could not be read: the counts group below says so, and
  // this row has nothing honest to add.
  if (counts === null || !counts.available) return null;
  const { total } = counts;
  if (total === 0) return <p className="orch__empty">No child threads right now.</p>;

  const read = live !== null && live.threadId === threadId ? live : null;
  if (read === null || read.rows === null) return null;

  if (read.error !== null) {
    return (
      <p className="orch__empty" data-testid="orch-crew-unknown">
        {total === 1 ? "1 child thread is" : `${total} child threads are`} in BB, but the child
        list could not be read ({read.error}).
      </p>
    );
  }
  if (read.rows.length === 0) {
    // The count said there are children and the list named none: say that,
    // rather than reporting the absence the list alone would imply.
    return (
      <p className="orch__empty" data-testid="orch-crew-unknown">
        {total === 1
          ? "1 child thread is in BB, but it is not listed here."
          : `${total} child threads are in BB, but none of them are listed here.`}
      </p>
    );
  }

  // Draw what the list actually named, capped; the count supplies the overflow
  // so a page shorter than the child count still says how many are missing.
  const shown = read.rows.slice(0, CREW_LIMIT);
  const rest = Math.max(0, total - shown.length);
  return (
    <div
      className="orch__crew"
      role="group"
      aria-label="Current child threads"
      data-testid="orch-crew"
    >
      {shown.map((child) => {
        const bot = childBot(child);
        return (
          <span
            key={child.id}
            className="orch__bot"
            data-state={bot.state}
            data-hidden={child.hidden ? "true" : "false"}
            role="img"
            aria-label={bot.label}
            title={bot.label}
          >
            <RobotMark />
          </span>
        );
      })}
      {rest > 0 ? (
        <span
          className="orch__more"
          // A bare span has no role, so its label reaches nobody; `img` is the
          // role that exposes this compact "+N" as one readable unit.
          role="img"
          aria-label={`${rest} more child thread${rest === 1 ? "" : "s"}`}
          title={`${rest} more child thread${rest === 1 ? "" : "s"}`}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}

/** What the plugin asked the worker to run on. */
function askedLine(delegation: DelegationDto): string {
  if (delegation.execution === null || delegation.execution === undefined) return "asked: project default";
  const parts = [
    delegation.execution.providerId,
    delegation.execution.model,
    delegation.execution.reasoningLevel,
    delegation.execution.serviceTier === null ? null : `tier ${delegation.execution.serviceTier}`,
  ].filter((part): part is string => typeof part === "string" && part !== "");
  return `asked: ${parts.length === 0 ? "project default" : parts.join(" / ")}`;
}

/**
 * What the worker actually ran on. BB reports the provider and, once a session
 * has run, the session snapshot's model. Reasoning level and service tier are
 * not exposed anywhere, so they are named as unreported instead of echoing the
 * request back as if it were a fact.
 */
function ranLine(delegation: DelegationDto): string {
  const resolved = delegation.resolved;
  if (resolved === null || resolved === undefined) return "ran: not confirmed by BB";
  const parts = [
    resolved.providerId ?? "provider not reported",
    resolved.model ?? "model not reported",
  ];
  const missing = ["reasoning", "tier"].filter((field) => resolved.unreported.includes(field === "reasoning" ? "reasoningLevel" : "serviceTier"));
  return `ran: ${parts.join(" / ")}${missing.length === 0 ? "" : ` · ${missing.join(" and ")} not reported`}`;
}

/** The toggle button that renders before the native voice/submit actions. */
function OrchestratorToggle() {
  const view = useComposer();
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
 * One section, one scope: **Scope** at the top decides whose values everything
 * below reads and writes. Global is the record every project inherits, and a
 * project stores only the fields it changes — a cleared field inherits again.
 * The section renders the editor itself because BB's settings form has one value
 * per install, and these resolve per project.
 *
 * Worker execution still uses BB's provider/model picker: the model list has to
 * follow the chosen provider, and a `select` cannot depend on another `select`.
 * That picker resolves provider, model, reasoning level and service tier against
 * the live catalog as one coherent value, the same value `threads.spawn` takes.
 * That is why the choice is stored through this plugin's RPC. Each choice is a
 * pressed pair, so `Inherit` is a visible option rather than only the absence of
 * one.
 */
function ScopeSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [scope, setScope] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [settings, setSettings] = useState<ScopeSettingsDto | null>(null);
  const [newThreads, setNewThreads] = useState(false);
  const [stored, setStored] = useState<WorkerConfig | null>(null);
  const [contract, setContract] = useState<ContractDto | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [judge, setJudge] = useState<{ configured: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const listed = await sdk.projects.list({ includePersonal: true });
      setProjects(listed.map((project) => ({ id: project.id, name: project.name ?? project.id })));
    } catch {
      // Without the list the selector stays on Global; the rows below still apply.
    }
    try {
      setSettings(await rpc.call("get_scope_settings", { projectId: scope }));
      setNewThreads((await rpc.call("get_default")).enabled);
      setJudge(await rpc.call("get_judge", null));
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

  /**
   * Write one setting in the selected scope. A project reads null as "inherit
   * again"; the global record has nothing above it, so the server refuses null
   * there and this never sends one.
   */
  const writeSetting = useCallback(
    async (key: SettingsKey, value: string | number | boolean | null) => {
      setBusy(true);
      try {
        setSettings(await rpc.call("set_scope_setting", { projectId: scope, key, value }));
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc, scope],
  );

  /** The composer default is one plugin-wide switch, not a per-project one. */
  const saveNewThreads = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        setNewThreads((await rpc.call("set_default", { enabled })).enabled);
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );

  /** Write the worker configuration. A promise is awaited first, so a caller that has
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
      reasoningLevel: isOneOf(REASONING_LEVELS, model.defaultReasoningEffort) ? model.defaultReasoningEffort : undefined,
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

  const off = loading || busy || settings === null;
  const overridden = (key: SettingsKey) => settings?.overridden.includes(key) ?? false;

  /** One enum setting, in the selected scope. In a project scope the first option
   * is the inherited value, and picking it hands the override back. */
  const enumRow = (
    key: SettingsKey,
    label: string,
    hint: string,
    options: readonly { value: string; label: string; help: string }[],
  ) => {
    const value = settings?.values[key];
    const global = settings?.global[key];
    // The same option list names the inherited value, so `Inherit (allowed)`
    // reads as the choice it stands for rather than the stored `true`.
    const inherited = options.find((option) => option.value === String(global))?.label ?? String(global);
    return (
      <SettingRow
        key={key}
        label={label}
        hint={
          <>
            {hint}
            <OptionHelp>
              {options.map((option) => (
                <OptionLine key={option.value} label={option.label} help={option.help} />
              ))}
            </OptionHelp>
          </>
        }
      >
        <select
          aria-label={label}
          value={scope === null || overridden(key) ? String(value ?? "") : ""}
          disabled={off}
          className="h-7 shrink-0 rounded-md border border-border/60 bg-card px-1.5 text-xs"
          onChange={(event) => {
            const raw = event.target.value;
            // A select carries strings; the two boolean settings are booleans
            // in the stored record, and the server treats a string as the
            // unchanged base. Send the type the field actually has.
            const booleanKey = key === "allowReadCommands" || key === "judgeAdvisory";
            void writeSetting(key, raw === "" ? null : booleanKey ? raw === "true" : raw);
          }}
        >
          {scope === null ? null : (
            <option value="">{global === undefined ? "Inherit" : `Inherit (${inherited})`}</option>
          )}
          {options
            .filter((option) => scope === null || option.value !== String(global))
            .map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
        </select>
        {scope !== null && overridden(key) ? (
          <span className="shrink-0 text-xs text-subtle-foreground/75">overrides Global</span>
        ) : null}
      </SettingRow>
    );
  };

  /** One numeric cap. A project shows Inherit only once it has an override; the
   * input always shows the value in force. */
  const numberRow = (
    key: "maxNudges" | "maxParallelWorkers" | "maxDelegationsPerTurn" | "maxRevisions" | "maxStallResumes",
    label: string,
    hint: string,
  ) => (
    <SettingRow key={key} label={label} hint={hint}>
      <input
        type="number"
        min={0}
        aria-label={label}
        value={settings?.values[key] ?? 0}
        disabled={off}
        className="h-7 w-20 shrink-0 rounded-md border border-border/60 bg-card px-1.5 text-xs"
        onChange={(event) => void writeSetting(key, Number(event.target.value))}
      />
      {scope !== null && overridden(key) ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          disabled={off}
          onClick={() => void writeSetting(key, null)}
        >
          Inherit
        </Button>
      ) : null}
    </SettingRow>
  );

  return (
    <div className="rounded-md border border-border bg-surface-recessed/70 p-3">
      <div className="border-b border-border/60 pb-3">
        <SettingRow
          label="Scope"
          hint={
            scope === null
              ? "The values every project inherits."
              : "Only what this project changes. Anything else comes from Global; Inherit hands a field back."
          }
        >
          <select
            id="orchestrator-scope"
            aria-label="Scope"
            value={scope ?? ""}
            disabled={loading || busy}
            className="h-8 shrink-0 rounded-md border border-border/60 bg-card px-2 text-xs"
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
        </SettingRow>
      </div>

      <div className="mt-3 flex flex-col gap-2.5">
        {enumRow(
          "enforcement",
          "Enforcement",
          "How hard the watchdog pushes back when the orchestrator does the work itself.",
          ENFORCEMENT_LEVELS.map((level) => ({
            value: level,
            label: level,
            help: ENFORCEMENT_DESCRIPTIONS[level],
          })),
        )}
        {enumRow(
          "allowReadCommands",
          "Read-only commands",
          "Whether a read counts as looking around, or as work.",
          [
            {
              value: "true",
              label: "allowed",
              help: "Allowed treats ls, cat, rg, git status and similar as looking around instead of work.",
            },
            {
              value: "false",
              label: "every command is work",
              help: "Every command is work counts a read as the orchestrator doing the work itself.",
            },
          ],
        )}
        {numberRow(
          "maxNudges",
          "Reminders per thread",
          "How many times this plugin may prod one thread. One budget covers both gates: doing the work itself, and leaving a worker unjudged. `bb orchestrator-mode status` reports the split. 0 turns reminders off, and violations are still recorded.",
        )}
        {enumRow(
          "childMessageDelivery",
          "Child messages",
          "When messages from child threads reach an orchestrator. BB's automatic completion notices use its own delivery path.",
          [
            {
              value: "queued",
              label: "queued until turn ends",
              help: "Queues child messages until the turn ends, then delivers compatible updates from each child together with all content preserved.",
            },
            {
              value: "immediate",
              label: "immediate",
              help: "Lets each child message reach the running turn as it arrives.",
            },
          ],
        )}
        {numberRow(
          "maxParallelWorkers",
          "Workers running at once",
          "Further delegations are refused once this many workers are running. Check units and fallbacks count. 0 removes the cap.",
        )}
        {numberRow(
          "maxDelegationsPerTurn",
          "Workers per turn",
          "A turn stops delegating at this many, so a fan-out cannot fill the sidebar. Check units and fallback retries are this plugin's own doing and do not count. 0 removes the cap.",
        )}
        {enumRow(
          "contractPreset",
          "What the orchestrator is told",
          "What a session does itself, and how much it checks.",
          CONTRACT_PRESETS.map((preset) => ({
            value: preset,
            label: preset,
            help: CONTRACT_PRESET_DESCRIPTIONS[preset],
          })),
        )}
        {enumRow(
          "workerWorkspace",
          "Where workers run",
          "Shared keeps every worker in the checkout you are in, worktree gives each unit its own copy, and mixed lets the orchestrator name one per unit.",
          WORKER_WORKSPACES.map((mode) => ({
            value: mode,
            label: mode,
            help: WORKER_WORKSPACE_DESCRIPTIONS[mode],
          })),
        )}
        {enumRow(
          "workerRetention",
          "Workers afterwards",
          "What happens to a worker once its result has been read. Archiving hides it from the sidebar; it stays recoverable.",
          WORKER_RETENTION.map((policy) => ({
            value: policy,
            label: policy,
            help: WORKER_RETENTION_DESCRIPTIONS[policy],
          })),
        )}
        {scope === null ? (
          <SettingRow
            label="Start new threads as orchestrators"
            hint={
              <>
                One plugin-wide default. Threads already open, child workers and side chats are not
                affected.
                <OptionHelp>
                  <OptionLine
                    label="On"
                    help="starts threads you create from the composer in orchestrator mode."
                  />
                  <OptionLine
                    label="Off"
                    help="leaves new threads ordinary; you can still switch any thread on yourself."
                  />
                </OptionHelp>
              </>
            }
          >
            <Button
              variant={newThreads ? "ghost" : "secondary"}
              size="sm"
              aria-pressed={!newThreads}
              disabled={loading || busy}
              className="h-7 px-2 text-xs"
              onClick={() => void saveNewThreads(false)}
            >
              Off
            </Button>
            <Button
              variant={newThreads ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={newThreads}
              disabled={loading || busy}
              className="h-7 px-2 text-xs"
              onClick={() => void saveNewThreads(true)}
            >
              On
            </Button>
          </SettingRow>
        ) : null}
        {enumRow(
          "workerModelPolicy",
          "Per-unit model overrides",
          "Whether a delegation may pick its own model. Pinned runs every worker on the execution below, or on a stored kind it names as a preset; flexible lets the orchestrator ask for a stronger or cheaper model for one unit.",
          WORKER_MODEL_POLICIES.map((policy) => ({
            value: policy,
            label: policy,
            help: WORKER_MODEL_POLICY_DESCRIPTIONS[policy],
          })),
        )}
        {enumRow(
          "orchestratorSubagents",
          "Orchestrator subagents",
          "Whether the orchestrator may start a provider's own subagents. A subagent that edits is the orchestrator doing the work, not delegating it.",
          ORCHESTRATOR_SUBAGENT_POLICIES.map((policy) => ({
            value: policy,
            label: policy,
            help: ORCHESTRATOR_SUBAGENT_POLICY_DESCRIPTIONS[policy],
          })),
        )}
        {enumRow(
          "workerSubagents",
          "Worker subagents",
          "Whether a worker may start subagents of its own. Blocked tells it the unit is its own to finish; a unit too big for that is reported rather than split.",
          WORKER_SUBAGENT_POLICIES.map((policy) => ({
            value: policy,
            label: policy,
            help: WORKER_SUBAGENT_POLICY_DESCRIPTIONS[policy],
          })),
        )}
        {numberRow(
          "maxRevisions",
          "Revisions per unit",
          "How many times one unit chain may be re-delegated after a failed check or a review rejection. The revision carries the reviewer's findings; 0 reports the failure instead.",
        )}
        {numberRow(
          "maxStallResumes",
          "Resumes for a stalled worker",
          "How many continue-messages a worker may receive after five minutes with no recorded activity. A resume continues the same session instead of starting another worker; after the budget the worker is reported as stuck.",
        )}
        {enumRow(
          "judgeAdvisory",
          "Advisory judge",
          "Whether minimized check evidence may be sent to Jev through OpenRouter. It needs a stored key as well, and it never records a verdict or blocks a unit.",
          [
            {
              value: "false",
              label: "off",
              help: "Off sends nothing, even when a key is stored.",
            },
            {
              value: "true",
              label: "on",
              help: "On sends only the check's verdict and the names of the commands it ran — no arguments, paths or output — and shows the answer as advice.",
            },
          ],
        )}
      </div>

      <div className="mt-3 border-t border-border/60 pt-3 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">Which provider and model workers use</div>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {execution === null
              ? "Workers use the project's remembered provider and model."
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
            onChange={(next) => void save({ ...execution, ...executionOf(next) })}
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
                  ...executionOf(next),
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
          Save a model and an access level per kind of work. A delegation can name a kind, and
          that unit runs on what you saved here instead of the default above. A kind left off
          uses the default.
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
        <div className="text-sm font-medium">Extra rules</div>
        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
          {scope === null
            ? "Appended to the contract as its own section. A rule adds to what the orchestrator is told; it does not replace what the watchdog enforces."
            : "Appended the same way. A project with rules of its own uses them in place of the global ones."}
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

      <div className="mt-3 border-t border-border/60 pt-3">
        <div className="text-sm font-medium">Advisory judge key</div>
        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
          Use the bundled <span className="font-medium text-foreground">setup-jev</span> skill or run{" "}
          <code className="font-mono">bb orchestrator-mode setup-jev</code> to open a secure prompt.
          The key is stored once as a secret and is never shown again.
        </p>
        <p className="mt-1 text-xs leading-snug text-subtle-foreground/75">
          A key alone sends nothing: the scope also has to opt in above. When both are on, a
          check's report gets a second opinion from Jev, which adds advice to the result and never
          records or blocks anything. The evidence contains only the check's verdict and allowlisted
          command names, not arguments, paths or output. The key is sent to OpenRouter for authentication.
        </p>
        <p className="mt-1 text-xs font-medium text-foreground" data-testid="orch-judge-key-state">
          {judge === null ? "" : judge.configured ? "Key stored." : "No key stored."}
        </p>
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

/** The settings keys the rows write; the RPC contract takes the same names. */
type SettingsKey = keyof SettingsViewDto;

/**
 * One row of the settings list: what the setting does, its control, and the state
 * the control writes from. Labels sit on the left and controls on the right, the
 * way BB's own settings rows read.
 */
function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        <div className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{hint}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * What every choice of one setting does, folded away. A row should read at a
 * glance, and the list is reference material for the moment you actually have to
 * pick: a `select` cannot explain the options it is not on, so the answer lives
 * one click under the row instead of in the label column.
 */
function OptionHelp({ children }: { children: ReactNode }) {
  return (
    <details className="mt-1">
      <summary className="w-fit cursor-pointer text-xs text-subtle-foreground/75 underline decoration-dotted underline-offset-2 hover:text-foreground">
        What each option does
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5">{children}</ul>
    </details>
  );
}

/**
 * One choice in a help list. A description that opens with the choice's own name
 * — the convention the shared description maps follow — has that name emphasised
 * where it already is rather than printed twice.
 */
function OptionLine({ label, help }: { label: string; help: string }) {
  const opening = `${label.charAt(0).toUpperCase()}${label.slice(1)} `;
  const names = help.startsWith(opening);
  return (
    <li>
      <span className="font-medium text-foreground/85">{names ? opening.trimEnd() : label}</span>{" "}
      {names ? help.slice(opening.length) : help}
    </li>
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

/**
 * The renderer behind `bb orchestrator-mode setup-jev`: the prompt the command
 * opens in BB so the key never has to be typed into a shell argument. It is
 * handed no stored key, and returns exactly `{ key }`; the backend validates
 * that shape and stores it in an owner-only file.
 *
 * The value lives in local state only. Saving is explicit, failure keeps the
 * typed value so it can be retried, and no error line or accessible text ever
 * carries the key itself.
 */
function SetupJev({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [key, setKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState<"save" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const errorId = useId();
  const fieldId = useId();

  // The payload's only field is a boolean: whether a key already exists. It is
  // never the key, and nothing secret is read back into this prompt.
  const payload = interaction.payload;
  const configured =
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    payload.configured === true;

  const save = async () => {
    if (pending !== null) return;
    const trimmed = key.trim();
    if (trimmed === "") {
      setError("Enter the key before saving.");
      return;
    }
    setPending("save");
    setError(null);
    try {
      await submit({ key: trimmed });
    } catch {
      setPending(null);
      setError("Could not submit the key. Try again.");
    }
  };

  const dismiss = async () => {
    if (pending !== null) return;
    setPending("cancel");
    setError(null);
    try {
      await cancel();
    } catch {
      setPending(null);
      setError("Could not cancel the prompt. Try again.");
    }
  };

  return (
    <form
      className="jev"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="jev__lede" id={hintId}>
        Paste the OpenRouter key the advisory judge uses. The plugin stores it privately and never
        shows it again.{configured ? " A key is already stored; saving replaces it." : ""}
      </p>
      <div className="jev__field">
        <label className="jev__label" htmlFor={fieldId}>
          OpenRouter key
        </label>
        <div className="jev__control">
          <input
            id={fieldId}
            className="jev__input"
            type={revealed ? "text" : "password"}
            value={key}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={pending !== null}
            aria-invalid={error !== null ? true : undefined}
            aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
            onChange={(event) => {
              setKey(event.target.value);
              setError(null);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={revealed}
            aria-controls={fieldId}
            disabled={pending !== null}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {error === null ? null : (
        <p className="jev__error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="jev__actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => void dismiss()}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending !== null}>
          {pending === "save" ? "Saving…" : "Save key"}
        </Button>
      </div>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "setup-jev",
    component: SetupJev,
  });

  app.slots.settingsSection({
    id: "scope",
    title: "Settings",
    description:
      "Pick a scope, then edit what it runs with. Global is what every project inherits; a project stores only what it changes. The plugin renders this section itself, since BB's settings form holds one value per install and these resolve per project.",
    component: ScopeSettings,
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
        run: async ({ composer: view }) => {
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
