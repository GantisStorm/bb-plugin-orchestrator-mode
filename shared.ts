// bb-plugin-orchestrator-mode — policy shared by the backend and the frontend.
//
// Everything here is pure: no SDK imports, no I/O. `server.ts` uses it to build
// the instruction block and to classify timeline rows, `app.tsx` uses it to
// label the composer surfaces, and `shared.test.ts` exercises it directly.
//
// Keeping the policy in one module matters because the two halves must agree:
// the instructions tell the agent exactly which acts the watchdog treats as
// "doing the work itself", so a change here has to change both at once.

/** How hard the plugin pushes back when an orchestrator does the work itself. */
export type EnforcementLevel = "instruct" | "guard" | "block";

/**
 * The tool an orchestrator delegates with. Defined here, next to the text that
 * names it, so the contract and the registration cannot drift apart.
 */
export const DELEGATE_TOOL = "orchestrator_delegate";

export const ENFORCEMENT_LEVELS: readonly EnforcementLevel[] = [
  "instruct",
  "guard",
  "block",
];

export const DEFAULT_ENFORCEMENT: EnforcementLevel = "guard";

/** One-line description of each level, for the composer, CLI and settings UI. */
export const ENFORCEMENT_DESCRIPTIONS: Record<EnforcementLevel, string> = {
  instruct: "Contract only: inject the orchestrator rules into every turn.",
  guard:
    "Contract + watchdog: detect direct work, record it and correct the agent.",
  block:
    "Contract + watchdog + stop: halt the turn the moment it does direct work.",
};

export function isEnforcementLevel(value: unknown): value is EnforcementLevel {
  return (
    typeof value === "string" &&
    (ENFORCEMENT_LEVELS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Worker execution control
// ---------------------------------------------------------------------------

/**
 * The reasoning levels a spawn accepts, mirroring the SDK's `ReasoningLevel`.
 * Narrower in practice: a provider only honours the rungs its model ladder has.
 */
export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The permission modes a spawn accepts, mirroring the SDK's `PermissionMode`. */
export const PERMISSION_MODES = ["auto", "accept-edits", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return (
    typeof value === "string" &&
    (REASONING_LEVELS as readonly string[]).includes(value)
  );
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

/**
 * Execution overrides for a spawned worker. An absent field is not "no value",
 * it is "inherit": the thread is spawned without it and BB resolves the
 * project's remembered default, then the provider catalog default.
 *
 * The block is forwarded to `threads.spawn` together with an
 * `executionInputSources` provenance stamp, because the server drops a
 * requested `providerId`/`model` that carries no source and silently re-derives
 * it from the project defaults.
 */
export interface WorkerExecution {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  permissionMode?: PermissionMode;
}

/** One model the SDK's own picker offers, with the provider that serves it. */
export interface WorkerModelOption {
  id: string;
  providerId: string;
}

/**
 * The provider/model catalog this plugin offers for workers, read from the same
 * `bb.sdk.providers` source the new-thread composer's pickers use. An empty
 * catalog means the read failed: nothing is offered and nothing is validated.
 */
export interface WorkerCatalog {
  providers: readonly string[];
  models: readonly WorkerModelOption[];
}

/**
 * The thread-metadata mirror of the plugin's authoritative state.
 *
 * `bb.agents.configure` is synchronous and its only per-thread input is
 * `context.pluginMetadata`, so the enabled flag has to be readable there. The
 * copy in this plugin's own KV store stays the source of truth and is rewritten
 * onto the thread at every dispatch admission, which runs before the turn does.
 */
// A type alias, not an interface: BB's `JsonObject` needs an implicit index
// signature, which only object-literal type aliases get.
export type OrchestratorMirror = {
  /** True while this thread must orchestrate instead of working. */
  enabled: boolean;
  /** Per-thread override, or null to follow the plugin setting. */
  enforcement: EnforcementLevel | null;
  /** Marks the mirror as ours, so a stale value from another writer is ignored. */
  source: "orchestrator-mode";
};

export const MIRROR_SOURCE = "orchestrator-mode" as const;

/** Parse an untrusted metadata namespace into a mirror, or null when absent. */
export function readMirror(
  metadata: Readonly<Record<string, unknown>>,
): OrchestratorMirror | null {
  const raw = metadata["orchestrator"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["source"] !== MIRROR_SOURCE) return null;
  if (typeof record["enabled"] !== "boolean") return null;
  const enforcement = isEnforcementLevel(record["enforcement"])
    ? record["enforcement"]
    : null;
  return { enabled: record["enabled"], enforcement, source: MIRROR_SOURCE };
}

/** The value written into a thread's plugin-metadata namespace. */
export function writeMirror(mirror: {
  enabled: boolean;
  enforcement: EnforcementLevel | null;
}): { orchestrator: OrchestratorMirror } {
  return {
    orchestrator: {
      enabled: mirror.enabled,
      enforcement: mirror.enforcement,
      source: MIRROR_SOURCE,
    },
  };
}

/**
 * Whether the plugin's "new threads start as orchestrators" default may apply
 * to a thread. Only a root thread a person started qualifies: a worker this
 * plugin spawned has a parent, and a side chat is a fork of the builtin
 * side-chat plugin. Both facts come from core, not from metadata, so the
 * thread's own agent cannot forge its way in or out.
 */
export function defaultAppliesTo(thread: {
  parentThreadId: string | null;
  originPluginId?: string | null;
}): boolean {
  if (thread.parentThreadId !== null) return false;
  if (thread.originPluginId === "side-chat") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Direct-work classification
// ---------------------------------------------------------------------------

/**
 * The slice of a timeline row the classifier needs. Structural on purpose: the
 * SDK's `TimelineRow` union is huge and versioned, and this keeps the policy
 * testable without importing it.
 */
export interface WorkRowLike {
  kind: string;
  workKind?: string | undefined;
  status?: string | undefined;
  toolName?: string | null | undefined;
  command?: string | null | undefined;
  change?: { path?: string | null } | null | undefined;
}

export interface Violation {
  /** Timeline row id, used to dedupe across scans. */
  id: string;
  turnId: string | null;
  workKind: string;
  /** Human-readable act, shown in the banner and the CLI. */
  detail: string;
  detectedAt: number;
}

export interface ClassifierOptions {
  /** Read-only shell commands are research, not work. Default true. */
  allowReadCommands: boolean;
}

const DEFAULT_CLASSIFIER_OPTIONS: ClassifierOptions = {
  allowReadCommands: true,
};

/**
 * Tool names that change something. A generic `tool` row that matches is doing
 * the work itself; one that does not is treated as research and allowed.
 */
const MUTATING_TOOL_PATTERN =
  /(write|edit|create|delete|remove|rename|move|copy|apply|patch|replace|append|insert|mkdir|touch|chmod|chown|commit|push|merge|rebase|reset|revert|checkout|install|build|compile|exec|execute|shell|bash|command|run|kill|upload|deploy|migrate|format|lint|test)/i;

/** Work kinds that are always the orchestrator doing the work itself. */
const ALWAYS_WORK: ReadonlySet<string> = new Set(["file-change", "command", "image-generation"]);

/** Work kinds that are always allowed: thinking, asking, and delegating. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  "delegation",
  "workflow",
  "question",
  "form",
  "approval",
  "plan-steps",
  "file-read",
  "search",
  "web-search",
  "web-fetch",
  "image-view",
]);

/** Shell metacharacters that split one command line into separate commands. */
const COMMAND_SEPARATORS = /(?:&&|\|\||[;|\n\r])/;

/** Leading `FOO=bar` environment assignments before the actual program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Programs that only look at things. `git` and `bb` are checked against their
 * subcommands separately, because both can also mutate.
 */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  "ls",
  "ll",
  "la",
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "find",
  "fd",
  "tree",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "which",
  "whereis",
  "type",
  "echo",
  "printf",
  "date",
  "env",
  "printenv",
  "uname",
  "hostname",
  "whoami",
  "id",
  "jq",
  "yq",
  "true",
  "test",
  "[",
  "diff",
  "cmp",
  "md5",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "realpath",
  "dirname",
  "basename",
]);

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "ls-files",
  "ls-tree",
  "describe",
  "rev-parse",
  "rev-list",
  "shortlog",
  "cat-file",
  "whatchanged",
  "count-objects",
  "name-rev",
  "merge-base",
  "for-each-ref",
]);

const GIT_BRANCH_LIST_OPTIONS: ReadonlySet<string> = new Set([
  "--list", "--all", "--remotes", "--verbose",
]);
const GIT_TAG_LIST_OPTIONS: ReadonlySet<string> = new Set(["--list", "-l", "-n"]);

/** Mixed Git subcommands need an explicit query form, not just a known name. */
function isReadOnlyGitSegment(rest: readonly string[]): boolean {
  const [subcommand, ...args] = rest;
  if (subcommand === undefined) return true;
  if (subcommand === "branch" || subcommand === "tag") {
    const isBranch = subcommand === "branch";
    const listing = args.includes("--list") || (!isBranch && args.includes("-l"));
    const options = isBranch ? GIT_BRANCH_LIST_OPTIONS : GIT_TAG_LIST_OPTIONS;
    return args.every((arg) =>
      options.has(arg) ||
      (isBranch && /^-[arv]+$/.test(arg)) ||
      (!isBranch && /^-n\d+$/.test(arg)) ||
      (listing && !arg.startsWith("-")),
    );
  }
  if (subcommand === "remote") {
    const query = args[0] === "-v" || args[0] === "--verbose" ? args.slice(1) : args;
    return query.length === 0 || query[0] === "show" || query[0] === "get-url";
  }
  if (subcommand === "reflog") {
    return args.length === 0 || args[0] === "show" || args[0] === "list" || args[0] === "exists";
  }
  if (subcommand === "config") {
    return args.some((arg) => arg === "--get" || arg === "--list" || arg === "-l");
  }
  return READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * `bb` subcommands that only report, with no second token to check.
 * Deliberately short: `bb thread`, `bb plugin` and `bb workflows` can all start
 * work, and an orchestrator has `orchestrator_delegate` for that anyway.
 */
const READ_ONLY_BB_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "guide"]);

/**
 * `bb <area> <verb>` pairs that only read. Kept as a table because the areas
 * themselves are mixed: `bb plugin list` reports, `bb plugin install` changes
 * the machine. `bb orchestrator-mode status` is read-only but `on`/`off` would
 * let a thread switch off its own leash, so only `status` is listed.
 */
const READ_ONLY_BB_VERBS: Record<string, ReadonlySet<string>> = {
  plugin: new Set(["list", "logs", "source", "search", "rpc", "outdated"]),
  // The orchestrator needs these to pick worker models the catalog can serve.
  provider: new Set(["list", "models"]),
  thread: new Set([
    "list",
    "show",
    "get",
    "log",
    "messages",
    "output",
    "history",
    "context",
    "count",
    "search",
    "wait",
  ]),
  "orchestrator-mode": new Set(["status"]),
};

/** `bb skill`/`bb skills` verbs that change the catalog rather than read it. */
const MUTATING_SKILL_VERBS: ReadonlySet<string> = new Set(["update", "remove", "install"]);

/** Asking for help or a version never changes anything. */
const HELP_OR_VERSION = /(?:^|\s)(?:--help|-h|--version)(?:\s|=|$)/;

/**
 * True when every command in a shell line only reads. Any redirect, any
 * unknown program, and any mutating `git`/`bb` subcommand makes it work.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return true;
  // A redirect writes, whatever the program is.
  if (/(^|[^>])>(?!&)/.test(trimmed) || />>/.test(trimmed)) return false;
  if (/\btee\b/.test(trimmed)) return false;
  // Command substitution can hide anything.
  if (/\$\(|`/.test(trimmed)) return false;

  const segments = trimmed.split(COMMAND_SEPARATORS);
  return segments.every((segment) => isReadOnlySegment(segment.trim()));
}

function isReadOnlySegment(segment: string): boolean {
  if (segment === "") return true;
  // `foo --help`, `foo -h` and `foo --version` report; they never mutate.
  if (HELP_OR_VERSION.test(segment)) return true;
  const tokens = segment.split(/\s+/);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) index += 1;
  const program = tokens[index];
  if (program === undefined) return true;
  const name = program.replace(/^.*\//, "");
  if (name === "git") return isReadOnlyGitSegment(tokens.slice(index + 1));
  if (name === "bb") return isReadOnlyBbSegment(tokens.slice(index + 1));
  return READ_ONLY_PROGRAMS.has(name);
}

function isReadOnlyBbSegment(rest: readonly string[]): boolean {
  const area = rest[0];
  if (area === undefined) return true;
  if (area.startsWith("-")) return false;
  if (READ_ONLY_BB_SUBCOMMANDS.has(area)) return true;
  if (area === "skill" || area === "skills") {
    const verb = rest[1];
    return verb === undefined || !MUTATING_SKILL_VERBS.has(verb);
  }
  const verbs = READ_ONLY_BB_VERBS[area];
  if (verbs === undefined) return false;
  const verb = rest[1];
  return verb !== undefined && verbs.has(verb);
}

/**
 * Classify one timeline row. Returns a violation when the row is the
 * orchestrator doing the work itself, or null when it is allowed.
 */
export function classifyRow(
  row: WorkRowLike & { id: string; turnId?: string | null },
  options: Partial<ClassifierOptions> = {},
): Violation | null {
  const { allowReadCommands } = { ...DEFAULT_CLASSIFIER_OPTIONS, ...options };
  if (row.kind !== "work") return null;
  const workKind = row.workKind ?? "";
  if (ALWAYS_ALLOWED.has(workKind)) return null;
  const turnId = row.turnId ?? null;
  const base = {
    id: row.id,
    turnId,
    workKind,
    detectedAt: Date.now(),
  };

  if (workKind === "file-change") {
    const path = row.change?.path ?? "a file";
    return { ...base, detail: `changed ${path} itself` };
  }

  if (workKind === "image-generation") {
    return { ...base, detail: "generated an image itself" };
  }

  if (workKind === "command") {
    const command = (row.command ?? "").trim();
    if (allowReadCommands && command !== "" && isReadOnlyCommand(command)) {
      return null;
    }
    const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return {
      ...base,
      detail: shown === "" ? "ran a shell command itself" : `ran \`${shown}\``,
    };
  }

  if (!ALWAYS_WORK.has(workKind)) {
    // A generic tool row: the provider's own vocabulary. Judge it by name.
    const toolName = row.toolName ?? null;
    if (toolName === null) return null;
    if (!MUTATING_TOOL_PATTERN.test(toolName)) return null;
    return { ...base, detail: `called \`${toolName}\` itself` };
  }

  return { ...base, detail: `did the work itself (${workKind})` };
}

// ---------------------------------------------------------------------------
// The contract the agent is handed
// ---------------------------------------------------------------------------

export interface InstructionInput {
  enforcement: EnforcementLevel;
  allowReadCommands: boolean;
  /** Extra lines a caller wants appended, e.g. recent violations. */
  reminders?: readonly string[];
  /** The worker execution defaults this plugin configures; absent = inherit. */
  workerExecution?: WorkerExecution;
}

/**
 * One sentence naming the execution the workers get, or the fact that this
 * plugin overrides nothing. Kept next to the contract it is spliced into, and
 * deliberately short: `configure` truncates the whole block at 4096 characters.
 */
export function workerBudget(execution: WorkerExecution | undefined): string {
  const exec = execution ?? {};
  const parts = [
    exec.model === undefined ? null : `model \`${exec.model}\``,
    exec.providerId === undefined ? null : `provider \`${exec.providerId}\``,
    exec.reasoningLevel === undefined
      ? null
      : `reasoning \`${exec.reasoningLevel}\``,
    exec.permissionMode === undefined
      ? null
      : `permission mode \`${exec.permissionMode}\``,
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? "Workers run on this project's own execution defaults."
    : `Workers default to ${parts.join(", ")}, set by this plugin.`;
}

/**
 * The orchestrator contract injected through `bb.agents.configure`.
 *
 * Hard cap: `configure` truncates dynamic instructions at 4096 characters, so
 * this must stay comfortably under it. `shared.test.ts` asserts the budget.
 */
export function buildInstructions(input: InstructionInput): string {
  const watching =
    input.enforcement === "instruct"
      ? "This is a standing contract; nothing is watching your tool calls."
      : input.enforcement === "guard"
        ? "A watchdog reads your timeline. Every direct-work act is recorded and reported back to you, and you will be told to re-delegate it."
        : "A watchdog reads your timeline and STOPS the turn the moment you do direct work. Work you did yourself is thrown away.";

  const commands = input.allowReadCommands
    ? "Read-only shell commands (`ls`, `cat`, `rg`, `git status`, `git diff`, `git log`, `find`, `wc`) are allowed so you can orient yourself. Anything that writes, builds, installs, commits or otherwise changes state is not."
    : "Do not run shell commands at all. Reading files and searching is enough to orient yourself.";

  const reminders =
    input.reminders === undefined || input.reminders.length === 0
      ? ""
      : `\n\nYou have already broken this contract in this thread:\n${input.reminders
          .slice(-5)
          .map((line) => `- ${line}`)
          .join("\n")}`;

  return `# ORCHESTRATOR MODE IS ON FOR THIS THREAD

You are an orchestrator. You do not do the work. Every unit of actual work is
handed to a worker thread, and your own output is the plan, the delegation, and
the synthesis of what came back.

${watching}

## Forbidden — doing the work yourself

- Editing, creating, overwriting, moving or deleting any file.
- Generating images instead of delegating their creation.
- Running a command that changes anything: builds, installs, tests, git commits
  and pushes, code generation, migrations, formatters, scripts.
- Writing the implementation yourself, even "just this one small fix", even
  inside a reply, even when the worker would take longer.
- Fixing up a worker's output by hand instead of sending it back to a worker.

${commands}

## Required — how you work instead

1. Understand the request. Read and search freely; ask the user when the goal
   is ambiguous.
2. Decompose it into independent units of work with explicit, self-contained
   briefs. A worker cannot see this conversation, so each brief carries its own
   goal, context, constraints and definition of done.
3. Delegate every unit with the \`${DELEGATE_TOOL}\` tool. Fan out independent
   units in parallel; sequence only the ones with a real dependency. If that
   tool is not in your tool list, this provider session was constructed before
   the mode was switched on and cannot gain tools mid-flight: do no work,
   invent no substitute mechanism, say plainly that the tool arrives with the
   next session, and stop.
4. Review what comes back. If a result is wrong or incomplete, send a follow-up
   to a worker — never patch it yourself.
5. Report by synthesizing: what was delegated, what each worker produced, what
   is left. Link worker threads by id so the user can open them.

## When you may act directly

Only these: reading, searching, planning, asking the user a question,
delegating, and reporting. If you are about to call a tool that changes
something, stop and delegate it instead.

## Choosing the worker's model

${workerBudget(input.workerExecution)} Override it per delegation with the
\`model\`, \`provider\`, \`reasoning\` and \`permissionMode\` arguments of
\`${DELEGATE_TOOL}\` — give a hard unit a stronger model and a mechanical one a
cheaper one. Valid ids come from the catalog: \`bb provider list\` names the
providers, \`bb provider models <provider>\` lists their models. Both are
read-only.

## If you cannot delegate

Say so plainly and stop. "I cannot do this without doing the work myself" is a
correct answer; doing the work yourself is not. Do not disable or argue with
this mode — ask the user to turn it off in the composer if it is wrong.${reminders}`;
}

/** The corrective message sent after a detected violation. */
export function buildNudge(violations: readonly Violation[], enforcement: EnforcementLevel): string {
  const acts = violations
    .slice(0, 5)
    .map((violation) => `- ${violation.detail}`)
    .join("\n");
  const stopped =
    enforcement === "block"
      ? " The turn was stopped, so any change you made mid-flight may be incomplete."
      : "";
  const missingTool =
    "\n\nIf `" +
    DELEGATE_TOOL +
    "` is not among your tools, this session predates the mode and cannot gain tools mid-flight. Do not improvise another delegation mechanism and do not retry the work: say plainly that the tool arrives with the next session, and stop.";
  return `Orchestrator mode caught you doing the work yourself:${stopped}

${acts}

Do not continue that work and do not clean it up yourself. Re-delegate it: give
a worker thread a self-contained brief with \`${DELEGATE_TOOL}\`, then synthesize
what comes back. If the work genuinely cannot be delegated, say so and stop.
If orchestrator mode is wrong for this thread, ask the user to turn it off in
the composer rather than working around it.${missingTool}`;
}
