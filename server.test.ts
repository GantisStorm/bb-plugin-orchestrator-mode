import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeSecretStore } from "./judge-secret";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi, PluginSettingValue } from "@get-bb/plugin-sdk";
import { CHECK_TOOL, REVIEW_TOOL } from "./shared";
import plugin, {
  DELEGATE_TOOL,
  checkWriteAllowed,
  judgeCheckVerdict,
  parseCheckVerdict,
  type OrchestratorStateDto,
} from "./server";
import { writeMirror } from "./shared";
import { CHILD_BATCH_WAIT_REASON } from "./child-message-queue";

describe("the advisory judge", () => {
  const decision = (noul: number) =>
    (async () =>
      new Response(JSON.stringify({ answers: { verified: { type: "noul", noul } } }), {
        status: 200,
      })) as unknown as typeof fetch;
  const report = "npm test\nVERDICT: pass\nall green";
  const NO_EVIDENCE =
    "the check named no program that can be sent safely (only an allowlisted program name and the pass/fail verdict are sent, never arguments, paths or output)";

  it("reads the probability Jev returns as agreement or disagreement", async () => {
    expect(await judgeCheckVerdict("k", report, decision(0.92))).toEqual({
      ok: true,
      opinion: {
        agrees: true,
        rationale: "Jev put 92% on the report showing the work was actually verified.",
      },
    });
    expect(await judgeCheckVerdict("k", report, decision(0.08))).toEqual({
      ok: true,
      opinion: {
        agrees: false,
        rationale: "Jev put 8% on the report showing the work was actually verified.",
      },
    });
  });

  it("names why an unusable answer failed instead of hiding it", async () => {
    const prose = (async () =>
      new Response(JSON.stringify({ answers: { verified: { noul: "yes" } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await judgeCheckVerdict("k", report, prose)).toEqual({
      ok: false,
      error: "OpenRouter's answer carried no probability",
    });
    const notJson = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await judgeCheckVerdict("k", report, notJson)).toEqual({
      ok: false,
      error: "OpenRouter's answer was not JSON",
    });
  });

  it("does not ask anything without a key or evidence", async () => {
    let called = false;
    const capture = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await judgeCheckVerdict("", report, capture)).toEqual({
      ok: false,
      error: "no OpenRouter key is stored",
    });
    expect(await judgeCheckVerdict("k", "   ", capture)).toEqual({
      ok: false,
      error: NO_EVIDENCE,
    });
    expect(called).toBe(false);
  });

  it("reports a refusal or an unreachable endpoint rather than returning nothing", async () => {
    const refused = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    expect(await judgeCheckVerdict("k", report, refused)).toEqual({
      ok: false,
      error: "OpenRouter refused the request (HTTP 401)",
    });
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await judgeCheckVerdict("k", report, down)).toEqual({
      ok: false,
      error: "OpenRouter could not be reached (offline)",
    });
  });

  it("sends only allowlisted program names, never an argument, header or credential", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const capture = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ answers: { verified: { type: "noul", noul: 0.9 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const noisy = [
      "Private project notes that should stay local.",
      "ran `npm test -- auth.spec.ts`",
      "npm test -- auth.spec.ts",
      // Basic auth: the password is an argument, so only "curl" may leave.
      "$ curl -u admin:hunter2 https://example.test/status",
      "$ curl -H 'Authorization: Basic dXNlcjpwYXNz' https://example.test/status",
      "$ curl -H 'Authorization: Bearer sk-live-secret-value-123456789' https://example.test/status",
      // A JWT as a header value, under the 40-character opaque-token guard.
      "git -c http.extraHeader='Authorization: Bearer aaa.bbb.ccc' fetch origin",
      "python3 /Users/nate/private/export_hunter2.py --token abc123",
      // A program outside the allowlist names nothing at all.
      "psql postgres://app:s3cret-pw@db.internal.example/app",
      "PASSWORD=hunter2-must-never-leave npm run deploy",
      "See src/auth.ts for the change.",
      "We should go through the parser and make it faster, then git it done.",
      "VERDICT: pass the suite is green",
    ].join("\n");
    await judgeCheckVerdict("sk-test", noisy, capture);
    expect(sent!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(sent!.init.body)) as { state: string; model: string };
    expect(body.model).toBe("typesafe/jev-1.13");
    // The bare verdict token and the program names, once each, and nothing else.
    expect(body.state).toBe("VERDICT: pass\nCOMMANDS: npm, curl, git, python3");
    for (const secret of [
      "hunter2",
      "dXNlcjpwYXNz",
      "sk-live",
      "aaa.bbb.ccc",
      "/Users/nate",
      "s3cret",
      "app:",
      "auth.spec.ts",
      "src/auth.ts",
      "export_hunter2.py",
      "abc123",
    ]) {
      expect(body.state).not.toContain(secret);
    }
  });

  it("refuses to ask when only prose or non-allowlisted programs remain", async () => {
    let called = false;
    const capture = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const prose = [
      "We should go through the parser and make it faster.",
      "The reviewer said to git it done.",
      "psql postgres://app:s3cret-pw@db.internal.example/app",
      "DATABASE_URL=postgres://app:s3cret-pw@db.internal.example/app npm run deploy",
    ].join("\n");
    const outcome = await judgeCheckVerdict("sk-test", prose, capture);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe(NO_EVIDENCE);
    expect(called).toBe(false);
  });

  it("never sends the verdict line's reasoning sentence", async () => {
    let sent = "";
    const capture = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ answers: { verified: { type: "noul", noul: 0.4 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const secretive = [
      "npm test -- auth.spec.ts",
      "VERDICT: fail — the token in config/prod.json is expired, and customer_42's export still fails",
    ].join("\n");
    await judgeCheckVerdict("sk-test", secretive, capture);
    const state = (JSON.parse(sent) as { state: string }).state;
    expect(state).toBe("VERDICT: fail\nCOMMANDS: npm");
    expect(state).not.toContain("config/prod.json");
    expect(state).not.toContain("customer_42");
    expect(state).not.toContain("expired");
  });

  it("sends a name-only line even beside credentials, and refuses when no name is allowlisted", async () => {
    let called = false;
    const capture = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const report = [
      "$ curl -H 'Authorization: Bearer sk-live-secret-value-123456789' https://internal.test/status",
      "PASSWORD=hunter2-must-never-leave npm run deploy",
      "gh api /repos/acme/private/issues -f token=ghp_abcdefghijklmnop",
      "VERDICT: pass",
    ].join("\n");
    // `curl` is allowlisted, so its bare name is sent; the credits, headers and
    // repository path are not. Nothing else in the report survives.
    let sent = "";
    const inspect = (async (_url: string, init: RequestInit) => {
      called = true;
      sent = String(init.body);
      return new Response(JSON.stringify({ answers: { verified: { type: "noul", noul: 0.5 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await judgeCheckVerdict("sk-test", report, inspect);
    expect(called).toBe(true);
    expect((JSON.parse(sent) as { state: string }).state).toBe("VERDICT: pass\nCOMMANDS: curl");
    // A report whose only command is outside the allowlist is not evidence.
    const outcome = await judgeCheckVerdict(
      "sk-test",
      ["gh api /repos/acme/private/issues -f token=ghp_abcdefghijklmnop", "VERDICT: pass"].join("\n"),
      capture,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe(NO_EVIDENCE);
    expect(called).toBe(true);
  });

  it("stops waiting on OpenRouter when the call's own deadline runs out", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const stalled = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        })) as unknown as typeof fetch;
      const pending = judgeCheckVerdict("k", report, stalled, { remainingMs: 1_500 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toEqual({
        ok: false,
        error: "OpenRouter did not answer within 2s, so no opinion was produced",
      });
      // The request itself was cut off, not merely ignored.
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the request when the call is cancelled", async () => {
    const controller = new AbortController();
    let aborted = false;
    const stalled = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    const pending = judgeCheckVerdict("k", report, stalled, {
      remainingMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: "the call was cancelled while the advisory judge was waiting, so no opinion was produced",
    });
    expect(aborted).toBe(true);
  });

  it("refuses before calling when the call is already over or cancelled", async () => {
    let called = false;
    const capture = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await judgeCheckVerdict("k", report, capture, { remainingMs: 0 })).toEqual({
      ok: false,
      error: "the call's deadline passed, so the advisory judge was not asked",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await judgeCheckVerdict("k", report, capture, { signal: controller.signal })).toEqual({
      ok: false,
      error: "the call was cancelled, so the advisory judge was not asked",
    });
    expect(called).toBe(false);
  });
});

const THREAD = "th_orchestrator";
const WORKER = "th_worker";
/** The project the SDK's dispatch-hook fixture uses, so a project override set through it applies to this thread too. */
const PROJECT = "project-1";
/** When the orchestrator was created, in ms. A thread in its project created after this could be one it spawned. */
const CREATED_AT = 1_700_000_000_000;
type QueueEntry = ReturnType<typeof makeQueueEntry>;

function childEntry(id: string, senderThreadId = WORKER, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return makeQueueEntry({
    id, threadId: THREAD, initiator: "agent", senderThreadId,
    content: [{ type: "text", text: `Full content of ${id}`, mentions: [] }],
    waitingOn: { kind: "plugin", pluginId: "orchestrator-mode", reason: "Waiting for the turn to finish" },
    ...overrides,
  });
}

/** Native queue contract: mutations touch ordering/group edges, never content. */
function queueFixture(harness: FakePluginHarness, initial: QueueEntry[]) {
  const queue = { entries: structuredClone(initial) };
  const snapshot = () => structuredClone(queue.entries);
  harness.inspection.sdk.stub("threads.queuedMessages.list", async () => snapshot());
  const reorder = vi.fn(async ({ queuedMessageId, previousQueuedMessageId, nextQueuedMessageId }) => {
    const index = queue.entries.findIndex((entry) => entry.id === queuedMessageId);
    const previous = queue.entries.findIndex((entry) => entry.id === previousQueuedMessageId);
    const next = queue.entries.findIndex((entry) => entry.id === nextQueuedMessageId);
    if (index < 0 || previous < 0 || next < 0 || previous >= next) throw new Error("stale neighbor");
    const [entry] = queue.entries.splice(index, 1);
    queue.entries.splice(queue.entries.findIndex((entry) => entry.id === nextQueuedMessageId), 0, entry!);
    return snapshot();
  });
  const group = vi.fn(async ({ expectedGroupedPrefixQueuedMessageIds, groupBoundaryQueuedMessageId }) => {
    const index = queue.entries.findIndex((entry) => entry.id === groupBoundaryQueuedMessageId);
    const prefix = queue.entries.slice(0, index + 1);
    if (index < 0 || JSON.stringify(prefix.map((entry) => entry.id)) !==
      JSON.stringify(expectedGroupedPrefixQueuedMessageIds)) throw new Error("stale prefix");
    const first = prefix[0]!;
    if (prefix.some((entry) => entry.senderThreadId !== first.senderThreadId || entry.model !== first.model ||
      entry.reasoningLevel !== first.reasoningLevel || entry.permissionMode !== first.permissionMode ||
      entry.serviceTier !== first.serviceTier)) throw new Error("incompatible group");
    queue.entries.forEach((entry, position) => { entry.groupWithNext = position < index; });
    return snapshot();
  });
  harness.inspection.sdk.stub("threads.queuedMessages.reorder", reorder);
  harness.inspection.sdk.stub("threads.queuedMessages.setGroupBoundary", group);
  return {
    queue, group, reorder,
    claim() {
      let count = 1;
      while (queue.entries[count - 1]?.groupWithNext && count < queue.entries.length) count++;
      return queue.entries.splice(0, count);
    },
  };
}

/** Timeline rows the watchdog reads, mutated per test. */
let timelineRows: unknown[] = [];
let timelineMaxSeq = 0;
/** The worker's own timeline rows, returned for the worker thread only. */
let workerRows: unknown[] = [];
let workerMaxSeq = 0;
/** Per-thread plugin-metadata namespaces, as the server would store them. */
let metadata: Record<string, Record<string, unknown>> = {};
let sentTexts: string[] = [];
let stoppedThreads: string[] = [];
let archivedThreads: string[] = [];
let spawned: Record<string, unknown>[] = [];
/**
 * Threads `threads.list` can return. A child is found by `parentThreadId`, a
 * fork by `sourceThreadId` (its parent is null), and any thread in a project by
 * `projectId`. A hidden thread is returned only when the caller passes
 * `includeHidden`; a deleted thread never, an archived one only when the caller
 * asks for archived rows; `limit`/`offset` page whatever is left.
 */
let childThreads: {
  id: string;
  parentThreadId?: string | null;
  sourceThreadId?: string | null;
  hidden?: boolean;
  projectId?: string;
  createdAt?: number;
  /** The child's title, which a reconciliation matches a check unit by. */
  title?: string;
  /** BB's execution status, as the live child count filters on it. */
  status?: string;
  /** When BB archived the thread; a list read leaves archived rows out. */
  archivedAt?: number | null;
  /** When BB deleted the thread; a list read never returns a deleted row. */
  deletedAt?: number | null;
}[] = [];

/** Every loaded host, disposed after each test so no scan timer leaks into the next. */
const hosts: FakePluginHarness[] = [];

/** A provider/model catalog the fake host serves to the plugin at load. */
interface ProviderCatalogFixture {
  providers?: { id: string; available: boolean }[];
  models?: Record<string, { id: string }[]>;
}

/** The retry target the delegation-failure tests store. */
const RETRY_TARGET = { providerId: "claude-code", model: "claude-opus-5-5" };

/** The catalog the delegation tests resolve worker ids against. */
const CATALOG: ProviderCatalogFixture = {
  providers: [
    { id: "acp-omp", available: true },
    { id: "claude-code", available: true },
  ],
  models: {
    "acp-omp": [{ id: "command-code/deepseek/deepseek-v4.1-flash-fast" }],
    "claude-code": [
      { id: "claude-opus-5-5" },
      { id: "claude-haiku-4-5-20251001" },
    ],
  },
};

/** A catalog for the explicit worker-pin regression cases. */
const PIN_CATALOG: ProviderCatalogFixture = {
  providers: [{ id: "grok", available: true }],
  models: { grok: [{ id: "grok-test-model" }] },
};

function workRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "work",
    id: `row_${Math.random().toString(36).slice(2, 8)}`,
    threadId: THREAD,
    turnId: "turn_1",
    status: "completed",
    sourceSeqStart: timelineMaxSeq + 1,
    sourceSeqEnd: timelineMaxSeq + 2,
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

/** The concatenated text of a send/spawn `input` block array. */
function textOf(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((block) =>
      block !== null && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("\n");
}


/**
 * The rows this build persists: one table row per thread in the plugin's own
 * database, not the single KV map the previous build wrote.
 */
function persistedRows(bb: BbPluginApi): Record<string, unknown> {
  const rows = bb.storage
    .database()
    .prepare("SELECT thread_id, state FROM thread_state")
    .all() as { thread_id: string; state: string }[];
  return Object.fromEntries(rows.map((row) => [row.thread_id, JSON.parse(row.state) as unknown]));
}

const testDataDirs: string[] = [];

async function load(
  settings: Record<string, PluginSettingValue> = {},
  seedState?: Record<string, unknown>,
  catalog: ProviderCatalogFixture = {},
  seedKv?: Record<string, unknown>,
  seedQueue?: QueueEntry[],
): Promise<{ bb: BbPluginApi; harness: FakePluginHarness }> {
  const providers = catalog.providers ?? [{ id: "acp-omp", available: true }];
  const modelsByProvider = catalog.models ?? {
    "acp-omp": [{ id: "command-code/deepseek/deepseek-v4.1-flash-fast" }],
  };
  const testRoot = mkdtempSync(join(tmpdir(), "orch-key-test-"));
  testDataDirs.push(testRoot);
  const host = createFakePluginHost({
    pluginId: "orchestrator-mode",
    dataDir: join(testRoot, "data"),
    sdk: {
      providers: {
        models: async ({ providerId }: { providerId?: string } = {}) => {
          if (providerId !== undefined) {
            return {
              providers: [],
              models: (modelsByProvider[providerId] ?? []).map((model) => ({
                ...model,
                model: model.id,
                description: "",
                isDefault: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "medium" as const,
              })),
            };
          }
          return {
            providers: providers.map((provider) => ({
              id: provider.id,
              available: provider.available,
              displayName: provider.id,
            })),
            models: [],
          };
        },
      },
      threads: {
        queuedMessages: { list: async () => [] },
        queue: { list: async () => seedQueue ?? [] },
        getPluginMetadata: async ({ threadId }: { threadId: string }) =>
          metadata[threadId] ?? {},
        updatePluginMetadata: async ({
          threadId,
          set,
          remove,
        }: {
          threadId: string;
          set?: Record<string, unknown>;
          remove?: string[];
        }) => {
          const current = { ...(metadata[threadId] ?? {}) };
          for (const key of remove ?? []) delete current[key];
          Object.assign(current, set ?? {});
          metadata[threadId] = current;
          return current;
        },
        timeline: async ({ threadId }: { threadId: string }) =>
          threadId === WORKER ? { rows: workerRows, maxSeq: workerMaxSeq } : { rows: timelineRows, maxSeq: timelineMaxSeq },
        // The list route, as BB serves it: a deleted thread is never returned,
        // an archived one only when the caller asks for archived rows, a hidden
        // one only with `includeHidden`, and `limit`/`offset` page the rest.
        list: async (args: {
          parentThreadId?: string;
          sourceThreadId?: string;
          projectId?: string;
          includeHidden?: boolean;
          archived?: boolean;
          limit?: number;
          offset?: number;
        } = {}) => {
          const rows = childThreads
            .filter((child) => {
              if (child.deletedAt != null) return false;
              // `archived` is tri-state on the route: omitted returns both,
              // false only current rows, true only archived ones.
              if (args.archived === false && child.archivedAt != null) return false;
              if (args.archived === true && child.archivedAt == null) return false;
              if (child.hidden === true && args.includeHidden !== true) return false;
              if (args.parentThreadId !== undefined && child.parentThreadId !== args.parentThreadId) return false;
              if (args.sourceThreadId !== undefined && child.sourceThreadId !== args.sourceThreadId) return false;
              if (args.projectId !== undefined && child.projectId !== args.projectId) return false;
              return true;
            })
            // The wire shape the plugin reads: a page row carries its archive
            // and delete markers as `null`, never as an absent field.
            .map((child) => ({
              ...child,
              archivedAt: child.archivedAt ?? null,
              deletedAt: child.deletedAt ?? null,
              status: child.status ?? "idle",
              visibility: child.hidden === true ? "hidden" : "visible",
            }));
          const start = args.offset ?? 0;
          return args.limit === undefined ? rows.slice(start) : rows.slice(start, start + args.limit);
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            providerId: "acp-omp",
            environmentId: threadId === WORKER ? null : "env_1",
            parentThreadId: threadId === WORKER ? THREAD : null,
            projectId: PROJECT,
            createdAt: CREATED_AT,
          }),
        spawn: async (args) => {
          spawned.push(args as unknown as Record<string, unknown>);
          return makeThreadResponse({ id: WORKER, parentThreadId: THREAD });
        },
        wait: async () => ({ matched: true, threadId: WORKER }),
        output: async () => ({ output: "the worker finished the task" }),
        send: async (args) => {
          sentTexts.push(textOf((args as { input?: unknown }).input));
          return { threadId: THREAD };
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stoppedThreads.push(threadId);
          return { threadId };
        },
        archive: async ({ threadId }: { threadId: string }) => {
          archivedThreads.push(threadId);
          return { threadId };
        },
      },
    },
  });
  if (seedQueue) queueFixture(host.harness, seedQueue);
  if (seedState !== undefined) {
    await host.bb.storage.kv.set("state", seedState);
  }
  for (const [key, value] of Object.entries(seedKv ?? {})) {
    await host.bb.storage.kv.set(key, value);
  }
  // The plugin owns the global settings record in KV rather than through BB
  // settings descriptors, so the values a test names seed that record.
  if (Object.keys(settings).length > 0) {
    await host.bb.storage.kv.set("settings", settings);
  }
  await plugin(host.bb);
  // The real host starts services after registration; the official fake host
  // drives them explicitly. Most tests exercise the ready steady state.
  await host.harness.behavior.runService("worker-catalog").done;
  await host.harness.behavior.runService("queue-recovery").done;
  // Keep request call counts separate from startup reads. startup.test.ts
  // covers unresolved, failed, and disposed discovery independently.
  host.harness.inspection.sdk.calls.length = 0;
  hosts.push(host.harness);
  return host;
}

/**
 * The interaction form the plugin just asked BB to show, once BB has it pending.
 * `requestInput` resolves only after the user acts, so a test starts the CLI
 * call, waits here, then submits or cancels through the harness.
 */
async function pendingForm(
  harness: FakePluginHarness,
): Promise<FakePluginHarness["inspection"]["pendingInteractions"][number]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = harness.inspection.pendingInteractions;
    const last = pending[pending.length - 1];
    if (last !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the plugin never opened a form");
}

beforeEach(() => {
  timelineRows = [];
  workerRows = [];
  workerMaxSeq = 0;
  metadata = {};
  sentTexts = [];
  stoppedThreads = [];
  archivedThreads = [];
  spawned = [];
  childThreads = [];
});

afterEach(async () => {
  for (const harness of hosts.splice(0)) {
    await harness.lifecycle.dispose();
  }
  for (const root of testDataDirs.splice(0)) rmSync(root, { recursive: true, force: true });
  // Let any scan already in flight settle before the next test swaps the stubs.
  await new Promise((resolve) => setTimeout(resolve, 30));
});

/** Turn the mode on through the same RPC the composer uses. */
async function enable(
  harness: FakePluginHarness,
  threadId = THREAD,
  enforcement?: "instruct" | "guard" | "block",
): Promise<void> {
  await harness.behavior.callRpc("set_enabled", {
    threadId,
    enabled: true,
    ...(enforcement === undefined ? {} : { enforcement }),
  });
}

async function idle(harness: FakePluginHarness): Promise<void> {
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: THREAD }),
    lastAssistantText: null,
  });
}

/**
 * Model the session lag: the turn in flight when the mode is enabled, and the
 * first turn after it, run in a provider session that never received the
 * contract or the tool, so neither is judged. Tests that expect a violation
 * therefore act on the third turn.
 */
async function arm(harness: FakePluginHarness): Promise<void> {
  timelineRows = [
    workRow({ id: "row_prior", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
  ];
  timelineMaxSeq = 1;
  await enable(harness);
  timelineRows = [
    ...timelineRows,
    workRow({ id: "row_first", workKind: "file-read", turnId: "turn_1", sourceSeqStart: 2, sourceSeqEnd: 2 }),
  ];
  timelineMaxSeq = 2;
  await idle(harness);
  await new Promise((resolve) => setTimeout(resolve, 350));
}

describe("agent configuration", () => {
  it("does not start a turn just to notify an idle thread", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    expect(sentTexts).toEqual([]);
  });

  it("notifies an active session when its mode changes", async () => {
    const { harness } = await load();
    harness.inspection.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: THREAD, status: "active" }),
    );
    await enable(harness);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain("ORCHESTRATOR MODE IS ON");
    expect(sentTexts[0]).toContain("bb orchestrator-mode delegate");
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    expect(sentTexts).toHaveLength(2);
    expect(sentTexts[1]).toContain("Orchestrator mode is now off");
  });

  it("hands an enabled thread the contract and the delegation tool", async () => {
    const { harness } = await load();
    await enable(harness);
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(resolved.instructions).toContain("ORCHESTRATOR MODE IS ON");
    // The contract names both tools, so the session must receive both.
    expect(resolved.tools.map((tool) => tool.name)).toEqual([DELEGATE_TOOL, REVIEW_TOOL, CHECK_TOOL]);
  });

  it("contributes nothing to a thread that is not orchestrating", async () => {
    const { harness } = await load();
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: false, enforcement: null }),
      }),
    );
    expect(resolved.instructions).toBeNull();
    expect(resolved.tools).toEqual([]);
  });

  it("tells a plugin-spawned worker it owns its unit, and only while the scope blocks subagents", async () => {
    const { harness } = await load();
    const worker = makePluginAgentConfigurationContext({
      thread: { id: WORKER, parentThreadId: THREAD },
      // What the plugin stamps on a thread it spawned itself.
      pluginMetadata: { workerFor: THREAD },
    });
    const blocked = await harness.behavior.resolveAgentConfiguration(worker);
    expect(blocked.instructions).toContain("Start no subagents");
    expect(blocked.instructions).toContain("`task`");
    expect(blocked.tools).toEqual([]);

    // Nothing is removed from the worker's provider either way; the scope only
    // decides whether this plugin's rule is injected.
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "workerSubagents",
      value: "allowed",
    });
    const allowed = await harness.behavior.resolveAgentConfiguration(worker);
    expect(allowed.instructions).toBeNull();
    expect(allowed.tools).toEqual([]);
  });

  it("leaves a thread that carries no worker stamp alone", async () => {
    const { harness } = await load();
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "th_plain" }, pluginMetadata: {} }),
    );
    expect(resolved.instructions).toBeNull();
  });

  it.each(["blocked", "allowed"])("inherits worker subagents %s without changing unit, retry or verifier permissions", async (policy) => {
    const { harness } = await load({ workerSubagents: policy === "allowed" ? "blocked" : "allowed" }, undefined, CATALOG);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: "proj_1", key: "workerSubagents", value: policy,
    });
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp", model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      permissionMode: "accept-edits", fallback: RETRY_TARGET,
    });
    let count = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `unit_${++count}`, parentThreadId: THREAD, environmentId: "env_1" });
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "unit_1" ? "error" : "idle" }));
    await enable(harness);
    await harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Complete the unit", verify: true }, {
      threadId: THREAD, projectId: "proj_1",
    });
    expect(spawned).toHaveLength(3);
    for (const [index, args] of spawned.entries()) {
      expect(args.permissionMode).toBe("accept-edits");
      expect(args.executionInputSources).toMatchObject({ permissionMode: "explicit" });
      const configured = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
        project: { id: "proj_1" }, thread: { id: `unit_${index + 1}`, parentThreadId: THREAD },
        pluginMetadata: args.pluginMetadata as { workerFor: string },
      }));
      expect(configured.tools).toEqual([]);
      if (policy === "blocked") expect(configured.instructions).toContain("Start no subagents");
      else expect(configured.instructions).toBeNull();
    }
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: "proj_1", key: "workerSubagents", value: null,
    });
    const inherited = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      project: { id: "proj_1" }, thread: { id: "unit_1", parentThreadId: THREAD },
      pluginMetadata: { workerFor: THREAD },
    }));
    if (policy === "allowed") expect(inherited.instructions).toContain("Start no subagents");
    else expect(inherited.instructions).toBeNull();
  });

  it("honours a per-thread enforcement override in the contract", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: true, enforcement: "block" }),
      }),
    );
    expect(resolved.instructions).toContain("STOPS the turn");
  });

  it("never governs a mirror-less thread from the default alone", async () => {
    // configure is synchronous and receives no createdAt, so it must not guess.
    // A default left on reaching every mirror-less thread is exactly the bug
    // that once governed the whole app; only the dispatch hook, which has
    // createdAt, may apply it.
    const { harness } = await load({ defaultForNewThreads: true });
    for (const context of [
      makePluginAgentConfigurationContext({ thread: { id: "th_root", parentThreadId: null } }),
      makePluginAgentConfigurationContext({
        thread: { id: WORKER, parentThreadId: THREAD },
      }),
      makePluginAgentConfigurationContext({
        thread: { id: "th_side" },
        origin: { kind: "fork", pluginId: "side-chat" },
      }),
    ]) {
      const resolved = await harness.behavior.resolveAgentConfiguration(context);
      expect(resolved.instructions).toBeNull();
      expect(resolved.tools).toEqual([]);
    }
  });

  it("leaves ordinary threads alone when the default is off", async () => {
    const { harness } = await load();
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "th_root", parentThreadId: null } }),
    );
    expect(resolved.instructions).toBeNull();
    expect(resolved.tools).toEqual([]);
  });

  it("ignores a mirror another writer forged", async () => {
    const { harness } = await load();
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: { orchestrator: { enabled: true, source: "some-other-plugin" } },
      }),
    );
    expect(resolved.instructions).toBeNull();
  });

  it("still hands the contract over when a stored violation is malformed", async () => {
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date().toISOString(),
        touchedAt: Date.now(),
        violations: [null],
        seenRowIds: [],
        lastSeq: 0,
        graceTurnIds: [],
        graceSlots: 1,
        nudgeCount: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        delegations: [],
        turnStartedAt: 0,
        lastReviewNudge: null,
      },
    });
    // Warm the state cache the synchronous configure callback reads.
    await harness.behavior.callRpc("get_state", { threadId: THREAD });
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(resolved.instructions).toContain("ORCHESTRATOR MODE IS ON");
    expect(resolved.tools.map((tool) => tool.name)).toEqual([DELEGATE_TOOL, REVIEW_TOOL, CHECK_TOOL]);
  });
});

describe("the dispatch checkpoint", () => {
  async function dispatch(
    harness: FakePluginHarness,
    threadId: string,
    threadOverrides: Record<string, unknown> = {},
    contextOverrides: Record<string, unknown> = {},
  ) {
    const handler = harness.inspection.registrations.hooks["message.dispatch"];
    expect(handler).not.toBeNull();
    return handler!(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({
          id: threadId,
          createdAt: Date.now(),
          ...threadOverrides,
        }),
        ...contextOverrides,
      }),
    );
  }

  it("always proceeds", async () => {
    const { harness } = await load();
    await expect(dispatch(harness, THREAD)).resolves.toEqual({ action: "proceed" });
  });

  it("queues child messages instead of interrupting the active orchestrator", async () => {
    const { harness } = await load();
    await enable(harness);
    const decision = await dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent",
      senderThreadId: WORKER,
      attempt: "join-turn",
    });
    expect(decision).toMatchObject({ action: "wait" });
  });

  it("delivers all queued messages from one child as a single native group", async () => {
    const { harness } = await load();
    await enable(harness);
    const entries = ["First update", "Second update", "Final report"].map((text, index) =>
      makeQueueEntry({
        id: `queued_${index}`, threadId: THREAD, initiator: "agent", senderThreadId: WORKER,
        content: [{ type: "text", text, mentions: [] }],
        waitingOn: { kind: "plugin", pluginId: "orchestrator-mode", reason: "Waiting for the turn to finish" },
      }),
    );
    harness.inspection.sdk.stub("threads.queuedMessages.list", async () => entries);
    const group = vi.fn(async () => entries);
    harness.inspection.sdk.stub("threads.queuedMessages.setGroupBoundary", group);

    await harness.behavior.emitThreadEvent("message.queued", { entry: entries[2]! });
    await vi.waitFor(() => expect(group).toHaveBeenCalledWith({
      threadId: THREAD,
      expectedGroupedPrefixQueuedMessageIds: entries.map((entry) => entry.id),
      groupBoundaryQueuedMessageId: entries[2]!.id,
    }));
    expect(entries.map((entry) => textOf(entry.content)))
      .toEqual(["First update", "Second update", "Final report"]);
    expect(sentTexts).toEqual([]);
  });

  it("batches interleaved children in first-child order and preserves every update", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, parentThreadId: threadId === THREAD ? null : THREAD }),
    );
    const original = [childEntry("a1"), childEntry("b1", "th_b"), childEntry("a2", WORKER, {
      content: [
        { type: "text", text: "See worker", mentions: [{ start: 4, end: 10,
          resource: { kind: "thread", label: "worker", threadId: WORKER } }] },
        { type: "localFile", path: "/tmp/report.txt", name: "report.txt", mimeType: "text/plain", sizeBytes: 42 },
        { type: "image", url: "https://example.test/report.png" },
      ],
    }),
      childEntry("b2", "th_b"), childEntry("a3")];
    const { queue, claim, group, reorder } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[4]! });
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    expect(reorder).toHaveBeenCalledTimes(2);
    const first = claim();
    expect(first.map((entry) => entry.content)).toEqual([original[0]!.content, original[2]!.content, original[4]!.content]);
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: first,
    })).resolves.toEqual({ action: "proceed" });
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: first[0]! });
    const second = claim();
    expect(second.map((entry) => entry.content)).toEqual([original[1]!.content, original[3]!.content]);
    expect(group).toHaveBeenCalledTimes(2);
    expect(queue.entries).toEqual([]);
    expect(harness.inspection.sdk.calls.some((call) =>
      ["threads.send", "threads.queuedMessages.send", "threads.queuedMessages.delete", "threads.queuedMessages.create"]
        .includes(call.path),
    )).toBe(false);
  });

  it("coalesces concurrent queue events without regrouping the same rows", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2"), childEntry("a3")];
    const { queue, group } = queueFixture(harness, original);
    await Promise.all(original.map((entry) => harness.behavior.emitThreadEvent("message.queued", { entry })));
    expect(group).toHaveBeenCalledTimes(1);
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, true, false]);
  });

  it("includes a new update arriving while a group boundary is being committed", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { queue, group } = queueFixture(harness, original);
    const commit = group.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    group.mockImplementationOnce(async (args) => { await gate; return commit(args); });
    const first = harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    await vi.waitFor(() => expect(group).toHaveBeenCalledTimes(1));
    const late = childEntry("a3");
    queue.entries.push(late);
    const second = harness.behavior.emitThreadEvent("message.queued", { entry: late });
    release();
    await Promise.all([first, second]);
    expect(queue.entries.map((entry) => entry.content)).toEqual([...original, late].map((entry) => entry.content));
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, true, false]);
    expect(group).toHaveBeenCalledTimes(2);
    expect(harness.inspection.recheckCount).toBeGreaterThan(0);
  });

  it.each([
    ["user message", makeQueueEntry({ id: "barrier", threadId: THREAD })],
    ["unrelated agent", childEntry("barrier", "th_unrelated")],
    ["another plugin's hold", childEntry("barrier", WORKER, {
      waitingOn: { kind: "plugin", pluginId: "another-plugin", reason: "Waiting" },
    })],
    ["scheduled message", childEntry("barrier", WORKER, { sendAt: Date.now() + 60_000 })],
  ])("does not group across a %s", async (_label, barrier) => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), barrier, childEntry("a2")];
    const { queue, group, reorder } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[2]! });
    expect(group).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it.each([
    { model: "different-model" }, { reasoningLevel: "high" as const },
    { permissionMode: "full" as const }, { serviceTier: "fast" as const },
  ])("preserves the child's order across incompatible execution options %j", async (override) => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2", WORKER, override), childEntry("a3")];
    const { queue, group, reorder } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[2]! });
    expect(group).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("preserves existing trailing user groups", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2"),
      makeQueueEntry({ id: "u1", threadId: THREAD, groupWithNext: true }),
      makeQueueEntry({ id: "u2", threadId: THREAD })];
    const { queue, group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    expect(group).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("preserves an existing group that extends beyond eligible child messages", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1", WORKER, { groupWithNext: true }),
      childEntry("a2", WORKER, { groupWithNext: true }),
      childEntry("a3", WORKER, { sendAt: Date.now() + 60_000 })];
    const { queue, group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[0]! });
    expect(group).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("extends an existing leading child group with a later update", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1", WORKER, { groupWithNext: true }), childEntry("a2"), childEntry("a3")];
    const { queue } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[2]! });
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, true, false]);
  });

  it("defers a claimed row once so a queue-vs-dispatch race can form the full batch", async () => {
    const { harness } = await load();
    await enable(harness);
    const first = childEntry("a1");
    const { queue, claim } = queueFixture(harness, [childEntry("a2")]);
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: [first],
    })).resolves.toEqual({ action: "wait", reason: CHILD_BATCH_WAIT_REASON });
    first.waitingOn = { kind: "plugin", pluginId: "orchestrator-mode", reason: CHILD_BATCH_WAIT_REASON };
    queue.entries.unshift(first);
    await harness.behavior.emitThreadEvent("message.queued", { entry: first });
    const grouped = claim();
    expect(grouped.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: grouped,
    })).resolves.toEqual({ action: "proceed" });
  });

  it("retries stale boundaries without resurrecting a deleted queued update", async () => {
    const { harness } = await load();
    await enable(harness);
    const { queue, group } = queueFixture(harness, [childEntry("a1"), childEntry("a2"), childEntry("a3")]);
    group.mockImplementationOnce(async () => {
      queue.entries.splice(1, 1);
      throw new Error("stale prefix");
    });
    await harness.behavior.emitThreadEvent("message.queued", { entry: queue.entries[2]! });
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a1", "a3"]);
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, false]);
    expect(group).toHaveBeenCalledTimes(2);
  });

  it("keeps original rows deliverable if grouping fails persistently", async () => {
    const { harness } = await load();
    await enable(harness);
    const first = childEntry("a1");
    const original = [first, childEntry("a2")];
    const { queue, group } = queueFixture(harness, original);
    group.mockImplementation(async () => { throw new Error("queue unavailable"); });
    await harness.behavior.emitThreadEvent("message.queued", { entry: first });
    expect(group).toHaveBeenCalledTimes(3);
    expect(queue.entries).toEqual(original);
    first.waitingOn = { kind: "plugin", pluginId: "orchestrator-mode", reason: CHILD_BATCH_WAIT_REASON };
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: [first],
    })).resolves.toEqual({ action: "proceed" });
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: [first], attempt: "join-turn",
    })).resolves.toMatchObject({ action: "wait", reason: expect.stringContaining("current turn") });
  });

  it.each(["disabled", "immediate"])("does not group when delivery is %s", async (mode) => {
    const { harness } = await load({ childMessageDelivery: mode === "immediate" ? "immediate" : "queued" });
    if (mode !== "disabled") await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { queue, group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    expect(group).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("honours disabling orchestrator mode while a queue read is in flight", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { queue, group, reorder } = queueFixture(harness, original);
    let release!: (entries: QueueEntry[]) => void;
    const pending = new Promise<QueueEntry[]>((resolve) => { release = resolve; });
    harness.inspection.sdk.stub("threads.queuedMessages.list", () => pending);
    const event = harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    await vi.waitFor(() => expect(harness.inspection.sdk.calls.some((call) => call.path === "threads.queuedMessages.list")).toBe(true));
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    release(original);
    await event;
    expect(group).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("groups under a project override of immediate global delivery", async () => {
    const { harness } = await load({ childMessageDelivery: "immediate" });
    await enable(harness);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: makeMessageDispatchHookContext().project.id, key: "childMessageDelivery", value: "queued",
    });
    const original = [childEntry("a1"), childEntry("a2")];
    const { group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    expect(group).toHaveBeenCalledTimes(1);
  });

  it("recovers same-child batches already waiting when the plugin reloads", async () => {
    const { bb } = await load({}, { [THREAD]: { enabled: true } }, {}, undefined,
      [childEntry("a1"), childEntry("a2")]);
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId: THREAD });
    expect(queued.map((entry) => entry.groupWithNext)).toEqual([true, false]);
  });

  it("stops an in-flight grouping job on disposal", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { group } = queueFixture(harness, original);
    let release!: (entries: QueueEntry[]) => void;
    const pending = new Promise<QueueEntry[]>((resolve) => { release = resolve; });
    harness.inspection.sdk.stub("threads.queuedMessages.list", () => pending);
    const event = harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    await vi.waitFor(() => expect(harness.inspection.sdk.calls.some((call) => call.path === "threads.queuedMessages.list")).toBe(true));
    await harness.lifecycle.dispose();
    release(original);
    await event;
    expect(group).not.toHaveBeenCalled();
  });

  it("holds messages from multiple children and releases each retry when the orchestrator is idle", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, parentThreadId: THREAD }),
    );
    for (const senderThreadId of [WORKER, "th_worker_2"]) {
      const context = { initiator: "agent", senderThreadId };
      await expect(dispatch(harness, THREAD, { status: "active" }, {
        ...context, attempt: "join-turn",
      })).resolves.toMatchObject({ action: "wait" });
      await expect(dispatch(harness, THREAD, { status: "idle" }, {
        ...context, attempt: "start-turn",
        queuedMessages: [makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId })],
      })).resolves.toEqual({ action: "proceed" });
    }
    expect(sentTexts).toEqual([]);
  });

  it.each([
    { initiator: "user", senderThreadId: null },
    { initiator: "system", senderThreadId: null },
    { initiator: "agent", senderThreadId: null },
    { initiator: "agent", senderThreadId: "th_unrelated" },
  ])("lets $initiator messages from $senderThreadId reach the running turn", async (context) => {
    const { harness } = await load();
    await enable(harness);
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      ...context, attempt: "join-turn",
    })).resolves.toEqual({ action: "proceed" });
  });

  it("does not hold a queued group that includes a user message", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "mixed",
      senderThreadId: "mixed",
      attempt: "join-turn",
      queuedMessages: [
        makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId: WORKER }),
        makeQueueEntry({ threadId: THREAD, initiator: "user", senderThreadId: null }),
      ],
    })).resolves.toEqual({ action: "proceed" });
  });

  it("does not hold a group that includes an unrelated agent", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent",
      senderThreadId: "mixed",
      attempt: "join-turn",
      queuedMessages: [WORKER, "th_unrelated"].map((senderThreadId) =>
        makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId }),
      ),
    })).resolves.toEqual({ action: "proceed" });
  });

  it("proceeds if a child's relationship can no longer be read", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async () => { throw new Error("thread deleted"); });
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, attempt: "join-turn",
    })).resolves.toEqual({ action: "proceed" });
  });

  it("releases waiting child messages when orchestrator mode is turned off", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, attempt: "join-turn",
      queuedMessages: [makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId: WORKER })],
    })).resolves.toEqual({ action: "proceed" });
  });

  it("honours immediate delivery globally and a project's queued override", async () => {
    const { harness } = await load({ childMessageDelivery: "immediate" });
    await enable(harness);
    const context = { initiator: "agent", senderThreadId: WORKER, attempt: "join-turn" };
    await expect(dispatch(harness, THREAD, { status: "active" }, context))
      .resolves.toEqual({ action: "proceed" });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: makeMessageDispatchHookContext().project.id, key: "childMessageDelivery", value: "queued",
    });
    await expect(dispatch(harness, THREAD, { status: "active" }, context))
      .resolves.toMatchObject({ action: "wait" });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: makeMessageDispatchHookContext().project.id, key: "childMessageDelivery", value: null,
    });
    await expect(dispatch(harness, THREAD, { status: "active" }, context))
      .resolves.toEqual({ action: "proceed" });
  });

  it("keeps the per-turn delegation budget through waits and steering messages", async () => {
    const { bb, harness } = await load({}, {
      [THREAD]: { enabled: true, turnStartedAt: 777 },
    });
    await dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, attempt: "join-turn",
    });
    await dispatch(harness, THREAD, { status: "active" }, {
      initiator: "user", senderThreadId: null, attempt: "join-turn",
    });
    const state = persistedRows(bb) as Record<string, { turnStartedAt: number }>;
    expect(state[THREAD]?.turnStartedAt).toBe(777);
    await dispatch(harness, THREAD, { status: "idle" }, { attempt: "start-turn" });
    const updated = persistedRows(bb) as Record<string, { turnStartedAt: number }>;
    expect(updated[THREAD]?.turnStartedAt).toBeGreaterThan(777);
  });

  it("configures child message delivery through the scope CLI", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["scope", "--global", "--child-messages", "immediate", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).values.childMessageDelivery).toBe("immediate");
  });

  it("writes and inherits both subagent policies through the scope CLI", async () => {
    const { harness } = await load();
    const written = await harness.behavior.runCli([
      "scope", "--project", "proj_1", "--orchestrator-subagents", "none", "--worker-subagents", "allowed", "--json",
    ]);
    expect(written.exitCode).toBe(0);
    expect(JSON.parse(written.stdout).values).toMatchObject({ orchestratorSubagents: "none", workerSubagents: "allowed" });
    await harness.behavior.runCli(["scope", "--project", "proj_1", "--inherit", "orchestratorSubagents"]);
    const inherited = await harness.behavior.runCli(["scope", "--project", "proj_1", "--inherit", "workerSubagents", "--json"]);
    expect(JSON.parse(inherited.stdout).values).toMatchObject({ orchestratorSubagents: "none", workerSubagents: "blocked" });
  });

  it("mirrors authoritative state onto the thread before the turn", async () => {
    const { harness } = await load();
    await enable(harness);
    metadata[THREAD] = {}; // as if another writer cleared it
    await dispatch(harness, THREAD);
    expect(metadata[THREAD]).toEqual(
      writeMirror({ enabled: true, enforcement: null }),
    );
  });

  it("restores the mirror when the thread's own agent turns it off", async () => {
    const { harness } = await load();
    await enable(harness);
    metadata[THREAD] = writeMirror({ enabled: false, enforcement: null });
    await dispatch(harness, THREAD);
    expect((metadata[THREAD]!["orchestrator"] as { enabled: boolean }).enabled).toBe(true);
  });

  it("applies the new-thread default at first dispatch", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, "th_fresh");
    expect(metadata["th_fresh"]).toEqual(
      writeMirror({ enabled: true, enforcement: null }),
    );
  });

  it("does not apply the default to a worker thread", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, WORKER, { parentThreadId: THREAD });
    expect(metadata[WORKER]).toBeUndefined();
  });

  it("does not apply the default to a thread created long ago", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, "th_old", { createdAt: Date.now() - 60 * 60_000 });
    expect(metadata["th_old"]).toBeUndefined();
  });

  it("does not apply the default to a thread created before the switch", async () => {
    const { harness } = await load();
    const before = Date.now() - 5_000;
    await harness.behavior.callRpc("set_default", { enabled: true });
    await dispatch(harness, "th_just_before", { createdAt: before });
    expect(metadata["th_just_before"]).toBeUndefined();

    await dispatch(harness, "th_just_after", { createdAt: Date.now() });
    expect(metadata["th_just_after"]).toEqual(writeMirror({ enabled: true, enforcement: null }));
  });

  it("does not apply the default to a plugin-spawned background worker", async () => {
    const { harness } = await load();
    await harness.behavior.callRpc("set_default", { enabled: true });
    await dispatch(
      harness,
      "th_recap_worker",
      { createdAt: Date.now(), originPluginId: "bb-recap" },
      { initiator: "agent", originPluginId: "bb-recap" },
    );
    expect(metadata["th_recap_worker"]).toBeUndefined();
  });

  it("leaves a thread it has never enforced alone", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, "th_old", { createdAt: Date.now() - 60 * 60_000 });
    // The dispatch path is app-wide, so an unenforced thread must cost no SDK
    // calls at all: no metadata read, no timeline read, no mirror write.
    expect(harness.inspection.sdk.calls).toEqual([]);
  });
});

describe("the watchdog", () => {
  it("records and deduplicates work delivered in timeline delta patches", async () => {
    const { bb, harness } = await load({ enforcement: "guard" });
    await arm(harness);
    const edit = workRow({
      id: "row_delta", workKind: "file-change", turnId: "turn_2",
      sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "delta.ts" },
    });
    harness.inspection.sdk.stub("threads.timeline", async () => ({
      rows: [], maxSeq: 4, delta: { upsertRows: [edit] },
    }));
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("delta.ts");

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state).toMatchObject({ violations: [{ id: "row_delta" }], nudgeCount: 1 });
    expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 4 } });
    expect(sentTexts).toHaveLength(1);
  });

  it("inspects edits inside completed turn summaries", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    const edit = workRow({
      id: "row_nested", workKind: "file-change", turnId: "turn_2",
      sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "nested.ts" },
    });
    harness.inspection.sdk.stub("threads.timeline", async ({ includeNestedRows }: { includeNestedRows?: string }) => ({
      maxSeq: 5,
      rows: [{
        id: "summary_2", kind: "turn", turnId: "turn_2", status: "completed",
        startedAt: edit.startedAt, sourceSeqStart: 3, sourceSeqEnd: 5,
        children: includeNestedRows === "true" ? [edit] : null,
      }],
    }));
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("nested.ts");
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [{ id: "row_nested" }],
    });
  });

  it("advances past an empty timeline patch without recording work", async () => {
    const { bb, harness } = await load();
    await arm(harness);
    harness.inspection.sdk.stub("threads.timeline", async () => ({
      rows: [], maxSeq: 3, delta: { upsertRows: [] },
    }));
    await idle(harness);
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 3 } });
    });
    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ violations: [] });
  });

  it("records a violation and corrects the thread in guard mode", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_edit",
        workKind: "file-change",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        change: { path: "src/server.ts" },
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);

    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("src/server.ts");
    expect(sentTexts[0]).toContain(DELEGATE_TOOL);
    expect(stoppedThreads).toEqual([]);

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: { detail: string }[];
      nudgeCount: number;
    };
    expect(state.violations).toHaveLength(1);
    expect(state.nudgeCount).toBe(1);
  });

  it("treats a correction to a real child as coordination, not direct work", async () => {
    const { bb, harness } = await load({ enforcement: "guard" });
    await arm(harness);
    // No delegation row exists for this child: the exemption has to come from
    // the parent/child relationship, which is the only thing that says this
    // orchestrator owns the thread it is correcting.
    childThreads = [{ id: WORKER, parentThreadId: THREAD }];
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_child",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: `bb thread tell ${WORKER} 'HOLD: do not change the schema yet'`,
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    // Await the scan cursor rather than a guessed delay. There is no nudge to
    // wait for when the row is exempt, and the cursor is the real signal that
    // the scan finished.
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 4 } });
    });

    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ violations: [] });
    // Both ownership pages, including hidden threads. A scan that asks for only
    // the visible children misses a fork and a worker kept out of the sidebar.
    const lists = harness.inspection.sdk.callsTo("threads.list").map((call) => call[0]);
    expect(lists).toEqual(expect.arrayContaining([
      { parentThreadId: THREAD, includeHidden: true, limit: 200 },
      { sourceThreadId: THREAD, includeHidden: true, limit: 200 },
    ]));
  });

  it("treats a correction to a thread spawned in this project after it as coordination", async () => {
    const { bb, harness } = await load({ enforcement: "guard" });
    await arm(harness);
    // `bb thread spawn` records no parent, so the project and creation order are
    // the only ownership signal for a worker the orchestrator spawned itself.
    childThreads = [{ id: WORKER, projectId: PROJECT, createdAt: CREATED_AT + 60_000 }];
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_project_later",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: `bb thread tell ${WORKER} 'HOLD: do not change the schema yet'`,
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 4 } });
    });

    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ violations: [] });
    const lists = harness.inspection.sdk.callsTo("threads.list").map((call) => call[0]);
    expect(lists).toEqual(expect.arrayContaining([{ projectId: PROJECT, includeHidden: true, limit: 200 }]));
  });

  it("still records a correction to a thread in this project that predates the orchestrator", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    childThreads = [{ id: WORKER, projectId: PROJECT, createdAt: CREATED_AT - 60_000 }];
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_project_earlier",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: `bb thread tell ${WORKER} 'HOLD: do not change the schema yet'`,
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);

    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: unknown[];
    };
    expect(state.violations).toHaveLength(1);
  });

  it("still records a correction to a later thread in another project", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    childThreads = [{ id: WORKER, projectId: "proj_other", createdAt: CREATED_AT + 60_000 }];
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_other_project",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: `bb thread tell ${WORKER} 'HOLD: do not change the schema yet'`,
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);

    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: unknown[];
    };
    expect(state.violations).toHaveLength(1);
  });

  it("treats a correction to an unrecorded fork as coordination", async () => {
    const { bb, harness } = await load({ enforcement: "guard" });
    await arm(harness);
    // A fork stores the source on `sourceThreadId` and leaves `parentThreadId`
    // null, so the parent page cannot see it. No delegation row either.
    childThreads = [{ id: "th_fork", parentThreadId: null, sourceThreadId: THREAD }];
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_fork",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: "bb thread tell th_fork 'HOLD: do not change the schema yet'",
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 4 } });
    });

    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ violations: [] });
  });

  it("treats a correction to an unrecorded hidden child as coordination", async () => {
    const { bb, harness } = await load({ enforcement: "guard" });
    await arm(harness);
    // Hidden, and not in the delegation record. The parent page returns it only
    // when the scan asks for hidden threads.
    childThreads = [{ id: "th_hidden", parentThreadId: THREAD, hidden: true }];
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_hidden",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: "bb thread tell th_hidden 'HOLD: do not change the schema yet'",
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 4 } });
    });

    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ violations: [] });
  });

  it("keeps a recorded hidden delegation exempt when the child pages omit it", async () => {
    const { bb, harness } = await load({ enforcement: "guard" });
    await arm(harness);
    // The worker was spawned hidden and the list pages do not return it. The
    // delegation record is the remaining reason a correction is coordination.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Review the implementation", hidden: true, waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    childThreads = [];
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_recorded_hidden",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: `bb thread tell ${WORKER} 'HOLD: do not change the schema yet'`,
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 4 } });
    });

    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [],
      delegations: [{ threadId: WORKER }],
    });
  });

  it("still records a correction sent to a thread that is not its child", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_tell_stranger",
        workKind: "command",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        command: "bb thread tell thr_stranger 'HOLD: do not change the schema yet'",
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);

    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: unknown[];
    };
    expect(state.violations).toHaveLength(1);
  });

  it("stops the turn in block mode", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_cmd", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command: "npm run build" }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);

    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("npm run build");
  });

  it("records but never judges the turns a resumed session ran ungoverned", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    // turn_0 (in flight at enable) and turn_1 (first after it) are excused;
    // arm() already ran turn_1, so only its recording is asserted here.
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: unknown[];
    };
    expect(state.violations).toEqual([]);
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("does nothing in instruct mode", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_edit2", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toEqual([]);
    expect(stoppedThreads).toEqual([]);
  });

  it.each([
    "git status",
    "bb status --json; bb provider models codex --environment env_bucd4j3r9b --json",
    "find benchmarks -maxdepth 2 -type f 2>/dev/null; find research/sqlite -maxdepth 2 -type f 2>/dev/null",
  ])("lets read-only command `%s` through", async (command) => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: true });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_ls", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: unknown[];
    };
    expect(state.violations).toEqual([]);
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("allows stdin follow-ups to recorded workers with read-only exploration disabled", async () => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: false });
    await arm(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL, { task: "Review the implementation", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const command = `bb thread tell ${WORKER} --model grok-4.7 --mode steer --message-file - <<'FOLLOWUP'\nAdd tests and run them in the worker.\nFOLLOWUP`;
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_followup", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [], delegations: [{ threadId: WORKER }],
    });
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("recognises workers recorded while the timeline request is in flight", async () => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: false });
    await arm(harness);
    const command = `bb thread tell ${WORKER} 'Add tests'`;
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_concurrent_followup", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command }),
    ];
    timelineMaxSeq = 4;
    harness.inspection.sdk.stub("threads.timeline", async () => {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL, { task: "Review the implementation", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );
      return { rows: timelineRows, maxSeq: timelineMaxSeq };
    });
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [], delegations: [{ threadId: WORKER }],
    });
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("still flags follow-up commands to unrecorded threads", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_unrecorded", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command: "bb thread tell th_other 'Do work'" }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [{ id: "row_unrecorded" }],
    });
  });

  it("never classifies the same row twice", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    const row = workRow({ id: "row_once", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } });
    timelineRows = [...timelineRows, row];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    // A second scan over the same row must not nudge again for the same turn.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toHaveLength(1);
  });

  it("leaves a thread that is not orchestrating alone", async () => {
    const { harness } = await load({ enforcement: "block" });
    timelineRows = [workRow({ id: "row_x", workKind: "file-change", change: { path: "a.ts" } })];
    timelineMaxSeq = 2;
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_other" }),
      lastAssistantText: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toEqual([]);
  });

  it("keeps watching state written by an older build of the plugin", async () => {
    // A row written before the grace fields existed: no graceTurnIds,
    // no graceSlots. The scan must normalize it, not die on it.
    const { harness } = await load({ enforcement: "block" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date(Date.now() - 60_000).toISOString(),
        touchedAt: Date.now(),
        violations: [],
        seenRowIds: [],
        lastSeq: 0,
        nudgeCount: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        delegations: [],
      },
    });
    timelineRows = [
      workRow({ id: "row_old0", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
      workRow({ id: "row_old1", workKind: "file-change", turnId: "turn_1", sourceSeqStart: 2, sourceSeqEnd: 2, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 2;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
  });

  it("excuses the first post-enable turn when its rows carry no startedAt", async () => {
    const { harness } = await load({ enforcement: "block" });
    timelineRows = [
      workRow({ id: "row_prior", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
    ];
    timelineMaxSeq = 1;
    await enable(harness);
    // A partial row: the timeline puts startedAt on the completed summary, so a
    // delta patch of the live turn arrives without one. It is still the first
    // post-enable turn, so the grace slot must cover it.
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_first",
        workKind: "file-change",
        turnId: "turn_1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        change: { path: "a.ts" },
        startedAt: undefined,
      }),
    ];
    timelineMaxSeq = 2;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [],
      nudgeCount: 0,
    });
  });

  it("does not let a historical row spend the first post-enable turn's grace", async () => {
    const { harness } = await load({ enforcement: "block" });
    timelineRows = [
      workRow({ id: "row_prior", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
    ];
    timelineMaxSeq = 1;
    await enable(harness);
    timelineRows = [
      ...timelineRows,
      // History first: its timestamp predates the enable, so it must not
      // consume the grace slot the live turn needs.
      workRow({
        id: "row_hist",
        workKind: "file-read",
        turnId: "turn_hist",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        startedAt: Date.now() - 60_000,
      }),
      workRow({
        id: "row_first",
        workKind: "file-change",
        turnId: "turn_1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        change: { path: "a.ts" },
        startedAt: undefined,
      }),
    ];
    timelineMaxSeq = 3;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("stops each live turn that does direct work even when the rows carry no turnId", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_a", workKind: "file-change", turnId: undefined, sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toHaveLength(1));

    // A second turn, again with no turnId: it must be stopped too rather than
    // collapsing into the same sentinel as the first.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_b", workKind: "file-change", turnId: undefined, sourceSeqStart: 5, sourceSeqEnd: 6, change: { path: "b.ts" } }),
    ];
    timelineMaxSeq = 6;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toHaveLength(2);
  });

  it("attributes the stop to the newest turn in the batch", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_t2", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
      workRow({ id: "row_t3", workKind: "file-change", turnId: "turn_3", sourceSeqStart: 5, sourceSeqEnd: 6, change: { path: "b.ts" } }),
    ];
    timelineMaxSeq = 6;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toHaveLength(1));

    // turn_3 is the live turn, so further work in it must not stop it again.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_t3b", workKind: "file-change", turnId: "turn_3", sourceSeqStart: 7, sourceSeqEnd: 8, change: { path: "c.ts" } }),
    ];
    timelineMaxSeq = 8;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toHaveLength(1);
    expect(sentTexts).toHaveLength(1);
  });

  it("judges a work row that carries no id", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: undefined, workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: { detail: string }[];
    };
    expect(state.violations).toHaveLength(1);
    expect(state.violations[0]!.detail).toContain("a.ts");

    // The sequence is the key, so a later scan does not judge it again.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      nudgeCount: 1,
    });
  });
});

describe("the delegation tool", () => {
  it("retains every worker record when delegations start together", async () => {
    const { harness } = await load();
    await enable(harness);
    let workerNumber = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_worker_${++workerNumber}`, parentThreadId: THREAD }),
    );
    await Promise.all(["First task", "Second task"].map((task) =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL, { task, waitForResult: false }, { threadId: THREAD, projectId: "proj_1" },
      ),
    ));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [{ threadId: "th_worker_1" }, { threadId: "th_worker_2" }],
    });
  });

  it("spawns a worker under the orchestrator and returns its result", async () => {
    const { harness } = await load();
    await enable(harness);
    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Implement the retry policy in src/retry.ts" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1",
      parentThreadId: THREAD,
      prompt: "Implement the retry policy in src/retry.ts",
      environment: { type: "reuse", environmentId: "env_1" },
    });
    expect(spawned[0]).not.toHaveProperty("providerId");
    expect(spawned[0]).not.toHaveProperty("model");
    expect(String(result)).toContain("the worker finished the task");
    expect(String(result)).toContain(WORKER);

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      delegations: { threadId: string; status: string | null; execution?: unknown }[];
    };
    expect(state.delegations).toHaveLength(1);
    expect(state.delegations[0]!.threadId).toBe(WORKER);
    expect(state.delegations[0]!.execution).toEqual({
      providerId: expect.any(String),
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    });
  });

  it.each(["provider", "providerId"])("pins %s and the model before starting a worker", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      {
        task: "Probe the contract and scope without changing project files",
        [field]: "grok",
        model: "grok-test-model",
        waitForResult: false,
      },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "grok",
      model: "grok-test-model",
      parentThreadId: THREAD,
      executionInputSources: { providerId: "explicit", model: "explicit" },
    });
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      enabled: true,
      delegations: [{ threadId: WORKER }],
    });
  });

  it.each([
    { providerId: "grok" },
    { model: "grok-test-model" },
  ])("supports an individual worker pin: %j", async (pins) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", ...pins, waitForResult: false },
      { threadId: THREAD },
    );
    expect(spawned[0]).toMatchObject(pins);
    // Model-only calls infer its provider, as the execution-controls path does.
    expect(spawned[0]).toMatchObject({ providerId: "grok" });
    if (!("model" in pins)) expect(spawned[0]).not.toHaveProperty("model");
  });

  it.each(["provider", "providerId"])("normalises whitespace in %s and model pins", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", [field]: " grok ", model: " grok-test-model ", waitForResult: false },
      { threadId: THREAD },
    );
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it.each([
    { providerId: "" },
    { providerId: "   " },
    { providerId: "x".repeat(121) },
    { provider: "" },
    { provider: "   " },
    { provider: "x".repeat(121) },
    { model: "" },
    { model: "   " },
    { model: "x".repeat(201) },
  ])("rejects invalid worker pins before spawning: %j", async (pins) => {
    const { harness } = await load();
    await expect(harness.behavior.callAgentTool(
      DELEGATE_TOOL, { task: "Probe the scope", ...pins }, { threadId: THREAD },
    )).rejects.toThrow();
    expect(spawned).toEqual([]);
  });

  it("does not fall back to an unpinned worker when BB rejects the pins", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("requested provider/model unavailable");
    });
    await expect(harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", providerId: "grok", model: "grok-test-model" },
      { threadId: THREAD },
    )).rejects.toThrow("requested provider/model unavailable");
    const calls = harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [],
    });
  });

  it("refuses a raw model pin under the pinned default", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await enable(harness);
    // The default is pinned, so a delegation cannot move a worker off the scope's
    // execution — not even upward.
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "The hard unit", model: "claude-opus-5-5", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/worker model policy is `pinned`, so `model` cannot be set/);
    expect(spawned).toHaveLength(0);
  });

  it.each(["provider", "reasoning"])("refuses a raw %s pin under the pinned default", async (field) => {
    const { harness } = await load({}, undefined, PIN_CATALOG);
    await enable(harness);
    const args =
      field === "provider"
        ? { task: "The hard unit", provider: "grok", waitForResult: false }
        : { task: "The hard unit", reasoning: "max" as const, waitForResult: false };
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, args, { threadId: THREAD, projectId: "proj_1" }),
    ).rejects.toThrow(new RegExp(`worker model policy is \`pinned\`, so \`${field}\` cannot be set`));
    expect(spawned).toHaveLength(0);
  });

  it("names the provider alias the caller actually passed", async () => {
    const { harness } = await load({}, undefined, PIN_CATALOG);
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "The hard unit", providerId: "grok", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/`providerId` cannot be set/);
    expect(spawned).toHaveLength(0);
  });

  it("still runs a stored preset under the pinned default", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { research: { model: "claude-opus-5-5" } },
    });
    await enable(harness);
    // A kind the user saved is their own choice, so pinned leaves it reachable.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Research it", preset: "research", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("lets a scope opt into flexible, and then a delegation picks its own model", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await enable(harness);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: "proj_1",
      key: "workerModelPolicy",
      value: "flexible",
    });
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "The hard unit", model: "claude-opus-5-5", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("returns immediately when asked not to wait", async () => {
    const { harness } = await load();
    await enable(harness);
    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(result)).toContain("without waiting");
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual([]);
  });

  it("leaves the worker on the project default when no execution is configured", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).not.toHaveProperty("providerId");
    expect(spawned[0]).not.toHaveProperty("model");
    expect(spawned[0]).not.toHaveProperty("reasoningLevel");
    expect(spawned[0]).not.toHaveProperty("permissionMode");
    expect(spawned[0]).not.toHaveProperty("executionInputSources");
  });

  it("leaves workers inherited until an execution is stored", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({});
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).not.toHaveProperty("executionInputSources");
  });

  it("spawns workers on the stored execution, stamped as caller-chosen", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "full",
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      reasoningLevel: "high",
      permissionMode: "full",
      // Without these the server drops the request and re-derives the
      // project's remembered defaults.
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
      },
    });
  });

  it("refuses storing a provider the catalog does not offer", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", {
        providerId: "gone-provider",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      }),
    ).rejects.toThrow(/Unknown worker provider "gone-provider"/);
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({});
  });

  it("refuses a stored execution that names no model", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", { providerId: "acp-omp" }),
    ).rejects.toThrow(/needs both a provider and a model/);
  });

  it("drops a stored model the catalog no longer offers", async () => {
    // Seeded straight into the store, as an older build with a wider catalog
    // would have left it.
    const { harness } = await load({}, undefined, CATALOG, {
      worker: { providerId: "acp-omp", model: "command-code/retired/model" },
    });
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({
      providerId: "acp-omp",
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The model is gone, the provider that served it survives.
    expect(spawned[0]).toMatchObject({
      providerId: "acp-omp",
      executionInputSources: { providerId: "explicit" },
    });
    expect(spawned[0]).not.toHaveProperty("model");
  });

  it("lets one delegation override the stored worker execution", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      {
        task: "The hard unit",
        model: "claude-opus-5-5",
        permissionMode: "auto",
        waitForResult: false,
      },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({
      model: "claude-opus-5-5",
      permissionMode: "auto",
      // The model's own provider replaces the configured one, which does not
      // serve it.
      providerId: "claude-code",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        permissionMode: "explicit",
      },
    });
    expect(spawned[0]).not.toHaveProperty("reasoningLevel");
  });

  /** Enable a thread whose workers run on a stored execution and retry target.
   * Pass `null` for a thread with no retry target. */
  async function armFallback(
    fallback: OrchestratorStateDto["workerExecution"] | null = RETRY_TARGET,
  ): Promise<FakePluginHarness> {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      ...(fallback === null ? {} : { fallback }),
    });
    await enable(harness);
    return harness;
  }

  /** Spawn two workers in order, the first of which behaves differently. */
  function twoWorkers(harness: FakePluginHarness): void {
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_first" : "th_second",
        parentThreadId: THREAD,
      });
    });
  }

  it("retries a failed worker on the configured fallback", async () => {
    const harness = await armFallback({ ...RETRY_TARGET, permissionMode: "auto" });
    twoWorkers(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_first" ? "error" : "idle" }),
    );

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toMatchObject({
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      providerId: "acp-omp",
    });
    // The fallback replaces the model and its access, and keeps the rest of
    // the execution.
    expect(spawned[1]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      permissionMode: "auto",
      prompt: "Rebuild the index",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        permissionMode: "explicit",
      },
    });
    expect(String(result)).toContain("th_first failed");
    expect(String(result)).toContain("th_second");
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [{ threadId: "th_first" }, { threadId: "th_second" }],
    });
  });

  it("retries when the wait rejects for an errored worker", async () => {
    const harness = await armFallback();
    twoWorkers(harness);
    // What the server actually does: an errored thread never reaches `idle`, so
    // the wait rejects instead of holding until the timeout.
    harness.inspection.sdk.stub("threads.wait", async ({ threadId }) => {
      if (threadId === "th_first") throw new Error("Thread is in status error and will not reach idle by waiting alone.");
      return { matched: true, threadId };
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_first" ? "error" : "idle" }),
    );

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
    expect(String(result)).toContain("th_first failed");
  });

  it("resumes a failed worker once on its own execution when no fallback is set", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });
    await enable(harness);
    twoWorkers(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_first" ? "error" : "idle" }),
    );

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toMatchObject({
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });
    expect(String(result)).toContain("Re-delegated the same brief");
  });

  it("refuses a dependency that is not one of this orchestrator's workers", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Build the bundle", after: ["th_stranger"] },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/not this orchestrator's workers/);
    expect(spawned).toHaveLength(0);
  });

  it("waits for each own dependency to be idle before spawning the dependent unit", async () => {
    const { harness } = await load();
    await enable(harness);
    twoWorkers(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fetch the feed", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Index the feed", after: ["th_first"], waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual(
      expect.arrayContaining([[expect.objectContaining({ threadId: "th_first", status: "idle" })]]),
    );
    expect(spawned).toHaveLength(2);
  });

  it("checks a build unit by default and reports the check's verdict as advice", async () => {
    const { harness } = await load();
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { build: { model: "command-code/deepseek/deepseek-v4.1-flash-fast" } },
    });
    await enable(harness);
    let started = 0;
    // Unique ids, because the revision chain is keyed by the record it came
    // from: reusing one id would make the chain ambiguous.
    const ids = ["th_unit", "th_check", "th_rev1", "th_rev1_check", "th_rev2", "th_rev2_check"];
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: ids[started++] ?? `th_extra_${started}`, parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId.includes("check")
        ? "ran tests: 2 failed\nVERDICT: fail the tests fail"
        : "changed the file",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", preset: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // Unit, its check, the revision the failed check triggered, and the
    // revision's own check: the bounded revision loop is one extra attempt.
    expect(spawned).toHaveLength(4);
    expect(String(result)).toContain("The check's verdict is fail. You still judge this unit with orchestrator_review.");
    expect(String(result)).toContain("re-delegated on the same execution as revision 1");
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations[0]!.threadId).toBe("th_unit");
    expect(state.delegations[0]!.kind).toBe("build");
    expect(state.delegations[0]!.revisions).toBe(1);
    expect(state.delegations[0]!.verdict ?? null).toBeNull();
    // A failed check is evidence, and acceptance is refused on it.
    expect(state.delegations[0]!.check?.verdict).toBe("rejected");
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "accepted", notes: "looks fine" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/failed its independent check/);
  });

  it("does not check a build unit that the orchestrator opted out of", async () => {
    const { harness } = await load();
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { build: { model: "command-code/deepseek/deepseek-v4.1-flash-fast" } },
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", preset: "build", verify: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
  });

  it("lets a fallback without its own access inherit the worker's", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      permissionMode: "accept-edits",
      fallback: RETRY_TARGET,
    });
    await enable(harness);
    twoWorkers(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_first" ? "error" : "idle" }),
    );

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned[1]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      permissionMode: "accept-edits",
    });
  });

  it("retries on the fallback when the worker cannot start at all", async () => {
    const harness = await armFallback();
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      // The provider refuses the first execution outright, as a 503 does.
      if (started++ === 0) throw new Error("HTTP 503: provider unavailable");
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_retry", parentThreadId: THREAD });
    });

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
    expect(String(result)).toContain("could not start");
    expect(String(result)).toContain("th_retry");
  });

  it("resumes a failed worker once when no fallback is configured, then reports the second failure", async () => {
    const harness = await armFallback(null);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: "error" }),
    );

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    expect(String(result)).toContain("Re-delegated the same brief");
  });

  it("does not retry a worker that finished", async () => {
    const harness = await armFallback();

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(1);
    expect(String(result)).toContain('status "idle"');
  });

  it("keeps the execution when only the fallback is cleared", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      fallback: { providerId: "claude-code", model: "claude-opus-5-5" },
    });
    expect(
      await harness.behavior.callRpc("set_worker_execution", {
        providerId: "acp-omp",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      }),
    ).toEqual({ providerId: "acp-omp", model: "command-code/deepseek/deepseek-v4.1-flash-fast" });
  });

  it("refuses a fallback provider the catalog does not offer", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", {
        providerId: "acp-omp",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
        fallback: { providerId: "gone", model: "command-code/deepseek/deepseek-v4.1-flash-fast" },
      }),
    ).rejects.toThrow(/Unknown worker provider "gone"/);
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({});
  });

  it("drops a stored fallback the catalog no longer offers", async () => {
    const { harness } = await load({}, undefined, CATALOG, {
      worker: {
        providerId: "acp-omp",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
        fallback: { providerId: "acp-omp", model: "command-code/retired/model" },
      },
    });
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });
  });

  it("refuses a worker model the catalog does not offer", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, CATALOG);
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", model: "gpt-9-imaginary", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/Unknown worker model "gpt-9-imaginary"/);
    expect(spawned).toHaveLength(0);
  });

  it("records a verdict for a worker", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    const result = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: WORKER, verdict: "accepted", notes: "read the diff" },
      { threadId: THREAD },
    );

    expect(String(result)).toContain("Recorded accepted");
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state).toMatchObject({ reviewed: 1, unreviewed: 0 });
    expect(state.delegations[0]).toMatchObject({ verdict: "accepted", notes: "read the diff" });
  });

  it("refuses a verdict for a thread it never delegated", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_never", verdict: "accepted" },
        { threadId: THREAD },
      ),
    ).rejects.toThrow(/no worker th_never/);
  });

  it("reminds an idle orchestrator about an unjudged worker exactly once", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const reviews = () => sentTexts.filter((text) => /review is missing/i.test(text));

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reviews()).toHaveLength(1);

    // The same unjudged worker is not nagged about again.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reviews()).toHaveLength(1);
  });

  it("reminds again after the counters are cleared", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const reminders = () => sentTexts.filter((text) => /review is missing/i.test(text));

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reminders()).toHaveLength(1);

    await harness.behavior.callRpc("clear_violations", { threadId: THREAD });
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Clearing resets the counters, so the gate speaks again instead of staying
    // muted for the same unjudged worker.
    expect(reminders()).toHaveLength(2);
  });

  it("reminds again after the thread is turned off and on", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const reminders = () => sentTexts.filter((text) => /review is missing/i.test(text));

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reminders()).toHaveLength(1);

    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    await enable(harness);
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reminders()).toHaveLength(2);
  });

  it("leaves the review gate silent at the instruct level", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts.filter((text) => /review is missing/i.test(text))).toEqual([]);
  });

  it("spawns a check unit when a delegation asks to be verified", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_unit" : "th_check",
        parentThreadId: THREAD,
      });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }) => ({
      output: threadId === "th_check" ? "the file exists\nVERDICT: pass" : "did the thing",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    // The check unit carries the original brief and the worker's claim, and is
    // told to go after the work — not to reread it — without repairing anything.
    const brief = String(spawned[1]!.prompt);
    expect(brief).toContain("Add a retry to src/retry.ts");
    expect(brief).toContain("did the thing");
    expect(brief).toContain("Do not modify any file");
    expect(brief).toContain("run the tests, the command or the steps the brief names");
    expect(brief).toContain("paste it, do not summarise it");
    expect(String(result)).toContain("VERDICT: pass");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations).toHaveLength(2);
    expect(state.delegations[0]).toMatchObject({ verifiedBy: "th_check" });
    // A check unit is evidence, not a unit the orchestrator must judge.
    expect(state).toMatchObject({ unreviewed: 1 });
  });

  it("gives a worktree unit its own checkout, and keeps its check unit in it", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      const first = started++ === 0;
      return makeThreadResponse({
        id: first ? "th_unit" : "th_check",
        parentThreadId: THREAD,
        environmentId: first ? "env_worktree" : "env_parent",
      });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }) => ({
      output: threadId === "th_check" ? "VERDICT: pass" : "did the thing",
    }));
    harness.inspection.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
      environmentId,
      hostId: "host_1",
      branchName: "bb/work/th-unit",
      path: "/tmp/worktrees/th-unit",
      isWorktree: true,
      status: "ready",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts", workspace: "worktree", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // The unit is spawned in a managed worktree on the orchestrator's own machine.
    expect(spawned[0]!.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    // Its check unit reuses that worktree, so it inspects the same working tree.
    expect(spawned[1]!.environment).toEqual({ type: "reuse", environmentId: "env_worktree" });
    // The result names the branch, because nothing lands until it is merged, and
    // hands over the merge brief the orchestrator is allowed to run.
    expect(String(result)).toContain("bb/work/th-unit");
    expect(String(result)).toContain("bb environment diff env_worktree");
    expect(String(result)).toContain('delegate a merge unit with `workspace: "shared"`');
    expect(String(result)).toContain("report what conflicts instead of resolving them");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations[0]).toMatchObject({ environmentId: "env_worktree" });
  });

  it("keeps every worker in the orchestrator's checkout when the scope says shared", async () => {
    const { harness } = await load({ workerWorkspace: "shared" });
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_unit", parentThreadId: THREAD, environmentId: "env_parent" });
    });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned[0]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });
  });

  it("picks the checkout from the unit kind under a mixed scope", async () => {
    const { harness } = await load({ workerWorkspace: "mixed" });
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: {
        build: { model: "command-code/deepseek/deepseek-v4.1-flash-fast" },
        review: { model: "command-code/deepseek/deepseek-v4.1-flash-fast" },
      },
    });
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_unit", parentThreadId: THREAD, environmentId: "env_1" });
    });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Review the retry change", preset: "review" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Implement the retry change", preset: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[1]!.environment).toMatchObject({
      type: "host",
      workspace: { type: "managed-worktree" },
    });
  });
  it("makes every delegation name its checkout under a mixed scope", async () => {
    const { harness } = await load({ workerWorkspace: "mixed" });
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_unit", parentThreadId: THREAD, environmentId: "env_1" });
    });

    // No choice is refused, and the refusal names both options.
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Touch two files" }, { threadId: THREAD, projectId: "proj_1" }),
    ).rejects.toThrow(/names where it runs/);
    expect(spawned).toHaveLength(0);

    // An explicit choice is honoured both ways, whatever the call is.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "A unit that stays put", workspace: "shared" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "A unit that needs its own copy", workspace: "worktree" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[1]!.environment).toMatchObject({
      type: "host",
      workspace: { type: "managed-worktree" },
    });
  });

  it("teaches the merge path to a worktree scope", async () => {
    const { harness } = await load({ workerWorkspace: "worktree" });
    const contract = (await harness.behavior.callRpc("get_contract", { threadId: null })) as { text: string };
    expect(contract.text).toContain("Units run in their own worktrees");
    expect(contract.text).toContain('workspace: "shared"');
    expect(contract.text).toContain("delegating the merge as its own unit");

    const mixed = await load({ workerWorkspace: "mixed" });
    const mixedContract = (await mixed.harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
    };
    expect(mixedContract.text).toContain("A unit's kind picks its checkout");
    // A shared scope stays silent about checkouts it never creates.
    const shared = await load({ workerWorkspace: "shared" });
    const sharedContract = (await shared.harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
    };
    expect(sharedContract.text).not.toContain("worktree");
  });

  it("resumes a failed worker but does not check it", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: "error" }),
    );

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
  });

  it("hands the orchestrator a worker's failure reason", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );

    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: WORKER, status: "error" }),
      error: "Provider refused the model",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations[0]).toMatchObject({
      status: "error",
      failure: "Provider refused the model",
    });
  });

  it("refuses a delegation past the parallel cap, and says which cap", async () => {
    const { harness } = await load({ maxParallelWorkers: 2, maxDelegationsPerTurn: 0 });
    await enable(harness);
    const delegate = () =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );

    await delegate();
    await delegate();
    await expect(delegate()).rejects.toThrow(/caps parallel workers at 2/);
    expect(spawned).toHaveLength(2);
  });

  it("does not count a check unit against the per-turn cap", async () => {
    const { harness } = await load({ maxDelegationsPerTurn: 1, maxParallelWorkers: 0 });
    await enable(harness);
    const handler = harness.inspection.registrations.hooks["message.dispatch"];
    await handler!(
      makeMessageDispatchHookContext({ thread: makeThreadResponse({ id: THREAD }) }),
    );
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_unit" : "th_check",
        parentThreadId: THREAD,
      });
    });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // One delegation the orchestrator chose, plus the check unit it did not.
    expect(spawned).toHaveLength(2);
  });

  it("does not send a fan-out refusal to the fallback", async () => {
    const { harness } = await load({ maxParallelWorkers: 1, maxDelegationsPerTurn: 0 }, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      fallback: RETRY_TARGET,
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // A cap is the plugin's own refusal: retrying it on the fallback would fail
    // twice and hide the reason.
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/caps parallel workers at 1/);
    expect(spawned).toHaveLength(1);
  });

  it("caps how many workers one turn may delegate", async () => {
    const { harness } = await load({ maxDelegationsPerTurn: 2, maxParallelWorkers: 0 });
    await enable(harness);
    const handler = harness.inspection.registrations.hooks["message.dispatch"];
    await handler!(
      makeMessageDispatchHookContext({ thread: makeThreadResponse({ id: THREAD }) }),
    );

    const delegate = () =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );

    await delegate();
    await delegate();
    await expect(delegate()).rejects.toThrow(/caps a turn at 2/);
  });

  it("names the preset in every child's title", async () => {
    const model = "command-code/deepseek/deepseek-v4.1-flash-fast";
    const { harness } = await load({}, undefined, {}, {
      worker: { presets: { build: { model }, research: { model }, review: { model } } },
    });
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `th_${spawned.length}`, parentThreadId: THREAD, environmentId: "env_1" });
    });
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "done" }));

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts", preset: "build", verify: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]!.title).toBe("BUILD: Add a retry to src/retry.ts");

    // An explicit title is prefixed too, and the check unit keeps the prefix.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Check the docs", title: "Doc pass", preset: "review", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[1]!.title).toBe("REVIEW: Doc pass");
    expect(spawned[2]!.title).toBe("REVIEW: Doc pass (check)");

    // A title that already names the preset is left alone, and a delegation
    // without one is titled exactly as it was.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Find the call sites", title: "RESEARCH: call sites", preset: "research" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[3]!.title).toBe("RESEARCH: call sites");

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Just a plain unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[4]!.title).toBe("Just a plain unit");
  });

  it("offers no cap when a cap is set to zero", async () => {
    const { harness } = await load({ maxParallelWorkers: 0, maxDelegationsPerTurn: 0 });
    await enable(harness);
    for (let index = 0; index < 8; index += 1) {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: `Unit ${index}`, waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );
    }
    expect(spawned).toHaveLength(8);
  });

  it("exposes the exact contract and the appended rules", async () => {
    const { harness } = await load({ enforcement: "guard" });
    const before = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
      extra: string;
      limit: number;
    };
    expect(before).toMatchObject({ extra: "", limit: 370 });
    expect(String(before.text)).toContain("ORCHESTRATOR MODE IS ON");
    expect(String(before.text)).toContain("orchestrator_review");

    const after = (await harness.behavior.callRpc("set_contract", {
      extra: "Never edit src/legacy.",
    })) as { text: string; extra: string; limit: number };
    expect(after).toMatchObject({ extra: "Never edit src/legacy." });
    expect(String(after.text)).toContain("## Rules for this project");
    expect(String(after.text)).toContain("Never edit src/legacy.");
  });

  it("refuses appended rules past the cap", async () => {
    const { harness } = await load();
    await expect(
      harness.behavior.callRpc("set_contract", { extra: "x".repeat(371) }),
    ).rejects.toThrow();
  });

  it("sets and clears the project rules from the CLI", async () => {
    const { harness } = await load();

    await harness.behavior.runCli(["contract", "--rules", "Never edit generated/."]);
    const set = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      extra: string;
      text: string;
    };
    expect(set.extra).toBe("Never edit generated/.");
    expect(set.text).toContain("Never edit generated/.");

    await harness.behavior.runCli(["contract", "--clear-rules"]);
    const cleared = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      extra: string;
      text: string;
    };
    expect(cleared.extra).toBe("");
    expect(cleared.text).not.toContain("Never edit generated/.");
  });

  it("prints the contract from the CLI", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["contract"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ORCHESTRATOR MODE IS ON");
    expect(result.stdout).toContain("orchestrator_delegate");
  });

  it("spawns a preset's execution on top of the worker execution", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      reasoningLevel: "low",
      presets: { build: { model: "claude-opus-5-5", permissionMode: "full" } },
    });
    await enable(harness);

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Build it", preset: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // The preset named only a model and an access; the provider follows the
    // model and the reasoning level stays what the worker execution said.
    expect(spawned[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "low",
      permissionMode: "full",
    });
  });

  it("lets a call's own arguments beat the preset", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { build: { model: "claude-opus-5-5" } },
    });
    await enable(harness);

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Build it", preset: "build", model: "claude-haiku-4-5-20251001" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("refuses a preset that is not stored, naming the ones that are", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { research: { model: "claude-haiku-4-5-20251001" } },
    });
    await enable(harness);

    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Build it", preset: "build" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/No `build` worker preset is stored. Stored presets: research/);
    expect(spawned).toHaveLength(0);
  });

  it("writes and clears one preset from the CLI without touching the rest", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      fallback: RETRY_TARGET,
    });

    const written = await harness.behavior.runCli([
      "worker",
      "--preset",
      "build",
      "--model",
      "claude-opus-5-5",
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("preset build");
    expect(written.stdout).toContain("claude-opus-5-5");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      workerExecution: Record<string, unknown>;
    };
    expect(state.workerExecution).toMatchObject({
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });

    const cleared = await harness.behavior.runCli(["worker", "--clear-preset", "build"]);
    expect(cleared.exitCode).toBe(0);
    const config = (await harness.behavior.callRpc("get_worker_execution", null)) as Record<string, unknown>;
    expect(config.presets).toBeUndefined();
    // The retry target and the execution survived the preset edit.
    expect(config).toMatchObject({ fallback: RETRY_TARGET });
  });

  it("writes no preset when a preset is named with no execution flags", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    const result = await harness.behavior.runCli(["worker", "--preset", "build"]);
    expect(result.exitCode).toBe(0);
    // `--preset build` on its own names no value, so it reports rather than
    // storing an empty preset a delegation could then resolve.
    const config = (await harness.behavior.callRpc("get_worker_execution", null)) as Record<string, unknown>;
    expect(config.presets).toBeUndefined();
  });

  it("archives a settled worker when retention says so", async () => {
    const { harness } = await load({ workerRetention: "archive-all" });
    await enable(harness);

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(archivedThreads).toEqual([WORKER]);
  });

  it("archives a worker a verdict was recorded for, even without waiting", async () => {
    const { harness } = await load({ workerRetention: "archive-all" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // Nobody waited on it, so nothing has been read yet.
    expect(archivedThreads).toEqual([]);

    await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: WORKER, verdict: "accepted" },
      { threadId: THREAD },
    );
    expect(archivedThreads).toEqual([WORKER]);
  });

  it("refuses to verify a worker nobody waits for", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false, verify: true },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/verify: true needs waitForResult: true/);
    // Nothing was spawned, so no worker is left unchecked.
    expect(spawned).toHaveLength(0);
  });

  it("refuses a delegation that names a thread other than the caller", async () => {
    const { harness } = await load();
    await enable(harness);
    const result = await harness.behavior.runCli(
      ["delegate", "--thread", "th_other", "--task", "Do it", "--no-wait"],
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("calling thread");
    expect(spawned).toHaveLength(0);
  });

  it("checks every unit of a review-heavy scope without being asked", async () => {
    const { harness } = await load({ contractPreset: "review-heavy" });
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: started++ === 0 ? "th_unit" : "th_check", parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }) => ({
      output: threadId === "th_check" ? "the file exists\nVERDICT: pass" : "did the thing",
    }));
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(2);
    expect(String(spawned[1]!.prompt)).toContain("Do not modify any file");
  });

  it("refuses to skip or background the check in a review-heavy scope", async () => {
    const { harness } = await load({ contractPreset: "review-heavy" });
    await enable(harness);
    const context = { threadId: THREAD, projectId: "proj_1" };
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Do it", verify: false }, context),
    ).rejects.toThrow(/review-heavy/);
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Do it", waitForResult: false }, context),
    ).rejects.toThrow(/review-heavy/);
    expect(spawned).toHaveLength(0);
  });

  it("lets the orchestrator record a verdict from its own shell, and refuses a worker judging itself", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.runCli(
      ["delegate", "--task", "Write the parser", "--no-wait"],
      { threadId: THREAD, projectId: "proj_1" },
    );
    const accepted = await harness.behavior.runCli(
      ["review", "--worker", WORKER, "--verdict", "accepted", "--notes", "ran the tests"],
      { threadId: THREAD },
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain(`Recorded accepted for ${WORKER}`);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [{ threadId: WORKER, verdict: "accepted" }],
    });
    const self = await harness.behavior.runCli(
      ["review", "--worker", WORKER, "--verdict", "accepted"],
      { threadId: WORKER },
    );
    expect(self.exitCode).not.toBe(0);
    expect(self.stderr).toContain(`no worker ${WORKER}`);
  });

  it("names the provider, not the model, when the provider is the typo", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", {
        providerId: "nope",
        model: "claude-opus-5-5",
      }),
    ).rejects.toThrow(/Unknown worker provider "nope"/);
  });

  it("keeps every worker by default", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(archivedThreads).toEqual([]);
  });

  it("archives only check units under the checks policy", async () => {
    const { harness } = await load({ workerRetention: "archive-checks" });
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_unit" : "th_check",
        parentThreadId: THREAD,
      });
    });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(archivedThreads).toEqual(["th_check"]);
  });

  it("emits the contract the two settings name", async () => {
    const { harness } = await load({ contractPreset: "review-heavy" });
    const contract = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
    };
    expect(contract.text).toContain("Every unit gets checked before you trust it");
    expect(contract.text).toContain("runs what the unit claims");
    expect(contract.text).not.toContain("`verify: true` for a unit whose result you cannot judge");
  });

  it("rejects an empty brief", async () => {
    const { harness } = await load();
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "" }, { threadId: THREAD }),
    ).rejects.toThrow();
  });
});

describe("rpc", () => {
  it("preserves both thread choices when they are enabled together", async () => {
    const { bb, harness } = await load();
    await Promise.all([enable(harness, "th_first"), enable(harness, "th_second")]);
    for (const threadId of ["th_first", "th_second"]) {
      expect(await harness.behavior.callRpc("get_state", { threadId })).toMatchObject({ enabled: true });
      expect(metadata[threadId]).toEqual(writeMirror({ enabled: true, enforcement: null }));
    }
    expect(persistedRows(bb)).toMatchObject({
      th_first: { enabled: true }, th_second: { enabled: true },
    });
  });

  it("leaves failed writes uncommitted and accepts later mutations", async () => {
    const { bb, harness } = await load();
    const db = bb.storage.database();
    // The table is gone, so the row write fails the way a disk error would.
    db.exec("DROP TABLE thread_state");
    try {
      await expect(enable(harness, "th_failed")).rejects.toThrow();
      // Nothing reached the cache, so the thread still reads as off, and no
      // thread-metadata mirror was written for a change that never committed.
      expect(await harness.behavior.callRpc("get_state", { threadId: "th_failed" })).toMatchObject({ enabled: false });
      expect(metadata["th_failed"]).toBeUndefined();
    } finally {
      db.exec(`CREATE TABLE IF NOT EXISTS thread_state (
        thread_id TEXT PRIMARY KEY NOT NULL,
        touched_at INTEGER NOT NULL,
        state TEXT NOT NULL
      )`);
    }

    await enable(harness, "th_later");
    expect(persistedRows(bb)).toMatchObject({ th_later: { enabled: true } });
    expect(await harness.behavior.callRpc("get_state", { threadId: "th_later" })).toMatchObject({ enabled: true });
    expect(metadata["th_later"]).toEqual(writeMirror({ enabled: true, enforcement: null }));
  });

  it("reports the effective enforcement and the plugin defaults", async () => {
    const { harness } = await load({ enforcement: "block", maxNudges: 5 });
    const before = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      enabled: boolean;
      effectiveEnforcement: string;
    };
    expect(before.enabled).toBe(false);
    expect(before.effectiveEnforcement).toBe("block");

    await enable(harness);
    const after = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      enabled: boolean;
      effectiveEnforcement: string;
      maxNudges: number;
    };
    expect(after.enabled).toBe(true);
    expect(after.effectiveEnforcement).toBe("block");
    expect(after.maxNudges).toBe(5);
  });

  it("toggles the new-thread default", async () => {
    const { harness } = await load();
    expect(await harness.behavior.callRpc("get_default")).toEqual({ enabled: false });
    expect(await harness.behavior.callRpc("set_default", { enabled: true })).toEqual({
      enabled: true,
    });
    expect(await harness.behavior.callRpc("get_default")).toEqual({ enabled: true });
  });

  it("retains current or inherited policy fallbacks when stored values or writes are malformed", async () => {
    const { harness } = await load({ orchestratorSubagents: "none", workerSubagents: "allowed" }, undefined, {}, {
      project_settings: { proj_1: { orchestratorSubagents: "invalid", workerSubagents: false } },
    });
    for (const projectId of [null, "proj_1"]) {
      for (const [key, value] of [["orchestratorSubagents", "invalid"], ["workerSubagents", 42]] as const) {
        const result = await harness.behavior.callRpc("set_scope_setting", { projectId, key, value }) as { values: unknown };
        expect(result.values).toMatchObject({ orchestratorSubagents: "none", workerSubagents: "allowed" });
      }
    }
    const invalid = await load({ orchestratorSubagents: "invalid", workerSubagents: 42 });
    expect(await invalid.harness.behavior.callRpc("get_scope_settings", { projectId: null }))
      .toMatchObject({ values: { orchestratorSubagents: "none", workerSubagents: "blocked" } });
    const restarted = await harness.lifecycle.reload(plugin);
    hosts.push(restarted.harness);
    expect(await restarted.harness.behavior.callRpc("get_scope_settings", { projectId: "proj_1" }))
      .toMatchObject({ values: { orchestratorSubagents: "none", workerSubagents: "allowed" } });
  });

  it("reads and writes one scope's settings, and refuses to clear the global record", async () => {
    const { bb, harness } = await load({ enforcement: "instruct", maxNudges: 5 });
    const globals = {
      enforcement: "instruct",
      allowReadCommands: true,
      maxNudges: 5,
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
    expect(await harness.behavior.callRpc("get_scope_settings", { projectId: null })).toEqual({
      values: globals,
      global: globals,
      overridden: [],
    });

    const written = (await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxParallelWorkers",
      value: 2,
    })) as { values: { maxParallelWorkers: number }; overridden: string[] };
    expect(written.values.maxParallelWorkers).toBe(2);
    expect(written.overridden).toEqual([]);
    // Stored, not just mirrored: the next read and a thread's own view both see it.
    expect(await bb.storage.kv.get("settings")).toMatchObject({ maxParallelWorkers: 2 });
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      maxParallelWorkers: number;
    };
    expect(state.maxParallelWorkers).toBe(2);

    // The global record has nothing above it, so there is no inherit to fall back to.
    await expect(
      harness.behavior.callRpc("set_scope_setting", { projectId: null, key: "maxNudges", value: null }),
    ).rejects.toThrow(/no inherited value/);
  });

  it("clears the violation record", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_c", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));

    const cleared = (await harness.behavior.callRpc("clear_violations", {
      threadId: THREAD,
    })) as { violations: unknown[]; nudgeCount: number };
    expect(cleared.violations).toEqual([]);
    expect(cleared.nudgeCount).toBe(0);
  });

  it("records identified OMP subagents whose definitions cannot be verified", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    const subagent = (id: string, agent: string, seq: number) => workRow({
      id, workKind: "tool", toolName: "task", turnId: "turn_2", sourceSeqStart: seq, sourceSeqEnd: seq,
      toolArgs: { tasks: [{ agent, task: "Create the file" }] },
    });
    timelineRows = [...timelineRows, subagent("row_scout", "scout", 3), subagent("row_task", "task", 4)];
    // The original live OMP repro had no tool identity at all. Keep it
    // conservative without guessing a launch or trusting the agent's name.
    timelineRows.push(workRow({ id: "row_opaque", workKind: "tool", toolName: "other", turnId: "turn_2",
      sourceSeqStart: 5, sourceSeqEnd: 5, toolArgs: { tasks: [{ agent: "task", task: "Create the file" }] } }));
    timelineMaxSeq = 5;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    const listed = await harness.behavior.runCli(["violations", "--thread", THREAD]);
    expect(listed.stdout).toContain("started subagent `task` itself");
    expect(listed.stdout).toContain("`scout`");
    expect(listed.stdout).toContain("unidentified OMP tool");
  });

  it("nudges a worker that starts a subagent while its scope blocks them", async () => {
    const { harness } = await load({ enforcement: "guard", workerSubagents: "blocked" });
    await enable(harness);
    await harness.behavior.runCli(
      ["delegate", "--task", "Write the parser", "--no-wait"],
      { threadId: THREAD, projectId: "proj_1" },
    );
    workerRows = [workRow({
      id: "row_worker_task", workKind: "tool", toolName: "task", turnId: "turn_w1",
      sourceSeqStart: 1, sourceSeqEnd: 1, toolArgs: { tasks: [{ agent: "reviewer", task: "split it" }] },
    })];
    workerMaxSeq = 1;
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: WORKER }),
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(sentTexts.some((text) => text.includes("started subagent `reviewer`"))).toBe(true));
  });

  it("leaves a worker alone when its scope allows subagents", async () => {
    const { harness } = await load({ enforcement: "guard", workerSubagents: "allowed" });
    await enable(harness);
    await harness.behavior.runCli(
      ["delegate", "--task", "Write the parser", "--no-wait"],
      { threadId: THREAD, projectId: "proj_1" },
    );
    workerRows = [workRow({
      id: "row_worker_task", workKind: "tool", toolName: "task", turnId: "turn_w1",
      sourceSeqStart: 1, sourceSeqEnd: 1, toolArgs: { tasks: [{ agent: "reviewer", task: "split it" }] },
    })];
    workerMaxSeq = 1;
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: WORKER }),
      lastAssistantText: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts.filter((text) => text.includes("started subagent"))).toEqual([]);
  });

  it("holds a delegate-only orchestrator to its no-commands contract even when reads are allowed", async () => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: true, contractPreset: "delegate-only" });
    await arm(harness);
    timelineRows = [...timelineRows, workRow({
      id: "row_ls", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command: "ls",
    })];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: Array<{ detail: string }>;
    };
    expect(state.violations.map((violation) => violation.detail)).toEqual(["ran `ls`"]);
  });

  it.each(["Explore", "Plan"])("does not mistake cached built-in telemetry for launch-specific proof of native Claude %s", async (name) => {
    const { bb, harness } = await load({ enforcement: "block" });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, providerId: "claude-code" }));
    harness.inspection.sdk.stub("threads.context", async () => ({ usage: {
      estimated: true, usedTokens: 10, modelContextWindow: 1000,
      snapshot: {
        capturedAt: "2020-01-01T00:00:00.000Z", providerSessionId: "old_session", providerTurnId: null,
        model: "claude-test", usedTokens: 10, contextWindowTokens: 1000, autoCompactAtTokens: null,
        estimated: true,
        categories: [{ id: "agents", kind: "used", label: "Agents", tokens: 10,
          entries: [{ id: name, label: `${name} (built-in)`, tokens: 10 }] }],
      },
    } }));
    await arm(harness);
    timelineRows.push(workRow({
      id: "native_read", workKind: "delegation", toolName: "delegation", subagentType: null,
      turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 3,
      presentation: { label: { pending: "Running subagent", completed: "Subagent finished" },
        detail: `${name} agent · model haiku` },
    }));
    timelineMaxSeq = 3;
    await idle(harness);
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 3,
        violations: [expect.objectContaining({ detail: `started subagent \`${name}\` itself` })] } });
    });
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    expect(harness.inspection.sdk.callsTo("threads.context")).toEqual([]);
  });

  it.each(["custom", "unavailable"])("keeps a native Claude definition conservative when %s", async (source) => {
    const { harness } = await load({ enforcement: "block" });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, providerId: "claude-code" }));
    harness.inspection.sdk.stub("threads.context", async () => {
      if (source === "unavailable") throw new Error("offline");
      return { usage: {
        estimated: true, usedTokens: 10, modelContextWindow: 1000,
        snapshot: {
          capturedAt: new Date().toISOString(), providerSessionId: "session_1", providerTurnId: null,
          model: "claude-test", usedTokens: 10, contextWindowTokens: 1000, autoCompactAtTokens: null,
          estimated: true,
          categories: [{ id: "agents", kind: "used", label: "Custom agents", tokens: 10,
            entries: [{ id: "custom", label: "Explore (project)", tokens: 10 }] }],
        },
      } };
    });
    await arm(harness);
    timelineRows.push(workRow({ id: "custom_read", workKind: "delegation", toolName: "delegation",
      subagentType: null, turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 3,
      presentation: { detail: "Explore agent" } }));
    timelineMaxSeq = 3;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [expect.objectContaining({ detail: "started subagent `Explore` itself" })],
    });
  });

  it.each(["none", "all"])("allows normalised Codex result collection and cleanup under %s", async (subagents) => {
    const { bb, harness } = await load({ enforcement: "block", orchestratorSubagents: subagents });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, providerId: "codex" }));
    await arm(harness);
    for (const [index, [pending, completed]] of [
      ["Waiting for agents", "Waited for agents"], ["Messaging agent", "Messaged agent"],
      ["Closing agent", "Closed agent"],
    ].entries()) {
      timelineRows.push(workRow({ id: `coordination_${index}`, workKind: "delegation", toolName: "delegation",
        subagentType: null, turnId: "turn_2", sourceSeqStart: index + 3, sourceSeqEnd: index + 3,
        presentation: { label: { pending, completed } } }));
    }
    timelineMaxSeq = 5;
    await idle(harness);
    await vi.waitFor(async () => {
      expect(persistedRows(bb)).toMatchObject({ [THREAD]: { lastSeq: 5, violations: [] } });
    });
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("publishes a realtime signal the composer can refetch on", async () => {
    const { harness } = await load();
    await enable(harness);
    expect(
      harness.inspection.realtimeSignals.some((signal) => signal.channel === "orchestrator-state"),
    ).toBe(true);
  });

  it("drops malformed entries in a stored array instead of failing a read", async () => {
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date().toISOString(),
        touchedAt: Date.now(),
        violations: [
          { id: "v1", turnId: "t1", workKind: "command", detail: "ran `x`", detectedAt: 1 },
          null,
          {},
        ],
        seenRowIds: ["row_1", null, 7],
        delegations: [
          { threadId: WORKER, title: "w", task: "t", createdAt: 1, status: "idle" },
          null,
          {},
        ],
        lastSeq: 0,
        graceTurnIds: [null, "turn_1"],
        graceSlots: 1,
        nudgeCount: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        turnStartedAt: 0,
        lastReviewNudge: null,
      },
    });
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: { id: string }[];
      delegations: { threadId: string }[];
      unreviewed: number;
    };
    // The valid entries survive intact; the foreign ones are dropped.
    expect(state.violations.map((violation) => violation.id)).toEqual(["v1"]);
    expect(state.delegations.map((delegation) => delegation.threadId)).toEqual([WORKER]);
    expect(state.unreviewed).toBe(1);
    // A later scan over the repaired state keeps working.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [{ id: "v1" }],
    });
  });

  it("survives an idle event whose stored delegation is malformed", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const { harness } = await load({}, {
        [THREAD]: {
          enabled: true,
          enforcement: null,
          enabledAt: new Date().toISOString(),
          touchedAt: Date.now(),
          violations: [],
          seenRowIds: [],
          delegations: [null],
          lastSeq: 0,
          graceTurnIds: [],
          graceSlots: 1,
          nudgeCount: 0,
          lastNudgeTurnId: null,
          lastStopTurnId: null,
          turnStartedAt: 0,
          lastReviewNudge: null,
        },
      });
      await idle(harness);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("retains every thread's row, including one with an unreadable touchedAt", async () => {
    const seed: Record<string, unknown> = {};
    for (let index = 1; index <= 300; index += 1) {
      seed[`th_${index}`] = { enabled: false, touchedAt: index };
    }
    seed.th_bad = { enabled: false, touchedAt: "recently" };
    const { harness } = await load({}, seed);
    await enable(harness);
    // The unreadable timestamp still reads as the oldest row, but nothing is
    // evicted: a per-thread row has no shared byte budget to run out of.
    const row = (await harness.behavior.callRpc("get_state", {
      threadId: "th_bad",
    })) as OrchestratorStateDto;
    expect(row).toBeDefined();
    for (const threadId of ["th_1", "th_2", "th_150", "th_300"]) {
      const kept = (await harness.behavior.callRpc("get_state", { threadId })) as OrchestratorStateDto;
      expect(kept).toBeDefined();
    }
  });

  it("keeps a large row whole instead of evicting its neighbours", async () => {
    const detail = "x".repeat(100);
    const seed: Record<string, unknown> = {};
    for (let index = 1; index <= 20; index += 1) {
      seed[`th_${index}`] = {
        enabled: false,
        touchedAt: index,
        violations: Array.from({ length: 60 }, (_, at) => ({
          id: `v_${index}_${at}`,
          turnId: "turn_1",
          workKind: "command",
          detail,
          detectedAt: index,
        })),
      };
    }
    // ~220 KB of rows: more than the single 256 KB KV value the previous build
    // kept them in, which is why it had to evict. Rows live in the database now,
    // so every one survives with its violations intact.
    const { harness } = await load({}, seed);
    await enable(harness);

    for (const threadId of ["th_1", "th_2", "th_20", THREAD]) {
      const kept = (await harness.behavior.callRpc("get_state", {
        threadId,
      })) as OrchestratorStateDto;
      expect(kept, `${threadId} is retained`).toBeDefined();
    }
    const kept = (await harness.behavior.callRpc("get_state", {
      threadId: "th_20",
    })) as OrchestratorStateDto;
    expect(kept.violations).toHaveLength(60);
    // Nothing was dropped, so nothing claims to have been.
    expect(
      harness.inspection.logEntries.some(
        (entry) => entry.level === "warn" && entry.message.includes("dropped"),
      ),
    ).toBe(false);
  });
});

describe("state persistence", () => {
  it("imports the legacy KV state map once, keeping every row it held", async () => {
    // A map written by the previous build, over the 256 KB the old single value
    // could hold, is imported row by row rather than dropped or truncated.
    const seed: Record<string, unknown> = {
      th_old: { enabled: true, touchedAt: 1, lastReviewNudge: "😀".repeat(50_000) },
      th_new: { enabled: false, touchedAt: 2 },
    };
    expect(Buffer.byteLength(JSON.stringify(seed), "utf8")).toBeGreaterThan(196_608);

    const { harness } = await load({}, seed);
    const old = (await harness.behavior.callRpc("get_state", {
      threadId: "th_old",
    })) as OrchestratorStateDto;
    expect(old.enabled).toBe(true);
    const kept = (await harness.behavior.callRpc("get_state", {
      threadId: "th_new",
    })) as OrchestratorStateDto;
    expect(kept).toBeDefined();
    // The import is announced, and it is not a repair: no row was discarded.
    expect(
      harness.inspection.logEntries.some((entry) => entry.message.includes("imported 2 thread(s)")),
    ).toBe(true);
  });

  it("starts empty when the stored state cannot be read, then recovers on the next write", async () => {
    const { bb, harness } = await load();
    const realGet = bb.storage.kv.get.bind(bb.storage.kv);
    const read = vi.spyOn(bb.storage.kv, "get").mockImplementation(async (key: string) => {
      if (key === "state") throw new Error("corrupt json");
      return realGet(key);
    });
    try {
      // A corrupt store must not throw out of a read: an unknown thread simply
      // has no state, which is what every caller already handles.
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
      expect(state.enabled).toBe(false);
      expect(
        harness.inspection.logEntries.some(
          (entry) => entry.level === "warn" && entry.message.includes("state read failed"),
        ),
      ).toBe(true);
    } finally {
      read.mockRestore();
    }
    await enable(harness);
    expect(persistedRows(bb)).toMatchObject({ [THREAD]: { enabled: true } });
  });

  it("treats an array-shaped stored state as empty instead of harvesting its indices", async () => {
    const { bb, harness } = await load(
      {},
      [{ enabled: true, touchedAt: 1 }] as unknown as Record<string, unknown>,
    );
    await enable(harness);
    const raw = (persistedRows(bb)) as Record<string, unknown>;
    // The array's element must not come back as a thread keyed "0".
    expect(Object.keys(raw)).toEqual([THREAD]);
    expect(
      harness.inspection.logEntries.some(
        (entry) => entry.level === "warn" && entry.message.includes("not an object"),
      ),
    ).toBe(true);
  });

  it("keeps a stored __proto__ thread id instead of letting it become the map's prototype", async () => {
    // A hostile or stale store can name a row "__proto__": a plain
    // `map[id] = row` would set the map's prototype and the row would vanish
    // from Object.keys and JSON.stringify.
    const seed: Record<string, unknown> = {};
    for (let index = 0; index < 300; index += 1) {
      seed[`th_${index}`] = { enabled: false, touchedAt: index };
    }
    Object.defineProperty(seed, "__proto__", {
      value: { enabled: true, touchedAt: 9_999 },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const { bb, harness } = await load({}, seed);
    await enable(harness);

    const raw = persistedRows(bb);
    expect(Object.prototype.hasOwnProperty.call(raw, "__proto__")).toBe(true);
    expect(raw.__proto__).toMatchObject({ enabled: true });
    // Rows hold no shared budget, so the hostile id neither evicts a neighbour
    // nor disappears.
    expect(raw.th_0).toBeDefined();
    expect(raw.th_299).toBeDefined();
    // Nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });

  it("does not let a read that was in flight when a write landed resurrect the pre-write map", async () => {
    const { bb, harness } = await load();
    const realGet = bb.storage.kv.get.bind(bb.storage.kv);
    let stateReads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(bb.storage.kv, "get").mockImplementation(async (key: string) => {
      const value = await realGet(key);
      // Hold the first state read open until a write has already committed, so
      // it resolves with a snapshot older than the cache.
      if (key === "state" && (stateReads += 1) === 1) await gate;
      return value;
    });
    try {
      const pending = harness.behavior.callRpc("get_state", { threadId: "th_read" });
      await vi.waitFor(() => expect(stateReads).toBe(1));
      await enable(harness, "th_a");
      release();
      await pending;
      await enable(harness, "th_b");

      const raw = (persistedRows(bb)) as Record<string, unknown>;
      expect(raw).toMatchObject({ th_a: { enabled: true }, th_b: { enabled: true } });
    } finally {
      read.mockRestore();
    }
  });
});

describe("cli", () => {
  it("reports the reminder budget split by the gate that spent it", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    harness.inspection.sdk.stub("threads.timeline", async () => ({
      rows: [],
      maxSeq: 4,
      delta: {
        upsertRows: [
          workRow({
            id: "row_split", workKind: "file-change", turnId: "turn_2",
            sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "split.ts" },
          }),
        ],
      },
    }));
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state).toMatchObject({ nudgeCount: 1, violationNudges: 1, reviewNudges: 0 });

    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("1 direct work, 0 unjudged workers");
  });

  it("bounds the verdict-owed records that outlive the newest window", async () => {
    const { harness } = await load({ enforcement: "instruct", maxParallelWorkers: 0, maxDelegationsPerTurn: 0 });
    await enable(harness, THREAD, "instruct");
    let workerNumber = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_w${++workerNumber}`, parentThreadId: THREAD }),
    );
    // Past both the record window (50) and the verdict-owed ceiling (200): the array is
    // re-serialized on every mutation, so "never drop an owed record" needs a bound of its
    // own. The newest owed records survive.
    for (let index = 0; index < 260; index += 1) {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: `Task ${index}` },
        { threadId: THREAD, projectId: "proj_1" },
      );
    }
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      delegations: { threadId: string }[];
      unreviewed: number;
    };
    expect(state.delegations.length).toBe(250);
    expect(state.unreviewed).toBe(250);
    expect(state.delegations.map((delegation) => delegation.threadId)).toContain("th_w260");
    expect(state.delegations.map((delegation) => delegation.threadId)).not.toContain("th_w1");
  });

  it("delegates after enabling a session that started without the native tool", async () => {
    const { harness } = await load();
    const originalSession = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: THREAD } }),
    );
    expect(originalSession.tools).toEqual([]);
    await enable(harness);
    const result = await harness.behavior.runCli([
      "delegate", "--task", "Implement the retry policy; add tests", "--title", "Retry policy",
    ], { threadId: THREAD, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(WORKER);
    expect(result.stdout).toContain("the worker finished the task");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1", parentThreadId: THREAD,
      prompt: "Implement the retry policy; add tests", title: "Retry policy",
      environment: { type: "reuse", environmentId: "env_1" },
    });
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [{ threadId: WORKER, status: "idle" }],
    });
  });

  it("supports CLI fan-out and derives an explicit parent's project", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: THREAD, projectId: "proj_parent", environmentId: "env_1" }),
    );
    const result = await harness.behavior.runCli([
      "delegate", "--thread", THREAD, "--task", "Implement retries", "--no-wait", "--hidden", "--json",
    ], { projectId: "proj_elsewhere" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!).output).toContain("without waiting");
    expect(spawned[0]).toMatchObject({
      projectId: "proj_parent", parentThreadId: THREAD, visibility: "hidden",
    });
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual([]);
  });
  it("runs an independent check for CLI delegation with --verify", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: started++ === 0 ? "th_unit" : "th_check", parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }) => ({
      output: threadId === "th_check" ? "VERDICT: pass" : "4",
    }));
    const result = await harness.behavior.runCli(
      ["delegate", "--task", "Run the synthetic command", "--kind", "research", "--verify"],
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VERDICT: pass");
    expect(spawned).toHaveLength(2);
    const state = await harness.behavior.callRpc("get_state", { threadId: THREAD }) as OrchestratorStateDto;
    expect(state.delegations[0]).toMatchObject({ verifiedBy: "th_check" });
  });

  it("refuses CLI --verify with --no-wait before spawning", async () => {
    const { harness } = await load();
    await enable(harness);
    const result = await harness.behavior.runCli(
      ["delegate", "--task", "Run the synthetic command", "--verify", "--no-wait"],
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(spawned).toHaveLength(0);
  });

  it("pins the requested provider and model through CLI delegation", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    const result = await harness.behavior.runCli([
      "delegate", "--task", "Probe the contract and scope",
      "--provider", "grok", "--model", "grok-test-model", "--no-wait",
    ], { threadId: THREAD, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "grok",
      model: "grok-test-model",
      parentThreadId: THREAD,
    });
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
  });

  it("lets CLI delegation name its workspace when the scope is mixed", async () => {
    const { harness } = await load({ workerWorkspace: "mixed" });
    await enable(harness);
    const context = { threadId: THREAD, projectId: "proj_1" };
    const unnamed = await harness.behavior.runCli(["delegate", "--task", "Unnamed unit", "--no-wait"], context);
    expect(unnamed.exitCode).not.toBe(0);
    expect(spawned).toHaveLength(0);
    const named = await harness.behavior.runCli(["delegate", "--task", "Named unit", "--workspace", "shared", "--no-wait"], context);
    expect(named.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it.each(["--provider-id", "--providerId"])("accepts the %s CLI alias", async (flag) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    const result = await harness.behavior.runCli([
      "delegate", "--task", "Probe the scope", flag, "grok",
      "--model", "grok-test-model", "--no-wait",
    ], { threadId: THREAD });
    expect(result.exitCode).toBe(0);
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it("accepts matching provider aliases after trimming", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe matching aliases", provider: " grok ", providerId: "grok",
      model: "grok-test-model", waitForResult: false,
    }, { threadId: THREAD });
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it("refuses conflicting provider aliases without spawning", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await expect(harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe conflicting aliases", provider: "grok", providerId: "other",
      model: "grok-test-model", waitForResult: false,
    }, { threadId: THREAD })).rejects.toThrow("must match");
    expect(spawned).toEqual([]);
  });

  it.each(["provider", "providerId"])("does not retarget an unknown %s to the model owner", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await expect(harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe unknown pins", [field]: "other", model: "grok-test-model",
      waitForResult: false,
    }, { threadId: THREAD })).rejects.toThrow("Unknown worker provider");
    expect(spawned).toEqual([]);
  });

  it.each(["provider", "providerId"])("refuses a model incompatible with the pinned %s", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, {
      providers: [...CATALOG.providers!, ...PIN_CATALOG.providers!],
      models: { ...CATALOG.models, ...PIN_CATALOG.models },
    });
    await enable(harness);
    await expect(harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe incompatible pins", [field]: "grok", model: "claude-opus-5-5",
      waitForResult: false,
    }, { threadId: THREAD })).rejects.toThrow("pinned provider");
    expect(spawned).toEqual([]);
  });

  it("advertises worker pins in CLI help", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["delegate", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--provider");
    expect(result.stdout).toContain("--model");
    expect(spawned).toEqual([]);
  });

  it.each(["tool", "cli"])("preserves project worker execution through %s delegation", async (route) => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_project_worker", {
      projectId: "proj_1",
      config: { providerId: "acp-omp", model: "command-code/deepseek/deepseek-v4.1-flash-fast", reasoningLevel: "high" },
    });
    const context = { threadId: THREAD, projectId: "proj_1" };
    if (route === "tool") {
      await harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Review scoped execution", waitForResult: false }, context);
    } else {
      const result = await harness.behavior.runCli(["delegate", "--task", "Review scoped execution", "--no-wait"], context);
      expect(result.exitCode).toBe(0);
    }
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1", providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast", reasoningLevel: "high",
    });
    expect(spawned[0]).not.toHaveProperty("fallback");
    expect(spawned[0]).not.toHaveProperty("presets");
  });

  it("keeps the worker cap on CLI delegation", async () => {
    const { harness } = await load({ maxParallelWorkers: 1 });
    await enable(harness);
    const context = { threadId: THREAD, projectId: "proj_1" };
    const first = await harness.behavior.runCli(["delegate", "--task", "First unit", "--no-wait"], context);
    expect(first.exitCode).toBe(0);
    const second = await harness.behavior.runCli(["delegate", "--task", "Second unit", "--no-wait", "--json"], context);
    expect(second.exitCode).toBe(1);
    expect(spawned).toHaveLength(1);
  });

  it("refuses CLI delegation after the mode is switched off", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    const result = await harness.behavior.runCli(["delegate", "--task", "Stale session unit", "--json"], {
      threadId: THREAD, projectId: "proj_1",
    });
    expect(result.exitCode).toBe(1);
    expect(spawned).toEqual([]);
  });

  it("rejects invalid CLI delegation arguments before spawning", async () => {
    const { harness } = await load();
    for (const args of [
      ["--task", ""],
      ["--task", "x".repeat(20_001)],
      ["--task", "x", "--timeout", "9"],
      ["--task", "x", "--provider", ""],
      ["--task", "x", "--provider", "   "],
      ["--task", "x", "--provider", "x".repeat(121)],
      ["--task", "x", "--model", ""],
      ["--task", "x", "--model", "   "],
      ["--task", "x", "--model", "x".repeat(201)],
    ]) {
      const result = await harness.behavior.runCli(["delegate", ...args, "--json"], { threadId: THREAD });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout!).ok).toBe(false);
    }
    expect(spawned).toEqual([]);
  });

  it("keeps the judge key out of plugin settings and state", async () => {
    const { bb, harness } = await load();
    expect(harness.registrations.settingsDescriptors.judgeKey).toBeUndefined();
    expect(await harness.behavior.callRpc("get_judge", null)).toEqual({ configured: false });
    const secret = "sk-or-test-0123456789";
    await judgeSecretStore(bb.server.experimental_dataDir).write(secret);
    expect(await harness.behavior.callRpc("get_judge", null)).toEqual({ configured: true });
    const state = await harness.behavior.callRpc("get_state", { threadId: THREAD });
    expect((state as { judge: { configured: boolean } }).judge.configured).toBe(true);
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it("stores the key a form submission returns and never prints it", async () => {
    const { harness } = await load();
    const secret = "sk-or-v1-synthetic-0123456789abcdef";
    const running = harness.behavior.runCli(["setup-jev", "--json"], { threadId: THREAD });
    const form = await pendingForm(harness);
    // The form is addressed to this thread, under the id the app registers, and
    // its payload carries the status only: no key, no length, no prefix.
    expect(form).toMatchObject({ threadId: THREAD, rendererId: "setup-jev" });
    expect(form.payload).toEqual({ configured: false });
    expect(JSON.stringify(form.payload)).not.toContain("sk-");

    // A stray newline and padding are trimmed; nothing else is second-guessed.
    harness.behavior.submitInteraction(form.id, { key: `  ${secret}\n` });
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stderr ?? "").toBe("");
    // Success reports the setting's presence, never the value.
    expect(JSON.parse(result.stdout!)).toEqual({ configured: true });
    expect(result.stdout).not.toContain(secret);

    // The write reached BB's secret setting, so the status surfaces see it and
    // the value appears in no state response.
    expect(await harness.behavior.callRpc("get_judge", null)).toEqual({ configured: true });
    expect(JSON.stringify(await harness.behavior.callRpc("get_state", { threadId: THREAD })))
      .not.toContain(secret);

    // A second run is told a key exists, which only a real settings write does.
    const again = harness.behavior.runCli(["setup-jev"], { threadId: THREAD });
    const second = await pendingForm(harness);
    expect(second.payload).toEqual({ configured: true });
    harness.behavior.cancelInteraction(second.id);
    expect((await again).exitCode).toBe(1);
  });

  it("leaves the stored key alone when the form is cancelled", async () => {
    const { bb, harness } = await load();
    const secret = "sk-or-v1-existing-9876543210";
    await judgeSecretStore(bb.server.experimental_dataDir).write(secret);

    const running = harness.behavior.runCli(["setup-jev"], { threadId: THREAD });
    const form = await pendingForm(harness);
    expect(form.payload).toEqual({ configured: true });
    harness.behavior.cancelInteraction(form.id);

    const result = await running;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("stored key is unchanged");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    // Cancelling is not a write: the key stored before the form still works.
    expect(await harness.behavior.callRpc("get_judge", null)).toEqual({ configured: true });
  });

  it("refuses to open the form without a thread", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["setup-jev", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout!).error).toMatchObject({ code: "thread_required" });
    expect(harness.inspection.pendingInteractions).toEqual([]);
    expect(await harness.behavior.callRpc("get_judge", null)).toEqual({ configured: false });
  });

  it("stores nothing when the form submits something that is not a key, without echoing it", async () => {
    const { harness } = await load();
    const echo = "has a space in it";
    const invalid: (Record<string, string> | string | null)[] = [{ key: "" }, { key: "short" }, { key: echo }, { other: "x" }, "not-an-object", null];
    for (const submitted of invalid) {
      const running = harness.behavior.runCli(["setup-jev", "--json"], { threadId: THREAD });
      const form = await pendingForm(harness);
      harness.behavior.submitInteraction(form.id, submitted);
      const result = await running;
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout!).error.code).toBe("invalid_key");
      // The refused value never reaches the output stream.
      expect(`${result.stdout}${result.stderr}`).not.toContain(echo);
      expect(await harness.behavior.callRpc("get_judge", null)).toEqual({ configured: false });
    }
  });

  it("describes the submitted row without what was submitted", async () => {
    const { harness } = await load();
    const secret = "sk-or-v1-described-0123456789";
    const running = harness.behavior.runCli(["setup-jev"], { threadId: THREAD });
    const form = await pendingForm(harness);

    const described = await form.describeSubmission?.({ key: secret });
    expect(described).toBeDefined();
    expect(JSON.stringify(described)).not.toContain(secret);
    expect(described).not.toHaveProperty("payload");
    // An unusable submission must not leave a row claiming a save.
    expect(() => form.describeSubmission?.({ key: "short" })).toThrow();

    harness.behavior.submitInteraction(form.id, { key: secret });
    expect((await running).exitCode).toBe(0);
  });

  it("turns the mode on and reports it", async () => {
    const { harness } = await load();
    const on = await harness.behavior.runCli(["on", "--thread", THREAD]);
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toContain("ON");

    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("orchestrator mode: ON");

    const off = await harness.behavior.runCli(["off", "--thread", THREAD]);
    expect(off.stdout).toContain("off");
    const after = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(after.stdout).toContain("orchestrator mode: off");
  });

  it("targets the invoking thread when no --thread is given", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["on"], { threadId: THREAD });
    expect(result.exitCode).toBe(0);
    expect(metadata[THREAD]).toEqual(writeMirror({ enabled: true, enforcement: null }));
  });

  it("explains itself when there is no thread to act on", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--thread");
  });

  it("emits JSON when asked", async () => {
    const { harness } = await load();
    await harness.behavior.runCli(["on", "--thread", THREAD]);
    const result = await harness.behavior.runCli(["status", "--thread", THREAD, "--json"]);
    const parsed = JSON.parse(result.stdout) as { enabled: boolean };
    expect(parsed.enabled).toBe(true);
  });

  it("sets and shows the new-thread default", async () => {
    const { harness } = await load();
    expect((await harness.behavior.runCli(["default"])).stdout).toContain("no");
    const set = await harness.behavior.runCli(["default", "on"]);
    expect(set.stdout).toContain("yes");
    const bad = await harness.behavior.runCli(["default", "maybe"]);
    expect(bad.exitCode).not.toBe(0);
  });

  it("accepts an enforcement override and rejects a made-up one", async () => {
    const { harness } = await load();
    const ok = await harness.behavior.runCli([
      "on",
      "--thread",
      THREAD,
      "--enforcement",
      "block",
    ]);
    expect(ok.exitCode).toBe(0);
    const bad = await harness.behavior.runCli([
      "on",
      "--thread",
      THREAD,
      "--enforcement",
      "aggressive",
    ]);
    expect(bad.exitCode).not.toBe(0);
  });

  it("lists and clears violations", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_cli", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "z.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));

    const list = await harness.behavior.runCli(["violations", "--thread", THREAD]);
    expect(list.stdout).toContain("z.ts");
    const cleared = await harness.behavior.runCli([
      "violations",
      "--thread",
      THREAD,
      "--clear",
    ]);
    expect(cleared.stdout).toContain("Cleared");
  });

  it("prints help", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("orchestrator-mode");
  });
});

describe("sweep regressions", () => {
  it("sends one reminder when two idle events race for the same unjudged worker", async () => {
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date(Date.now() - 60_000).toISOString(),
        delegations: [
          { threadId: WORKER, title: "Do it", task: "Do it", createdAt: Date.now() - 1_000, status: "idle", verdict: null },
        ],
      },
    });
    await Promise.all([idle(harness), idle(harness)]);
    await vi.waitFor(() => expect(sentTexts.length).toBeGreaterThan(0));
    // The scan runs on the plugin's own debounce timer, so this settle is real time by nature and fake timers cannot
    // drive it; a second reminder would have to arrive inside the same window. Promise.withResolvers is newer than
    // this project's lib, so the file's own idiom is used.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toHaveLength(1);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ nudgeCount: 1 });
  });

  it("counts delegations against the per-turn cap before the first dispatch", async () => {
    const { harness } = await load({ maxDelegationsPerTurn: 1, maxParallelWorkers: 0 });
    await enable(harness);
    const delegate = (task: string) =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task, waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );
    await delegate("First");
    await expect(delegate("Second")).rejects.toThrow(/caps a turn at 1/);
    expect(spawned).toHaveLength(1);
  });

  it("counts two simultaneous delegations against the parallel cap", async () => {
    const { harness } = await load({ maxParallelWorkers: 1, maxDelegationsPerTurn: 0 });
    await enable(harness);
    const settled = await Promise.allSettled(["First", "Second"].map((task) =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task, waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ));
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it("refuses a delegation once the thread is switched off", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false, enforcement: null });
    await expect(harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    )).rejects.toThrow(/not in orchestrator mode/);
    expect(spawned).toHaveLength(0);
  });

  it("reads a null or partial state row instead of failing", async () => {
    const partial = "th_partial";
    const { harness } = await load({}, { [THREAD]: null, [partial]: { enabled: true } });
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      enabled: false,
      enforcement: null,
      enabledAt: null,
    });
    expect(await harness.behavior.callRpc("get_state", { threadId: partial })).toMatchObject({
      enabled: true,
      enforcement: null,
      enabledAt: null,
    });
  });

  it("judges a later turn that reuses a seen row id", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_dup", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: unknown[] };
      expect(state.violations).toHaveLength(1);
    });
    // The same id in a later turn is a different act, not a redelivery of the first.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_dup", workKind: "file-change", turnId: "turn_3", sourceSeqStart: 5, sourceSeqEnd: 6, change: { path: "b.ts" } }),
    ];
    timelineMaxSeq = 6;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: { turnId: string | null }[] };
      expect(state.violations.map((violation) => violation.turnId)).toEqual(["turn_2", "turn_3"]);
    });
  });

  it("does not let a colon-bearing row id hide a later, different row", async () => {
    // lastSeq starts at 0 so both deliveries are above the cursor, and the rows
    // carry no turnId so neither spends a grace slot.
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: "guard",
        enabledAt: new Date(Date.now() - 60_000).toISOString(),
        touchedAt: Date.now(),
        violations: [],
        seenRowIds: [],
        lastSeq: 0,
        graceTurnIds: [],
        graceSlots: 1,
        nudgeCount: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        delegations: [],
        turnStartedAt: 0,
        lastReviewNudge: null,
      },
    });
    // A seq-0 delivery whose id already contains the old `id:seq` separator.
    timelineRows = [
      workRow({ id: "a:1", workKind: "file-change", turnId: undefined, sourceSeqStart: 0, sourceSeqEnd: 0, change: { path: "src/first.ts" } }),
    ];
    timelineMaxSeq = 0;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: { detail: string }[] };
      expect(state.violations.map((violation) => violation.detail)).toEqual(["changed src/first.ts itself"]);
    });
    // `{id:"a", sourceSeqEnd:1}` is a different row, not a redelivery of `a:1`.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "a", workKind: "file-change", turnId: undefined, sourceSeqStart: 1, sourceSeqEnd: 1, change: { path: "src/second.ts" } }),
    ];
    timelineMaxSeq = 1;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: { detail: string }[] };
      expect(state.violations.map((violation) => violation.detail)).toEqual([
        "changed src/first.ts itself",
        "changed src/second.ts itself",
      ]);
    });
  });

  it("keeps workers that are still owed a verdict when the record is trimmed", async () => {
    const { harness } = await load({ enforcement: "instruct", maxParallelWorkers: 0, maxDelegationsPerTurn: 0 });
    await enable(harness, THREAD, "instruct");
    let workerNumber = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_worker_${++workerNumber}`, parentThreadId: THREAD }),
    );
    // One past the record window: the oldest unjudged record must survive the trim, or its verdict becomes impossible.
    for (let index = 0; index < 51; index += 1) {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: `Task ${index}` },
        { threadId: THREAD, projectId: "proj_1" },
      );
    }
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      delegations: { threadId: string }[];
      unreviewed: number;
    };
    expect(state.unreviewed).toBe(51);
    expect(state.delegations.map((delegation) => delegation.threadId)).toContain("th_worker_1");
  });
});
describe("project scopes", () => {
  const PROJECT = "proj_scoped";
  const OTHER = "proj_other";
  const threadIn = (projectId: string) => makeThreadResponse({ id: THREAD, projectId, environmentId: "env_1" });

  it("resolves a project's settings over the globals, thread first, and reports the scope", async () => {
    const { harness } = await load();
    await enable(harness, THREAD);
    harness.inspection.sdk.stub("threads.get", async () => threadIn(PROJECT));

    const written = await harness.behavior.runCli([
      "scope", "--project", PROJECT, "--enforcement", "block", "--max-nudges", "7", "--max-parallel", "2",
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("project proj_scoped");
    expect(written.stdout).toContain("settings overridden: enforcement, maxNudges, maxParallelWorkers");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.effectiveEnforcement).toBe("block");
    expect(state.maxNudges).toBe(7);
    expect(state.maxParallelWorkers).toBe(2);

    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("scope:             project proj_scoped (overrides: enforcement, maxNudges, maxParallelWorkers)");

    // A thread override still wins over the project's.
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: true, enforcement: "instruct" });
    const overridden = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(overridden.effectiveEnforcement).toBe("instruct");
  });

  it("applies a project's fan-out cap to that project only", async () => {
    const { harness } = await load({ maxParallelWorkers: 0 });
    await enable(harness, THREAD);
    let spawned = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_cap${++spawned}`, parentThreadId: THREAD }),
    );
    // Not waiting keeps both workers in flight, which is what the cap counts.
    const delegate = (projectId: string, task: string) =>
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task, waitForResult: false }, { threadId: THREAD, projectId });
    await delegate(PROJECT, "first");
    await delegate(PROJECT, "second");
    expect(spawned).toBe(2);

    await harness.behavior.runCli(["scope", "--project", PROJECT, "--max-parallel", "1"]);
    await expect(delegate(PROJECT, "third")).rejects.toThrow(/caps parallel workers at 1/);
    // The neighbouring project still runs on the global cap.
    await delegate(OTHER, "fourth");
    expect(spawned).toBe(3);
  });

  it("hands a session the contract its project resolves, and the global one to another project", async () => {
    const { harness } = await load();
    await enable(harness, THREAD);
    await harness.behavior.runCli([
      "scope", "--project", PROJECT, "--contract-preset", "review-heavy",
      "--rules", "Never touch files under generated/.",
    ]);
    const scoped = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        project: { id: PROJECT },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(scoped.instructions).toContain("Every unit gets checked before you trust it");
    expect(scoped.instructions).toContain("Never touch files under generated/.");

    const other = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        project: { id: OTHER },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(other.instructions).not.toContain("Never touch files under generated/.");
    expect(other.instructions).not.toContain("Every unit gets checked before you trust it");
  });

  it("lists project overrides and clears them on request", async () => {
    const { harness } = await load();
    await harness.behavior.runCli(["scope", "--project", PROJECT, "--max-nudges", "9", "--rules", "Prefer the repo skill copies."]);
    const listed = await harness.behavior.runCli(["scope"]);
    expect(listed.stdout).toContain(PROJECT);
    expect(listed.stdout).toContain("settings: maxNudges");

    const cleared = await harness.behavior.runCli(["scope", "--project", PROJECT, "--inherit-all"]);
    expect(cleared.stdout).toContain("none (inherits the globals)");
    expect(cleared.stdout).toContain("inherits the global rules");
    const empty = await harness.behavior.runCli(["scope"]);
    expect(empty.stdout).toContain("no project overrides");
  });

  it("writes the global record from the scope command, and refuses project-only flags there", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    await enable(harness, THREAD);
    harness.inspection.sdk.stub("threads.get", async () => threadIn(PROJECT));

    const written = await harness.behavior.runCli([
      "scope", "--global", "--read-commands", "off", "--max-parallel", "3",
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("global: what every project inherits");
    expect(written.stdout).toContain("enforcement:          instruct");
    expect(written.stdout).toContain("read commands:        all commands are work");
    expect(written.stdout).toContain("fan-out cap:          3 in flight, 20 per turn");

    // A project that overrides nothing now reads what the record was set to.
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.allowReadCommands).toBe(false);
    expect(state.maxParallelWorkers).toBe(3);

    // The global worker execution and rules have their own commands; naming one
    // here would write a second copy of the same value.
    const refused = await harness.behavior.runCli(["scope", "--global", "--rules", "Prefer the repo skill copies."]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("orchestrator-mode contract");
    const both = await harness.behavior.runCli(["scope", "--global", "--project", PROJECT, "--max-parallel", "1"]);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("--global");
  });

});

describe("regressions found by the installed-build audit", () => {
  it("does not judge pre-enable history when the timeline head cannot be read", async () => {
    const { harness } = await load();
    let failHead = true;
    harness.inspection.sdk.stub("threads.timeline", async () => {
      if (failHead) throw new Error("timeline unavailable");
      return { rows: timelineRows, maxSeq: timelineMaxSeq };
    });
    await enable(harness);
    // Rows that existed before the mode was switched on.
    timelineRows = [
      workRow({
        id: "row_old_file",
        workKind: "file-change",
        turnId: "turn_old",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        change: { path: "src/old.ts" },
      }),
      workRow({
        id: "row_old_cmd",
        workKind: "command",
        turnId: "turn_old",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        command: "rm -rf build",
      }),
    ];
    timelineMaxSeq = 2;
    failHead = false;
    // The first readable scan seeds the cursor and judges nothing. Let the
    // scheduled scan (750 ms debounce) finish before new rows are delivered,
    // so the seeding cannot race the rows it is meant to exclude.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const seeded = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(seeded.violations).toEqual([]);
    // The next turns are judged normally: one grace turn, then the work row.
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_new_a",
        workKind: "file-read",
        turnId: "turn_new_a",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        startedAt: Date.now(),
      }),
      workRow({
        id: "row_new_b",
        workKind: "file-change",
        turnId: "turn_new_b",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        change: { path: "a.ts" },
        startedAt: Date.now(),
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
      expect(state.violations.map((violation) => violation.detail)).toEqual([
        "changed a.ts itself",
      ]);
    }, { timeout: 3_000 });
  });

  it("records what a worker resolved to, separately from what was requested", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_real", parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.context", async () => ({
      usage: { snapshot: { model: "actual/model-1" } },
    }));
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do the unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations[0]!.resolved).toMatchObject({
      providerId: "acp-omp",
      model: "actual/model-1",
      source: "session",
    });
    // BB reports neither, so they are named rather than echoed from the request.
    expect(state.delegations[0]!.resolved?.unreported).toEqual(["reasoningLevel", "serviceTier"]);
  });

  it("resumes a stalled worker on the same session and never spawns a duplicate", async () => {
    const { harness } = await load();
    await enable(harness);
    vi.useFakeTimers();
    try {
      let status: "active" | "idle" = "active";
      const updatedAt = 1_700_000_000_000;
      harness.inspection.sdk.stub("threads.spawn", async (args) => {
        spawned.push(args as unknown as Record<string, unknown>);
        return makeThreadResponse({ id: "th_slow", parentThreadId: THREAD, status: "active", updatedAt });
      });
      harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status, updatedAt }),
      );
      harness.inspection.sdk.stub("threads.wait", async ({ threadId }) => ({ matched: true, threadId }));
      const pending = harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Slow unit", timeoutSeconds: 3_600 },
        { threadId: THREAD, projectId: "proj_1" },
      );
      // Five minutes with no recorded progress is what a stall looks like.
      await vi.advanceTimersByTimeAsync(305_000);
      expect(sentTexts.some((text) => text.includes("appear to have stopped"))).toBe(true);
      status = "idle";
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(spawned).toHaveLength(1);
      expect(String(result)).toContain("th_slow");
    } finally {
      vi.useRealTimers();
    }
  });

  it("picks a mixed workspace from the unit kind with no stored preset", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "workerWorkspace",
      value: "mixed",
    });
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `th_kind_${started++}`, parentThreadId: THREAD });
    });
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Change the code", kind: "build", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Read the code", kind: "research", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const build = spawned[0] as { environment: { workspace?: { type?: string } } };
    const research = spawned[1] as { environment: { type?: string; environmentId?: string } };
    expect(build.environment.workspace?.type).toBe("managed-worktree");
    expect(research.environment).toEqual({ type: "reuse", environmentId: "env_1" });
  });

  it("checks a build kind without a stored execution preset", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `th_plain_${started++}`, parentThreadId: THREAD });
    });
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The unit and its check: the kind, not a stored preset, decides this.
    expect(spawned).toHaveLength(2);
    expect(String((spawned[1] as { title?: string }).title)).toContain("(check)");
  });

  it("refuses to start on a dependency whose review rejected it", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_first" : "th_second",
        parentThreadId: THREAD,
      });
    });
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Draft the change", kind: "research" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_first", verdict: "rejected", notes: "not what was asked" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Build on it", kind: "review", after: ["th_first"] },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/was rejected/);
    expect(spawned).toHaveLength(1);
  });

  it("refuses a dependency cycle instead of waiting forever", async () => {
    const { harness } = await load({}, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date().toISOString(),
        touchedAt: Date.now(),
        violations: [],
        seenRowIds: [],
        delegations: [
          { threadId: "th_a", title: "a", task: "t", createdAt: 1, status: "idle", after: ["th_b"] },
          { threadId: "th_b", title: "b", task: "t", createdAt: 2, status: "idle", after: ["th_a"] },
        ],
        lastSeq: 0,
        graceTurnIds: [],
        graceSlots: 1,
        nudgeCount: 0,
        violationNudges: 0,
        reviewNudges: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        turnStartedAt: 0,
        lastReviewNudge: null,
      },
    });
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "After both", after: ["th_a"] },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/cycle/);
    expect(spawned).toHaveLength(0);
  });

  it("surfaces the durable record caps and any recorded losses", async () => {
    const { harness } = await load({}, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date().toISOString(),
        touchedAt: Date.now(),
        violations: [],
        seenRowIds: [],
        delegations: [],
        lastSeq: 0,
        graceTurnIds: [],
        graceSlots: 1,
        nudgeCount: 0,
        violationNudges: 0,
        reviewNudges: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        turnStartedAt: 0,
        lastReviewNudge: null,
        lost: { delegations: 3, violations: 2, seenRows: 9 },
      },
    });
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.retention).toEqual({
      threads: 1,
      caps: { delegations: 50, violations: 100, seenRows: 500 },
      lost: { delegations: 3, violations: 2, seenRows: 9 },
    });
  });
});

describe("review findings: consent, revision chains, worker state and stalls", () => {
  function baseState(delegations: unknown[] = [], overrides: Record<string, unknown> = {}) {
    return {
      enabled: true,
      enforcement: null,
      enabledAt: new Date().toISOString(),
      touchedAt: Date.now(),
      violations: [],
      seenRowIds: [],
      delegations,
      lastSeq: 0,
      graceTurnIds: [],
      graceSlots: 1,
      nudgeCount: 0,
      violationNudges: 0,
      reviewNudges: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
      turnStartedAt: 0,
      lastReviewNudge: null,
      ...overrides,
    };
  }

  function buildDelegation(overrides: Record<string, unknown> = {}) {
    return {
      threadId: "th_unit",
      title: "Fix it",
      task: "Fix the parser",
      createdAt: 1,
      status: "idle",
      kind: "build",
      environmentId: "env_1",
      execution: {
        providerId: "acp-omp",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
        reasoningLevel: null,
        serviceTier: null,
        permissionMode: null,
      },
      ...overrides,
    };
  }

  async function stateOf(harness: FakePluginHarness): Promise<OrchestratorStateDto> {
    return (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
  }

  it("counts current children from BB while the ledger keeps its 21 records", async () => {
    // The shape from the report: a long ledger of finished delegations, and BB's
    // sidebar holding two children, one of them working.
    const ledger = Array.from({ length: 21 }, (_, index) =>
      buildDelegation({
        threadId: `th_old_${index}`,
        title: `Old unit ${index}`,
        status: index === 20 ? "active" : "idle",
        verdict: "accepted",
      }),
    );
    childThreads = [
      { id: "th_child_1", parentThreadId: THREAD, status: "active" },
      { id: "th_child_2", parentThreadId: THREAD, status: "idle" },
    ];
    const { harness } = await load({}, { [THREAD]: baseState(ledger) });
    const state = await stateOf(harness);
    expect(state.children).toEqual({ available: true, total: 2, running: 1, error: null });
    expect(state.workers.total).toBe(21);

    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("2 child threads, 1 running");
    expect(status.stdout).toContain("21 delegations recorded");
  });

  it("leaves archived, deleted and other parents' threads out of the child count", async () => {
    childThreads = [
      { id: "th_child_1", parentThreadId: THREAD, status: "idle" },
      // Hidden but real: it runs and holds a slot, so it counts.
      { id: "th_child_hidden", parentThreadId: THREAD, status: "starting", hidden: true },
      { id: "th_child_archived", parentThreadId: THREAD, status: "active", archivedAt: Date.now() },
      { id: "th_child_deleted", parentThreadId: THREAD, status: "active", deletedAt: Date.now() },
      { id: "th_elsewhere", parentThreadId: "th_other_orchestrator", status: "active" },
    ];
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    const state = await stateOf(harness);
    expect(state.children).toEqual({ available: true, total: 2, running: 1, error: null });
  });

  it("counts a hidden-only child and asks BB for hidden, unarchived children", async () => {
    // The count route takes no `includeHidden`, so a hidden-only parent used to
    // read as zero children. The list route is asked for them explicitly.
    childThreads = [{ id: "th_hidden", parentThreadId: THREAD, status: "active", hidden: true }];
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    const state = await stateOf(harness);
    expect(state.children).toEqual({ available: true, total: 1, running: 1, error: null });
  });

  it("counts a tree that fills every page exactly, using one probing row", async () => {
    // 600 children fill three pages of 200. The count is still exact, because
    // one more row proves the walk stopped at the end of the tree.
    childThreads = Array.from({ length: 600 }, (_, index) => ({
      id: `th_child_${index}`,
      parentThreadId: THREAD,
      status: "idle",
    }));
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    const state = await stateOf(harness);
    expect(state.children).toEqual({ available: true, total: 600, running: 0, error: null });
  });

  it("reports children as unknown when more of them exist than BB was paged for", async () => {
    // 601 current children exceed the read budget. Reporting 600 would be a
    // count that is wrong in the safe-looking direction, so it says unknown.
    childThreads = Array.from({ length: 601 }, (_, index) => ({
      id: `th_child_${index}`,
      parentThreadId: THREAD,
      status: "idle",
    }));
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    const state = await stateOf(harness);
    expect(state.children.available).toBe(false);
    expect(state.children.total).toBe(0);
    expect(state.children.running).toBe(0);
    expect(state.children.error).toMatch(/more than 600 current children/);
    // The ledger is still reported as what it is, never as the live count.
    expect(state.workers.total).toBe(1);
  });

  it("reports children as unknown rather than counting the ledger when BB cannot answer", async () => {
    childThreads = [{ id: "th_child_1", parentThreadId: THREAD, status: "active" }];
    const { harness } = await load({}, {
      [THREAD]: baseState([buildDelegation(), buildDelegation({ threadId: "th_b" })]),
    });
    harness.inspection.sdk.stub("threads.list", async () => {
      throw new Error("list route down");
    });
    const state = await stateOf(harness);
    expect(state.children).toEqual({
      available: false,
      total: 0,
      running: 0,
      error: "list route down",
    });
    // The ledger is still reported as what it is.
    expect(state.workers.total).toBe(2);
    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("unknown: BB could not give an exact count");
  });

  it("stores a settings select's string as the boolean it stands for", async () => {
    const { harness } = await load();
    const on = (await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "judgeAdvisory",
      value: "true",
    })) as { values: { judgeAdvisory: boolean } };
    expect(on.values.judgeAdvisory).toBe(true);
    const reread = (await harness.behavior.callRpc("get_scope_settings", { projectId: null })) as {
      values: { judgeAdvisory: boolean };
    };
    expect(reread.values.judgeAdvisory).toBe(true);

    const off = (await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "allowReadCommands",
      value: "false",
    })) as { values: { allowReadCommands: boolean } };
    expect(off.values.allowReadCommands).toBe(false);

    // A value that is neither spelling keeps the value in force instead of
    // silently writing false.
    const kept = (await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "judgeAdvisory",
      value: "maybe",
    })) as { values: { judgeAdvisory: boolean } };
    expect(kept.values.judgeAdvisory).toBe(true);
  });

  it("asks the advisory judge only when the scope opted in", async () => {
    const { bb, harness } = await load();
    await enable(harness);
    await judgeSecretStore(bb.server.experimental_dataDir).write("sk-test-only");
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "judgeAdvisory",
      value: false,
    });
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      const index = started++;
      return makeThreadResponse({
        id: `th_live_${index}_${index % 2 === 1 ? "check" : "unit"}`,
        parentThreadId: THREAD,
      });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId.endsWith("check")
        ? "npm test\nVERDICT: fail two tests fail"
        : "changed the file",
    }));
    let fetches = 0;
    vi.stubGlobal("fetch", (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ answers: { verified: { type: "noul", noul: 0.92 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch);
    try {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Fix the parser", kind: "build" },
        { threadId: THREAD, projectId: "proj_1" },
      );
      // The consent switch is off: no evidence may leave the machine.
      expect(fetches).toBe(0);

      await harness.behavior.callRpc("set_scope_setting", {
        projectId: null,
        key: "judgeAdvisory",
        value: true,
      });
      const again = await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Fix the parser again", kind: "build" },
        { threadId: THREAD, projectId: "proj_1" },
      );
      // Opting in is what the switch is for, and it now reaches the endpoint.
      expect(fetches).toBeGreaterThan(0);
      expect(String(again)).toContain("Advisory judge: agrees");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds the advisory judge to what is left of the call's deadline", async () => {
    const { bb, harness } = await load();
    await enable(harness);
    await judgeSecretStore(bb.server.experimental_dataDir).write("sk-test-only");
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "judgeAdvisory",
      value: true,
    });
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({
        id: started++ === 0 ? "th_judge_unit" : "th_judge_check",
        parentThreadId: THREAD,
      }),
    );
    let aborted = false;
    vi.stubGlobal("fetch", ((_url: string, init: RequestInit) => {
      // An endpoint that never answers: only the call's own deadline can end it.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch);
    vi.useFakeTimers();
    try {
      harness.inspection.sdk.stub("threads.wait", async ({ threadId }: { threadId: string }) => {
        // The unit burns six of the ten seconds the call was given.
        if (threadId === "th_judge_unit") vi.setSystemTime(Date.now() + 6_000);
        return { matched: true, threadId };
      });
      harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      );
      harness.inspection.sdk.stub("threads.output", async () => ({
        output: "npm test\nVERDICT: pass",
      }));
      const pending = harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", verify: true, timeoutSeconds: 10 },
        { threadId: THREAD, projectId: "proj_1" },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      // The call returned instead of waiting on OpenRouter forever.
      const text = String(await pending);
      expect(text).toMatch(/Advisory judge: failed — OpenRouter did not answer within \d+s/);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("re-delegates a rejected build once, then holds the chain budget", async () => {
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `th_rev_${started++}`, parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "revised the parser" }));

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "the parser still fails" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The revision and its own independent check: a revision carries the unit's
    // check rule, so it is checked like any other build.
    expect(spawned).toHaveLength(2);
    expect(String(text)).toContain("revision 1");
    const spawnArgs = spawned[0] as {
      environment?: { type?: string; environmentId?: string };
      providerId?: string;
      model?: string;
    };
    // The revision continues the unit's own checkout and execution.
    expect(spawnArgs.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(spawnArgs.providerId).toBe("acp-omp");
    expect(spawnArgs.model).toBe("command-code/deepseek/deepseek-v4.1-flash-fast");

    let state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    const revision = state.delegations.find((entry) => entry.threadId === "th_rev_0")!;
    expect(original.revisions).toBe(1);
    // The revision carries the spent count, so its own rejection cannot start a
    // fresh budget.
    expect(revision.revisions).toBe(1);
    expect(revision.revisionOf).toBe("th_unit");

    const chained = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_rev_0", verdict: "rejected", notes: "still wrong" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(2);
    expect(String(chained)).toContain("1-revision budget");
  });

  it("records the check rule on the unit so a rejection can revise it", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({
        id: started++ === 0 ? "th_verified" : "th_verified_check",
        parentThreadId: THREAD,
      }),
    );
    harness.inspection.sdk.stub("threads.wait", async ({ threadId }: { threadId: string }) => ({
      matched: true,
      threadId,
    }));
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({
      output: "looked at the diff\nVERDICT: pass",
    }));
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Review the parser", kind: "review", verify: true, timeoutSeconds: 10 },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const state = await stateOf(harness);
    const unit = state.delegations.find((entry) => entry.threadId === "th_verified")!;
    // The rule the check loop uses is on the record, so a later rejection
    // revises a checked unit of any kind.
    expect(unit.kind).toBe("review");
    expect(unit.verify).toBe(true);
    // The check unit is evidence, not a unit that earns its own revision.
    const check = state.delegations.find((entry) => entry.threadId === "th_verified_check")!;
    expect(check.verify).toBeUndefined();
  });

  it("revises a rejected non-build unit that asked for a check, keeping its kind", async () => {
    const { harness } = await load({}, {
      [THREAD]: baseState([buildDelegation({ threadId: "th_review", kind: "review", verify: true })]),
    });
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `th_rev_review_${started++}`, parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "reviewed it again" }));
    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_review", verdict: "rejected", notes: "the finding is wrong" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The revision and the independent check its `verify: true` still owes.
    expect(spawned).toHaveLength(2);
    expect(String(text)).toContain("revision 1");
    const state = await stateOf(harness);
    const revision = state.delegations.find((entry) => entry.threadId === "th_rev_review_0")!;
    // The revision keeps the unit's kind and its check rule, so it is still a
    // review unit and a second rejection is still revised within the budget.
    expect(revision.kind).toBe("review");
    expect(revision.verify).toBe(true);
  });

  it("says why a unit outside the revision rule was not revised", async () => {
    const { harness } = await load({}, {
      [THREAD]: baseState([buildDelegation({ threadId: "th_research", kind: "research", verify: false })]),
    });
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: "th_unwanted", parentThreadId: THREAD }),
    );
    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_research", verdict: "rejected", notes: "the answer is wrong" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // Silence read as "nothing to do"; the orchestrator is told to re-delegate.
    expect(spawned).toHaveLength(0);
    expect(String(text)).toContain("is not a build and has no independent check");
  });

  it("counts two concurrent rejections against one revision budget", async () => {
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `th_race_${started++}`, parentThreadId: THREAD });
    });

    const [a, b] = await Promise.all([
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "rejected", notes: "fix the parser" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "rejected", notes: "fix the parser" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ]);
    // One revision, and the check that revision owes.
    expect(spawned).toHaveLength(2);
    const texts = [String(a), String(b)];
    expect(texts.filter((text) => text.includes("revision 1"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("1-revision budget"))).toHaveLength(1);
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions).toBe(1);
  });

  it("refuses a revision past the parallel cap and keeps the rejection", async () => {
    const { harness } = await load({}, {
      [THREAD]: baseState([
        buildDelegation(),
        buildDelegation({ threadId: "th_busy", title: "Busy", createdAt: 2, status: "active" }),
      ]),
    });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxParallelWorkers",
      value: 1,
    });
    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "fix it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(0);
    expect(String(text)).toContain("caps parallel workers");
    const state = await stateOf(harness);
    // The refused revision spent nothing.
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions ?? 0).toBe(0);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.verdict).toBe("rejected");
  });

  it("reports a revision that could not start and hands its slot back", async () => {
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("provider unavailable");
    });
    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "fix it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("revision worker could not start (provider unavailable)");
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions ?? 0).toBe(0);
  });

  it("keeps a finished worker's result when the check-driven revision cannot start", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxRevisions",
      value: 0,
    });
    let index = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: `th_done_${index++}_${index === 2 ? "check" : "unit"}`,
        parentThreadId: THREAD,
      });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId.endsWith("check")
        ? "ran tests\nVERDICT: fail two tests fail"
        : "changed the parser",
    }));
    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The report the orchestrator asked for survives the refused revision.
    expect(String(result)).toContain("changed the parser");
    expect(String(result)).toContain("The revision budget (0) is spent");
    expect(spawned).toHaveLength(2);
  });

  it("starts no revision when the revision budget is zero", async () => {
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxRevisions",
      value: 0,
    });
    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "fix it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(0);
    expect(String(text)).toContain("0-revision budget");
  });

  it("starts no revision when the review call was cancelled", async () => {
    const { harness } = await load({}, { [THREAD]: baseState([buildDelegation()]) });
    const controller = new AbortController();
    controller.abort();
    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "fix it" },
      { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
    );
    expect(spawned).toHaveLength(0);
    expect(String(text)).toContain("review call was cancelled");
  });

  it("stops waiting on a worker when the tool call is cancelled", async () => {
    const { harness } = await load();
    await enable(harness);
    const controller = new AbortController();
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_bg", parentThreadId: THREAD, status: "active" });
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: "active", updatedAt: 1 }),
    );
    const pending = harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Slow unit", timeoutSeconds: 3_600 },
      { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
    );
    // Give the first poll a turn, then cancel: the call must not block for the
    // rest of the timeout.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(String(result)).toContain("th_bg is still running");
  });

  it("refreshes a no-wait worker's status and resolved execution", async () => {
    const { harness } = await load();
    await enable(harness);
    let workerStatus: "active" | "idle" = "active";
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: "th_bg",
        providerId: "acp-omp",
        parentThreadId: THREAD,
        status: "active",
      });
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        providerId: "acp-omp",
        status: threadId === "th_bg" ? workerStatus : "idle",
        updatedAt: 1,
      }),
    );
    harness.inspection.sdk.stub("threads.context", async () => ({
      usage: { snapshot: { model: "actual/model-1" } },
    }));

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Read the parser", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    let state = await stateOf(harness);
    let worker = state.delegations.find((entry) => entry.threadId === "th_bg")!;
    // BB reported the provider at spawn, so the unit is not "unconfirmed".
    expect(worker.resolved?.providerId).toBe("acp-omp");
    expect(state.workers.unconfirmed).toBe(0);
    expect(state.workers.running).toBe(1);

    workerStatus = "idle";
    state = await stateOf(harness);
    worker = state.delegations.find((entry) => entry.threadId === "th_bg")!;
    expect(worker.status).toBe("idle");
    expect(state.workers.running).toBe(0);
    expect(state.workers.settled).toBe(1);
    // The session snapshot now names the model the worker actually ran on.
    expect(worker.resolved?.model).toBe("actual/model-1");
  });

  it("counts re-delivered rows once, so the loss counter stays honest", async () => {
    const seeded = Array.from({ length: 499 }, (_, index) => `3:k${String(index).padStart(3, "0")}:0`);
    const { harness } = await load({}, {
      [THREAD]: baseState([], { seenRowIds: seeded, graceTurnIds: ["turn_g"] }),
    });
    timelineRows = [
      workRow({ id: "row_a", turnId: "turn_a", sourceSeqStart: 500, sourceSeqEnd: 500, workKind: "file-read" }),
      workRow({ id: "row_b", turnId: "turn_b", sourceSeqStart: 501, sourceSeqEnd: 501, workKind: "file-read" }),
      // The same row delivered again by a later page.
      workRow({ id: "row_a", turnId: "turn_a", sourceSeqStart: 500, sourceSeqEnd: 500, workKind: "file-read" }),
    ];
    timelineMaxSeq = 501;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = await stateOf(harness);
      expect(state.retention.lost.seenRows).toBe(1);
      expect(state.retention.caps.seenRows).toBe(500);
    }, { timeout: 3_000 });
  });

  it("reports the durable thread count in every JSON surface", async () => {
    const { harness } = await load({}, {
      [THREAD]: baseState(),
      th_other: baseState(),
    });
    const text = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("threads retained:  2 in durable state");
    for (const args of [
      ["status", "--thread", THREAD, "--json"],
      ["on", "--thread", THREAD, "--json"],
      ["off", "--thread", THREAD, "--json"],
      ["violations", "--thread", THREAD, "--clear", "--json"],
    ]) {
      const json = await harness.behavior.runCli(args);
      expect(JSON.parse(json.stdout).retention.threads, args.join(" ")).toBe(2);
    }
  });

  it("spends one deadline across a unit and its check", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async () => {
      const id = started++ === 0 ? "th_deadline_unit" : "th_deadline_check";
      return makeThreadResponse({ id, parentThreadId: THREAD });
    });
    const waits: { threadId: string; timeoutMs: number }[] = [];
    vi.useFakeTimers();
    try {
      harness.inspection.sdk.stub("threads.wait", async ({ threadId, timeoutMs }) => {
        waits.push({ threadId, timeoutMs });
        // The unit burns six of the ten seconds the call was given.
        if (threadId === "th_deadline_unit") vi.setSystemTime(Date.now() + 6_000);
        return { matched: true, threadId };
      });
      harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: threadId === "th_deadline_check" ? "active" : "idle" }),
      );
      harness.inspection.sdk.stub("threads.output", async () => ({ output: "npm test\nVERDICT: pass" }));
      const pending = harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", verify: true, timeoutSeconds: 10 },
        { threadId: THREAD, projectId: "proj_1" },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    const unit = waits.find((wait) => wait.threadId === "th_deadline_unit")!;
    const check = waits.find((wait) => wait.threadId === "th_deadline_check")!;
    expect(unit.timeoutMs).toBe(10_000);
    // The check gets what is left of the same deadline, not a fresh ten seconds.
    expect(check.timeoutMs).toBe(4_000);
  });

  it("holds a revision's fan-out reservation until its record lands", async () => {
    const { harness } = await load({ maxParallelWorkers: 1 }, { [THREAD]: baseState([buildDelegation()]) });
    let releaseRevision!: () => void;
    const revisionGate = new Promise<void>((resolve) => (releaseRevision = resolve));
    let revisionSpawned = false;
    let spawnCalls = 0;
    harness.inspection.sdk.stub("threads.spawn", async () => {
      spawnCalls += 1;
      if (revisionSpawned) return makeThreadResponse({ id: "th_second", parentThreadId: THREAD });
      revisionSpawned = true;
      await revisionGate;
      return makeThreadResponse({ id: "th_rev", parentThreadId: THREAD });
    });
    let gateDelegate = false;
    let releaseDelegate!: () => void;
    const delegateGate = new Promise<void>((resolve) => (releaseDelegate = resolve));
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (gateDelegate && threadId === THREAD) await delegateGate;
      return makeThreadResponse({ id: threadId, status: "idle" });
    });
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "done" }));

    const review = harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "fix it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    await vi.waitFor(() => expect(revisionSpawned).toBe(true));
    // The second delegation starts inside the window between the revision's
    // spawn and its record write.
    gateDelegate = true;
    const second = harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "A second unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseRevision();
    releaseDelegate();
    await expect(second).rejects.toThrow(/caps parallel workers at 1/);
    await review;
    // The second delegation was refused while the revision's slot was still
    // reserved for a record that had not landed. The two spawns are the
    // revision and its own check, which runs after the revision settles.
    expect(spawnCalls).toBe(2);
  });

  it("leaves a worker that keeps recording progress alone", async () => {
    const { harness } = await load();
    await enable(harness);
    vi.useFakeTimers();
    try {
      let status: "active" | "idle" = "active";
      let seq = 0;
      harness.inspection.sdk.stub("threads.spawn", async (args) => {
        spawned.push(args as unknown as Record<string, unknown>);
        return makeThreadResponse({ id: "th_slow", parentThreadId: THREAD, status: "active", updatedAt: 7 });
      });
      harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status, updatedAt: 7 }),
      );
      // `updatedAt` never moves, but the timeline does: the turn is alive.
      harness.inspection.sdk.stub("threads.timeline", async ({ threadId }) => ({
        rows: [],
        maxSeq: threadId === "th_slow" ? (seq += 1) : 0,
      }));
      harness.inspection.sdk.stub("threads.wait", async ({ threadId }) => ({ matched: true, threadId }));
      const pending = harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Slow unit", timeoutSeconds: 3_600 },
        { threadId: THREAD, projectId: "proj_1" },
      );
      await vi.advanceTimersByTimeAsync(320_000);
      expect(sentTexts.some((text) => text.includes("appear to have stopped"))).toBe(false);
      status = "idle";
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(String(result)).toContain("th_slow");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one resume budget between two waiters on the same worker", async () => {
    const { harness } = await load({}, {
      [THREAD]: baseState([buildDelegation({ threadId: "th_dep", status: "active" })]),
    });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxStallResumes",
      value: 1,
    });
    vi.useFakeTimers();
    try {
      let status: "active" | "idle" = "active";
      harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: threadId === "th_dep" ? status : "idle", updatedAt: 7 }),
      );
      harness.inspection.sdk.stub("threads.wait", async ({ threadId }) => ({ matched: true, threadId }));
      harness.inspection.sdk.stub("threads.timeline", async () => ({ rows: [], maxSeq: 0 }));
      const waiting = (
        task: string,
      ) =>
        harness.behavior
          .callAgentTool(
            DELEGATE_TOOL,
            { task, after: ["th_dep"], timeoutSeconds: 3_600 },
            { threadId: THREAD, projectId: "proj_1" },
          )
          .catch((cause: unknown) => cause);
      const first = waiting("First dependent");
      const second = waiting("Second dependent");
      await vi.advanceTimersByTimeAsync(320_000);
      // One worker, one budget: exactly one waiter may steer it.
      expect(sentTexts.filter((text) => text.includes("appear to have stopped"))).toHaveLength(1);
      status = "idle";
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all([first, second]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("review fixes: chain budget, verdict fail-closed, cancellation and resolution", () => {
  function chainState(delegations: unknown[]) {
    return {
      enabled: true,
      enforcement: null,
      enabledAt: new Date().toISOString(),
      touchedAt: Date.now(),
      violations: [],
      seenRowIds: [],
      delegations,
      lastSeq: 0,
      graceTurnIds: [],
      graceSlots: 1,
      nudgeCount: 0,
      violationNudges: 0,
      reviewNudges: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
      turnStartedAt: 0,
      lastReviewNudge: null,
    };
  }

  function unit(overrides: Record<string, unknown> = {}) {
    return {
      threadId: "th_unit",
      title: "Fix the parser",
      task: "Fix the parser",
      createdAt: 1,
      status: "idle",
      kind: "build",
      environmentId: "env_1",
      ...overrides,
    };
  }

  function queueSpawns(harness: FakePluginHarness, ids: string[]): void {
    let index = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      const id = ids[index] ?? `th_extra_${index}`;
      index += 1;
      return makeThreadResponse({ id, parentThreadId: THREAD });
    });
  }

  async function stateOf(harness: FakePluginHarness): Promise<OrchestratorStateDto> {
    return (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
  }

  it("spends one N-revision budget across an automatic and a manual chain", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxRevisions",
      value: 3,
    });
    // The order the loop spawns in: unit, its check, then each revision and its
    // own check, until the chain budget is spent.
    queueSpawns(harness, [
      "th_unit",
      "th_check_1",
      "th_rev_1",
      "th_check_2",
      "th_rev_2",
      "th_check_3",
      "th_rev_3",
      "th_check_4",
    ]);
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId.startsWith("th_check")
        ? "- **VERDICT: fail** the parser still fails"
        : "changed the parser",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(8);
    const titles = spawned.map((args) => String((args as { title?: string }).title ?? ""));
    const revisionTitles = titles
      .filter((title) => /\(revision \d+\)$/.test(title))
      .map((title) => title.slice(title.lastIndexOf("(revision")));
    // Each automatic revision is named once: no second chain restarts at 1.
    expect(revisionTitles).toEqual(["(revision 1)", "(revision 2)", "(revision 3)"]);
    expect(String(result)).toContain("The revision budget (3) is spent");

    // The orchestrator follows the instruction and records the original
    // rejected: that is the same chain, so it must not buy a fresh budget.
    const manual = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "a reviewer found it still wrong" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(manual)).toContain("3-revision budget");
    expect(spawned).toHaveLength(8);
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions).toBe(3);
    expect(state.delegations.find((entry) => entry.threadId === "th_rev_2")!.revisionRoot).toBe("th_unit");
  });

  it("counts concurrent rejections of two chain members against the same budget", async () => {
    const { harness } = await load(
      {},
      {
        [THREAD]: chainState([
          unit({ revisions: 1 }),
          unit({
            threadId: "th_rev_0",
            title: "Fix the parser (revision 1)",
            revisionOf: "th_unit",
            revisionRoot: "th_unit",
            revisions: 1,
            createdAt: 2,
          }),
        ]),
      },
    );
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxRevisions",
      value: 2,
    });
    queueSpawns(harness, ["th_rev_1"]);

    const [fromOriginal, fromRevision] = await Promise.all([
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "rejected", notes: "fix the parser" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_rev_0", verdict: "rejected", notes: "still wrong" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ]);

    const texts = [String(fromOriginal), String(fromRevision)];
    // One revision, plus the check that revision owes.
    expect(spawned).toHaveLength(2);
    expect(texts.filter((text) => text.includes("revision 2"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("2-revision budget"))).toHaveLength(1);
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions).toBe(2);
  });

  it("reads a Markdown-formatted pass and records it", async () => {
    const { harness } = await load();
    await enable(harness);
    queueSpawns(harness, ["th_unit", "th_check"]);
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output:
        threadId === "th_check" ? "## Check\n- **VERDICT: pass** — the suite is green" : "changed the parser",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(String(result)).toContain("The check's verdict is pass");
    // A pass buys no revision.
    expect(spawned).toHaveLength(2);
    const accepted = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "accepted", notes: "read the diff" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(accepted)).toContain("Recorded accepted for th_unit");
    expect((await stateOf(harness)).delegations.find((entry) => entry.threadId === "th_unit")!.check?.verdict).toBe(
      "accepted",
    );
  });

  it("fails closed when the check leaves no verdict any gate can trust", async () => {
    const { harness } = await load();
    await enable(harness);
    queueSpawns(harness, ["th_unit", "th_check"]);
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_check" ? "I looked at the diff and it seems fine." : "changed the parser",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // Silence is not a pass, and it is named rather than swallowed.
    expect(String(result)).toContain("no verdict this plugin can trust");
    expect(spawned).toHaveLength(2);
    const unitRow = (await stateOf(harness)).delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(unitRow.check?.verdict).toBe("rejected");
    expect(unitRow.check?.problem ?? "").toContain("no line that reads");

    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "accepted", notes: "looks fine" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/no verdict this plugin can trust/);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Publish the parser", after: ["th_unit"], waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/cannot be used because its independent check left no verdict/);
    expect(spawned).toHaveLength(2);
  });

  it("fails closed when a check report states both a pass and a fail", async () => {
    const { harness } = await load();
    await enable(harness);
    queueSpawns(harness, ["th_unit", "th_check"]);
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output:
        threadId === "th_check" ? "VERDICT: pass the parser tests\nVERDICT: fail the integration tests" : "changed the parser",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(String(result)).toContain("both a pass and a fail");
    expect(spawned).toHaveLength(2);
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "accepted", notes: "looks fine" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/ambiguous/);
  });

  it("spawns no revision when the call is cancelled after the check fails", async () => {
    const { harness } = await load();
    await enable(harness);
    const controller = new AbortController();
    queueSpawns(harness, ["th_unit", "th_check"]);
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => {
      if (threadId === "th_check") {
        // The user cancelled while the check's report was being read.
        controller.abort();
        return { output: "VERDICT: fail the suite fails" };
      }
      return { output: "changed the parser" };
    });

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
    );

    expect(String(result)).toContain("no further check or revision ran");
    expect(spawned).toHaveLength(2);
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions ?? 0).toBe(0);

    // A call that is already cancelled starts no worker at all.
    const entry = await harness.behavior
      .callAgentTool(
        DELEGATE_TOOL,
        { task: "Another unit", kind: "build" },
        { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
      )
      .catch((cause: unknown) => cause);
    expect(String(entry)).toContain("no worker was started");
    expect(spawned).toHaveLength(2);
  });
  it("reports cancellation rather than deadline expiry when a checker is still running", async () => {
    const { harness } = await load();
    await enable(harness);
    const controller = new AbortController();
    queueSpawns(harness, ["th_unit", "th_check"]);
    harness.inspection.sdk.stub("threads.wait", async ({ threadId }: { threadId: string }) => {
      if (threadId === "th_check") controller.abort();
      return { matched: true, threadId };
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_check" ? "active" : "idle", projectId: "proj_1", environmentId: "env_1" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "node -e 'console.log(4)'\n4" }));
    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Run a synthetic command", verify: true },
      { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
    );
    expect(String(result)).toContain("cancelled while");
    expect(String(result)).not.toContain("deadline passed");
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")?.check?.problem)
      .toContain("cancelled");
  });


  it("lets a passed revision settle the original's failed check", async () => {
    const { harness } = await load();
    await enable(harness);
    queueSpawns(harness, ["th_unit", "th_check_1", "th_rev_1", "th_check_2", "th_dependent"]);
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output:
        threadId === "th_check_1"
          ? "VERDICT: fail the parser still fails"
          : threadId === "th_check_2"
            ? "- VERDICT: pass the parser works now"
            : "changed the parser",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(result)).toContain("revision 1");
    expect(spawned).toHaveLength(4);
    let state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.check?.verdict).toBe("rejected");
    // The revision's passing check settles the chain on the root record.
    expect(original.resolvedBy).toBe("th_rev_1");

    // The original is accepted on the fixed chain instead of refused forever.
    const accepted = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "accepted", notes: "the revision fixed it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(accepted)).toContain("Recorded accepted for th_unit");

    // A dependent unit can now start on the fixed original.
    const dependent = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Publish the parser", after: ["th_unit"], waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(dependent)).toContain("Delegated without waiting");
    expect(spawned).toHaveLength(5);
    state = await stateOf(harness);
    expect(state.delegations.some((entry) => entry.threadId === "th_dependent")).toBe(true);
  });

  it("fails closed when a cancellation lands after the worker settled but before its check started", async () => {
    const { harness } = await load();
    await enable(harness);
    const controller = new AbortController();
    queueSpawns(harness, ["th_unit"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId === "th_unit") {
        // The user cancelled in the window between the worker reaching idle and
        // the check unit being asked to start, so no check was ever spawned.
        controller.abort();
      }
      return makeThreadResponse({ id: threadId, parentThreadId: THREAD, projectId: PROJECT });
    });

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", verify: true },
      { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
    );

    expect(String(result)).toContain("no further check or revision ran");
    expect(spawned).toHaveLength(1);
    const row = (await stateOf(harness)).delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(row.verify).toBe(true);
    // The record says the unit wanted a check, and no verdict was stored.
    expect(row.check ?? null).toBeNull();

    // "Never checked" is not "passed": a later acceptance and a dependent unit
    // both refuse, instead of trusting a check that never ran.
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "accepted", notes: "it looks fine" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/independent check never ran/);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Publish the parser", after: ["th_unit"], waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/independent check never ran/);
    expect(spawned).toHaveLength(1);
  });

  /**
   * A real AbortSignal that reports aborted from the nth observation on, so a
   * test can land the cancellation in an exact window without a timer race.
   */
  function abortOnRead(count: number): { signal: AbortSignal; reads: () => number } {
    const controller = new AbortController();
    let seen = 0;
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === "aborted") {
          seen += 1;
          if (seen >= count && !target.aborted) controller.abort();
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as AbortSignal;
    return { signal, reads: () => seen };
  }

  it("releases the parallel and revision slots when a review call is cancelled while the revision is set up", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([unit()]) });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxParallelWorkers",
      value: 1,
    });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxRevisions",
      value: 2,
    });
    queueSpawns(harness, ["th_rev_1"]);
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "fixed the parser" }));

    // First read is the pre-claim guard; the second is the one after the slot
    // was taken, which is the cancellation window under test.
    const { signal } = abortOnRead(2);
    const cancelled = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "fix the parser" },
      { threadId: THREAD, projectId: "proj_1", signal },
    );

    expect(String(cancelled)).toContain("cancelled while revision 1 was being set up");
    expect(spawned).toHaveLength(0);
    let state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions ?? 0).toBe(0);

    // Both slots came back. The retry spawns through the same cap of one, so a
    // leaked parallel claim would have refused it, and it spends revision 1, so
    // a leaked chain claim would have made this revision 2.
    const retried = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "fix the parser" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(retried)).toContain("revision 1");
    expect(String(retried)).not.toContain("still running");
    // The revision and the independent check it owes.
    expect(spawned).toHaveLength(2);
    state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions).toBe(1);
  });

  /** The record a manual rejection starts from: a checked build that failed. */
  function failedBuild(overrides: Record<string, unknown> = {}) {
    return unit({
      threadId: "th_unit",
      verify: true,
      verdict: "rejected",
      notes: "the parser still fails",
      check: { verdict: "rejected", detail: "the parser still fails", at: 1 },
      ...overrides,
    });
  }

  it("checks a manual revision, then accepts it and starts dependents on the chain", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([failedBuild()]) });
    queueSpawns(harness, ["th_rev_1", "th_check_1", "th_dependent"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_check_1" ? "VERDICT: pass the parser works now" : "changed the parser",
    }));

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "the parser still fails" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // The revision, and a real independent check of it: the revision keeps the
    // unit's `verify: true`, so it cannot be left un-checked.
    expect(spawned).toHaveLength(2);
    expect(String((spawned[1] as { title?: string }).title)).toContain("(check)");
    expect(String(text)).toContain("The check's verdict is pass.");
    let state = await stateOf(harness);
    const revision = state.delegations.find((entry) => entry.threadId === "th_rev_1")!;
    expect(revision.verify).toBe(true);
    expect(revision.check?.verdict).toBe("accepted");
    // The revision's passing check settles the chain on its root.
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.resolvedBy).toBe("th_rev_1");

    // Accepting the revision works, and a dependent unit can start on it.
    const accepted = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_rev_1", verdict: "accepted", notes: "the check passed" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(accepted)).toContain("Recorded accepted for th_rev_1");
    const dependent = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Publish the parser", after: ["th_unit"], waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(dependent)).toContain("Delegated without waiting");
    expect(spawned).toHaveLength(3);
    state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_dependent")).toBeDefined();
  });

  it("records a failing check on a manual revision and keeps the chain unsettled", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([failedBuild()]) });
    queueSpawns(harness, ["th_rev_1", "th_check_1"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_check_1" ? "VERDICT: fail two tests still fail" : "changed the parser",
    }));

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "the parser still fails" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("The check's verdict is fail.");
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_rev_1")!.check?.verdict).toBe("rejected");
    // No attempt has passed, so neither the revision nor the original is usable.
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.resolvedBy ?? null).toBeNull();
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_rev_1", verdict: "accepted" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/failed its independent check/);
  });

  it("leaves a revision's check pending on cancellation, then runs it on request", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([failedBuild()]) });
    queueSpawns(harness, ["th_rev_1", "th_check_1"]);
    const controller = new AbortController();
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => {
      if (threadId === "th_rev_1" && !controller.signal.aborted) {
        // The user cancelled after the revision settled but before its check
        // was asked to start.
        controller.abort();
      }
      return { output: threadId === "th_check_1" ? "VERDICT: pass the parser works now" : "changed the parser" };
    });

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "the parser still fails" },
      { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
    );
    expect(spawned).toHaveLength(1);
    expect(String(text)).toContain("stays pending its check");
    let state = await stateOf(harness);
    const revision = state.delegations.find((entry) => entry.threadId === "th_rev_1")!;
    expect(revision.verify).toBe(true);
    expect(revision.check ?? null).toBeNull();

    // Fail-closed, and the refusal names the way forward instead of a dead end.
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_rev_1", verdict: "accepted" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/independent check never ran.*orchestrator_check/);

    // The recovery path runs a real check unit and stores its verdict.
    const recovered = await harness.behavior.callAgentTool(
      CHECK_TOOL,
      { workerThreadId: "th_rev_1" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(recovered)).toContain("The check's verdict is pass.");
    expect(spawned).toHaveLength(2);
    state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_rev_1")!.check?.verdict).toBe("accepted");
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.resolvedBy).toBe("th_rev_1");
    const accepted = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_rev_1", verdict: "accepted", notes: "the recovered check passed" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(accepted)).toContain("Recorded accepted for th_rev_1");
  });

  it("refuses to re-run a check that already produced a verdict", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([failedBuild()]) });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("should not spawn");
    });
    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/already has a check this plugin can trust \(rejected\)/);
    expect(spawned).toHaveLength(0);
  });

  it("runs a pending check from the CLI for a session without the tool", async () => {
    const { harness } = await load({}, {
      [THREAD]: chainState([unit({ verify: true, check: null })]),
    });
    queueSpawns(harness, ["th_check_1"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "VERDICT: pass the parser works" }));

    const result = await harness.behavior.runCli(["check", "--worker", "th_unit"], {
      threadId: THREAD,
      projectId: "proj_1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The check's verdict is pass.");
    expect(spawned).toHaveLength(1);
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.check?.verdict).toBe("accepted");
  });

  it("keeps a revision pending when its check cannot start, then recovers", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([failedBuild()]) });
    let calls = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      calls += 1;
      // The revision starts. Its check unit cannot: the provider refuses it, so
      // no verdict may be invented for the revision.
      if (calls === 2) throw new Error("check provider unavailable");
      return makeThreadResponse({ id: calls === 1 ? "th_rev_1" : "th_check_1", parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_check_1" ? "VERDICT: pass the parser works now" : "changed the parser",
    }));

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "the parser still fails" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The refusal is reported, no check is recorded, and the revision slot is
    // spent once rather than the check quietly reading as a pass.
    expect(String(text)).toContain("check provider unavailable");
    expect(String(text)).toContain("stays pending its check");
    expect(spawned).toHaveLength(2);
    let state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions).toBe(1);
    expect(state.delegations.find((entry) => entry.threadId === "th_rev_1")!.check ?? null).toBeNull();
    // No parallel claim was left behind by the refused check: the recovery run
    // gets a worker.
    const recovered = await harness.behavior.callAgentTool(
      CHECK_TOOL,
      { workerThreadId: "th_rev_1" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(recovered)).toContain("The check's verdict is pass.");
    expect(spawned).toHaveLength(3);
    state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_rev_1")!.check?.verdict).toBe("accepted");
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.revisions).toBe(1);
  });

  /**
   * Two runs for the same unit must never both start a checker: the second is
   * refused, so a failing checker's verdict cannot be replaced by a passing one
   * from a duplicate, and a check costs at most one worker per claim.
   */
  it("starts one checker when two calls race for the same unit", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([unit({ verify: true, check: null })]) });
    queueSpawns(harness, ["th_check_1"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "VERDICT: pass the parser works" }));

    const outcomes = await Promise.allSettled([
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((entry) => entry.status === "rejected");
    expect(refused === undefined ? "" : String((refused as PromiseRejectedResult).reason)).toMatch(
      /check in flight|already has a check/,
    );
    expect(spawned).toHaveLength(1);
    const state = await stateOf(harness);
    expect(state.delegations.filter((entry) => entry.verifierFor === "th_unit")).toHaveLength(1);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.check?.verdict).toBe("accepted");
    // The claim and the attempt are settled by the result it produced.
    expect(original.checkClaim ?? null).toBeNull();
    expect(original.checkAttempts).toBe(1);
  });

  it("refuses a second check while an earlier check unit is still running", async () => {
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({ verify: true, check: null }),
        // The delegate call's own checker outlived its deadline and is still
        // live. Recovery must not start a second one behind it.
        {
          threadId: "th_live",
          title: "Fix the parser (check)",
          task: "check it",
          createdAt: 2,
          status: "active",
          verifierFor: "th_unit",
        },
      ]),
    });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("should not spawn");
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_live" ? "active" : "idle" }),
    );

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/check unit for th_unit is still running \(th_live\)/);
    expect(spawned).toHaveLength(0);
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    // A refusal spends neither an attempt nor a claim.
    expect(original.checkAttempts ?? 0).toBe(0);
    expect(original.checkClaim ?? null).toBeNull();
  });

  it("takes a check over once its claim has expired", async () => {
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({
          verify: true,
          check: null,
          checkAttempts: 1,
          verifiedBy: "th_dead",
          // A checker that died without reporting leaves this behind. It is
          // bounded, so the unit is not wedged for the rest of the session.
          checkClaim: { token: "check-dead", at: Date.now() - 2_000_000 },
        }),
        {
          threadId: "th_dead",
          title: "Fix the parser (check)",
          task: "check it",
          createdAt: 2,
          status: "idle",
          verifierFor: "th_unit",
        },
      ]),
    });
    queueSpawns(harness, ["th_check_2"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "VERDICT: pass the parser works" }));

    const text = await harness.behavior.callAgentTool(
      CHECK_TOOL,
      { workerThreadId: "th_unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("The check's verdict is pass.");
    expect(spawned).toHaveLength(1);
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.check?.verdict).toBe("accepted");
    expect(original.verifiedBy).toBe("th_check_2");
    expect(original.checkAttempts).toBe(2);
  });

  it("refuses a recovery check while a revision's own check is in flight", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([failedBuild()]) });
    let refusal: string | null = null;
    let probed = false;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      const id = spawned.length === 1 ? "th_rev_1" : "th_check_1";
      // The revision has settled and its own checker is being started, so it
      // reads as idle in the ledger. A recovery call landing in that window must
      // still be refused instead of starting a second checker.
      if (id === "th_check_1" && !probed) {
        probed = true;
        await harness.behavior
          .callAgentTool(
            CHECK_TOOL,
            { workerThreadId: "th_rev_1" },
            { threadId: THREAD, projectId: "proj_1" },
          )
          .then(
            (value) => {
              refusal = String(value);
            },
            (cause: unknown) => {
              refusal = String(cause);
            },
          );
      }
      return makeThreadResponse({ id, parentThreadId: THREAD });
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_check_1" ? "VERDICT: pass the parser works now" : "changed the parser",
    }));

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "the parser still fails" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("The check's verdict is pass.");
    expect(probed).toBe(true);
    expect(refusal ?? "").toMatch(/check in flight/);
    expect(spawned).toHaveLength(2);
    const state = await stateOf(harness);
    const revision = state.delegations.find((entry) => entry.threadId === "th_rev_1")!;
    expect(revision.check?.verdict).toBe("accepted");
    expect(revision.checkClaim ?? null).toBeNull();
  });

  it("archives a recovery check unit under the checks policy", async () => {
    const { harness } = await load({ workerRetention: "archive-checks" }, {
      [THREAD]: chainState([unit({ verify: true, check: null })]),
    });
    queueSpawns(harness, ["th_check_1"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "VERDICT: pass the parser works" }));

    await harness.behavior.callAgentTool(
      CHECK_TOOL,
      { workerThreadId: "th_unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The recovered checker is evidence, so retention treats it like any other
    // check unit; the unit it inspected is kept.
    expect(archivedThreads).toEqual(["th_check_1"]);
  });

  it("refuses a result from a checker a newer attempt replaced", () => {
    // A newer checker owns the unit, so its older verdict — pass or fail — is not
    // evidence for what was found since.
    expect(checkWriteAllowed("th_new", "th_new")).toBe(true);
    expect(checkWriteAllowed("th_new", "th_old")).toBe(false);
    // A write from a check that never started is only accepted while nothing is
    // bound, so it cannot fill in for a checker that is still running.
    expect(checkWriteAllowed("th_new", undefined)).toBe(false);
    expect(checkWriteAllowed(null, undefined)).toBe(true);
    expect(checkWriteAllowed(undefined, "th_any")).toBe(false);
  });

  it("does not re-roll the check of a chain a later revision settled", async () => {
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({ verify: true, check: null, revisions: 1, resolvedBy: "th_rev_0" }),
        unit({
          threadId: "th_rev_0",
          title: "Fix the parser (revision 1)",
          revisionOf: "th_unit",
          revisionRoot: "th_unit",
          revisions: 1,
          verify: true,
          check: { verdict: "accepted", detail: "the parser works now", at: 2 },
        }),
      ]),
    });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("should not spawn");
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "VERDICT: pass" }));

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/already settled by th_rev_0/);
    expect(spawned).toHaveLength(0);
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    // The resolution the revision earned survives a refused recovery.
    expect(original.resolvedBy).toBe("th_rev_0");
    expect(original.check ?? null).toBeNull();
  });

  it("refuses to check a worker that errored", async () => {
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({
          verify: true,
          check: { verdict: "rejected", detail: "", at: 1, problem: "the check left no verdict" },
        }),
      ]),
    });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("should not spawn");
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "error" }),
    );

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/ended in error/);
    expect(spawned).toHaveLength(0);
    const state = await stateOf(harness);
    // The stored fail-closed record is untouched: no check ran, so nothing was
    // rewritten to look like one did.
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.check?.problem).toBe(
      "the check left no verdict",
    );
  });

  it("spends a bounded number of recovery attempts", async () => {
    const { harness } = await load({}, {
      [THREAD]: chainState([unit({ verify: true, check: null, checkAttempts: 2 })]),
    });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("should not spawn");
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/spent its 2 check attempts/);
    expect(spawned).toHaveLength(0);
  });

  it("charges a recovery check to the turn's delegation budget", async () => {
    const createdAt = Date.now();
    const { harness } = await load({}, {
      [THREAD]: {
        ...chainState([unit({ verify: true, check: null, createdAt })]),
        enabledAt: new Date(createdAt - 60_000).toISOString(),
      },
    });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxDelegationsPerTurn",
      value: 1,
    });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("should not spawn");
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );

    const text = await harness.behavior.callAgentTool(
      CHECK_TOOL,
      { workerThreadId: "th_unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("caps a turn at 1");
    expect(spawned).toHaveLength(0);
    // A refused start spends nothing: the unit can be checked once the turn has
    // room again.
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.checkAttempts ?? 0).toBe(0);
    expect(original.checkClaim ?? null).toBeNull();
  });

  it("starts no checker when the call is cancelled after its claim is taken", async () => {
    const { bb, harness } = await load({}, { [THREAD]: chainState([unit({ verify: true, check: null })]) });
    const controller = new AbortController();
    let armed = false;
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => {
      // The cancellation lands while the check is being set up, after its slot
      // and its claim have been written.
      armed = true;
      return { output: "the parser" };
    });
    const publish = bb.realtime.publish.bind(bb.realtime);
    (bb.realtime as { publish: typeof bb.realtime.publish }).publish = (channel, payload) => {
      publish(channel, payload);
      if (armed && !controller.signal.aborted) controller.abort();
    };

    const text = await harness.behavior.callAgentTool(
      CHECK_TOOL,
      { workerThreadId: "th_unit" },
      { threadId: THREAD, projectId: "proj_1", signal: controller.signal },
    );
    expect(String(text)).toContain("cancelled");
    expect(spawned).toHaveLength(0);
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.checkAttempts ?? 0).toBe(0);
    expect(original.checkClaim ?? null).toBeNull();
    expect(original.check ?? null).toBeNull();
  });

  it("keeps the claim and names the checker when its record cannot be written", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([unit({ verify: true, check: null })]) });
    // Read the seeded state once, so the spy below hits the ledger write and not
    // the one-time import that seeds it.
    await stateOf(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "VERDICT: pass the parser works" }));
    const realNow = Date.now;
    let failures = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("state write failed");
      }
      return realNow();
    });
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      const response = makeThreadResponse({ id: "th_check_1", parentThreadId: THREAD });
      // The checker exists from here on. The next writes are the claim naming it
      // and then the ledger row that records it, each with one retry, so four
      // failures leave it unrecorded.
      failures = 4;
      return response;
    });
    let text: string;
    try {
      text = String(
        await harness.behavior.callAgentTool(
          CHECK_TOOL,
          { workerThreadId: "th_unit" },
          { threadId: THREAD, projectId: "proj_1" },
        ),
      );
      // Both the write and its retry failed, so the checker is named rather than
      // forgotten, and no verdict is invented for the unit.
      expect(text).toContain("th_check_1");
      expect(text).toMatch(/could not be written/);
    } finally {
      spy.mockRestore();
    }
    expect(spawned).toHaveLength(1);
    const state = await stateOf(harness);
    expect(state.delegations.some((entry) => entry.threadId === "th_check_1")).toBe(false);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    // The unrecorded checker keeps its attempt, its slot and the unit's claim, so
    // a second check cannot start behind it.
    expect(original.checkAttempts).toBe(1);
    expect(original.checkClaim ?? null).not.toBeNull();
    expect(original.check ?? null).toBeNull();
    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/check in flight/);
    expect(spawned).toHaveLength(1);
  });

  /** A claim timestamp past the TTL: a check's 900 s wait plus its two-minute margin. */
  const staleClaimAt = () => Date.now() - 1_100_000;

  it("keeps an expired check claim when the child listing may be truncated", async () => {
    const at = staleClaimAt();
    childThreads = Array.from({ length: 200 }, (_, index) => ({
      id: `th_old_${index}`,
      parentThreadId: THREAD,
      createdAt: at - 1,
      status: "idle",
    }));
    childThreads.push({
      id: "th_unseen_checker",
      parentThreadId: THREAD,
      createdAt: at + 1,
      status: "active",
    });
    const { harness } = await load({}, {
      [THREAD]: chainState([unit({ verify: true, check: null, checkAttempts: 1, checkClaim: { token: "check-old", at } })]),
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    await expect(
      harness.behavior.callAgentTool(CHECK_TOOL, { workerThreadId: "th_unit" }, { threadId: THREAD, projectId: "proj_1" }),
    ).rejects.toThrow(/child list/);
    expect(spawned).toHaveLength(0);
    expect((await stateOf(harness)).delegations.find((entry) => entry.threadId === "th_unit")?.checkClaim).not.toBeNull();
  });

  it("refuses a second check while an expired claim still names a running checker", async () => {
    const at = staleClaimAt();
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({
          verify: true,
          check: null,
          checkAttempts: 1,
          checkClaim: { token: "check-abc-1", at, threadId: "th_check_1" },
        }),
      ]),
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_check_1" ? "active" : "idle" }),
    );

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/still running as th_check_1/);
    expect(spawned).toHaveLength(0);

    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    // Refreshed, not expired: the live checker still owns the unit, and the
    // attempt it holds was not spent a second time.
    expect((original.checkClaim as { at: number }).at).toBeGreaterThan(at);
    expect(original.checkAttempts).toBe(1);
    expect(original.check ?? null).toBeNull();

    // A concurrent pair in the same window is refused the same way.
    const calls = await Promise.allSettled([
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ]);
    expect(calls.every((call) => call.status === "rejected")).toBe(true);
    expect(spawned).toHaveLength(0);
  });

  it("recovers a settled unrecorded checker's verdict instead of running a second check", async () => {
    const at = staleClaimAt();
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({
          verify: true,
          check: null,
          checkAttempts: 1,
          checkClaim: { token: "check-abc-1", at, threadId: "th_check_1" },
        }),
      ]),
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_check_1" ? "VERDICT: pass the parser works" : "changed the parser",
    }));

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/already run as th_check_1.*no second check was started/);
    expect(spawned).toHaveLength(0);

    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    // The report that checker really produced is the evidence; nothing was
    // invented and nothing was re-rolled.
    expect(original.check?.verdict).toBe("accepted");
    expect(original.check?.detail).toContain("the parser works");
    expect(original.checkClaim ?? null).toBeNull();
    // A root's own passing check is the chain's own check, so no separate
    // resolution is recorded for it.
    expect(original.resolvedBy ?? null).toBeNull();
    expect(original.checkAttempts).toBe(1);
  });

  it("releases a claim whose run never spawned a checker, then checks once", async () => {
    const at = staleClaimAt();
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({ verify: true, check: null, checkAttempts: 1, checkClaim: { token: "check-abc-1", at } }),
      ]),
    });
    // No child matches the title, so the reservation never became a worker.
    childThreads = [];
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_unit" ? "changed the parser" : "VERDICT: pass the parser works",
    }));

    const text = String(
      await harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    );
    expect(text).toContain("The check's verdict is pass.");
    expect(spawned).toHaveLength(1);
    const state = await stateOf(harness);
    expect(state.delegations.find((entry) => entry.threadId === "th_unit")!.check?.verdict).toBe("accepted");
  });

  it("adopts the checker a dead reservation spawned instead of starting another", async () => {
    const at = staleClaimAt();
    childThreads = [
      {
        id: "th_orphan",
        parentThreadId: THREAD,
        title: "Fix the parser (check)",
        createdAt: at + 5,
        status: "active",
      },
    ];
    const { harness } = await load({}, {
      [THREAD]: chainState([
        // A reservation token, no threadId: the run died after spawning.
        unit({ verify: true, check: null, checkAttempts: 1, checkClaim: { token: "check-abc-1", at } }),
      ]),
    });
    harness.inspection.sdk.stub("threads.experimental_listPluginMetadata", async () => ({
      threads: [{ threadId: "th_orphan", metadata: { checkFor: "th_unit" } }],
    }));
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_orphan" ? "active" : "idle" }),
    );

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/still running as th_orphan/);
    expect(spawned).toHaveLength(0);
    const state = await stateOf(harness);
    const claim = state.delegations.find((entry) => entry.threadId === "th_unit")!.checkClaim as {
      threadId?: string | null;
    };
    // The claim now names the thread BB would answer for.
    expect(claim.threadId).toBe("th_orphan");
  });

  it("does not let a check that was already running unsettle the chain", async () => {
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({
          verify: true,
          check: { verdict: "rejected", detail: "", at: 1, problem: "the check left no verdict" },
        }),
        unit({
          threadId: "th_rev_0",
          title: "Fix the parser (revision 1)",
          revisionOf: "th_unit",
          revisionRoot: "th_unit",
          revisions: 1,
          verify: true,
          check: { verdict: "accepted", detail: "the parser works now", at: 2 },
        }),
      ]),
    });
    queueSpawns(harness, ["th_check_1"]);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => {
      if (threadId === "th_check_1") {
        // The chain is settled by the orchestrator while this failing check is
        // still running: that is newer evidence than the check.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await harness.behavior.callAgentTool(
          REVIEW_TOOL,
          { workerThreadId: "th_rev_0", verdict: "accepted", notes: "the revision fixes it" },
          { threadId: THREAD, projectId: "proj_1" },
        );
        return { output: "VERDICT: fail the original parser is still broken" };
      }
      return { output: "the original parser" };
    });

    const text = await harness.behavior.callAgentTool(
      CHECK_TOOL,
      { workerThreadId: "th_unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("The check's verdict is fail.");
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.check?.verdict).toBe("rejected");
    // The resolution the acceptance recorded stands: a result from a check that
    // was already running does not take it back.
    expect(original.resolvedBy).toBe("th_rev_0");
  });

  /** A chain one revision already settled, with its failed original. */
  function resolvedChain() {
    return [
      unit({
        verify: true,
        verdict: "rejected",
        notes: "the parser still fails",
        revisions: 1,
        resolvedBy: "th_rev_0",
        check: { verdict: "rejected", detail: "the parser still fails", at: 1 },
      }),
      unit({
        threadId: "th_rev_0",
        title: "Fix the parser (revision 1)",
        revisionOf: "th_unit",
        revisionRoot: "th_unit",
        revisions: 1,
        verify: true,
        check: { verdict: "accepted", detail: "the parser works now", at: 2 },
      }),
    ];
  }

  it("restores a prior resolution when the revision it claimed never starts", async () => {
    const { harness } = await load({}, { [THREAD]: chainState(resolvedChain()) });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxRevisions",
      value: 2,
    });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("provider unavailable");
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "a new defect" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("revision worker could not start");
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    // The slot came back and the chain's standing resolution did not become the
    // casualty of a revision that never ran.
    expect(original.revisions).toBe(1);
    expect(original.resolvedBy).toBe("th_rev_0");
    const accepted = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "accepted", notes: "the earlier revision still stands" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(accepted)).toContain("Recorded accepted for th_unit");
  });

  it("does not resurrect a resolution the explicit rejection unsettled", async () => {
    const { harness } = await load({}, { [THREAD]: chainState(resolvedChain()) });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxRevisions",
      value: 2,
    });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("provider unavailable");
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );

    // Rejecting the revision that had settled the chain is an explicit
    // rejection of that fix, so a revision that never starts must not bring the
    // old resolution back.
    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_rev_0", verdict: "rejected", notes: "the fix regressed later" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("revision worker could not start");
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.revisions).toBe(1);
    expect(original.resolvedBy ?? null).toBeNull();
    expect(state.delegations.find((entry) => entry.threadId === "th_rev_0")!.verdict).toBe("rejected");
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Publish the parser", after: ["th_unit"], waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/Dependency th_unit was rejected/);
  });

  it("refuses an orphan checker it cannot attribute instead of adopting the newest", async () => {
    const at = staleClaimAt();
    // Two same-titled children the ledger does not name, and no metadata route
    // to tell them apart: delegations carry free-text titles, so two units can
    // produce this exact shape.
    childThreads = [
      {
        id: "th_orphan_a",
        parentThreadId: THREAD,
        title: "Fix the parser (check)",
        createdAt: at + 1,
        status: "idle",
      },
      {
        id: "th_orphan_b",
        parentThreadId: THREAD,
        title: "Fix the parser (check)",
        createdAt: at + 3,
        status: "idle",
      },
    ];
    const { harness } = await load({}, {
      [THREAD]: chainState([
        // A reservation that died after spawning: its token names no thread.
        unit({ verify: true, check: null, checkAttempts: 1, checkClaim: { token: "check-abc-1", at } }),
      ]),
    });
    const outputReads: string[] = [];
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => {
      outputReads.push(threadId);
      return { output: "VERDICT: pass the other unit is fine" };
    });

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/more than one unrecorded child could be its checker/);

    // Neither candidate was read, bound or stored: another unit's report never
    // becomes this unit's evidence, and no second checker was started.
    expect(outputReads).toEqual(["th_unit"]);
    expect(spawned).toHaveLength(0);
    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.verifiedBy ?? null).toBeNull();
    expect(original.check ?? null).toBeNull();
    expect(original.checkClaim ?? null).not.toBeNull();
  });

  it("adopts the orphan its own metadata names, not the newest same-titled child", async () => {
    const at = staleClaimAt();
    childThreads = [
      {
        id: "th_orphan_a",
        parentThreadId: THREAD,
        title: "Fix the parser (check)",
        createdAt: at + 1,
        status: "idle",
      },
      {
        id: "th_orphan_b",
        parentThreadId: THREAD,
        title: "Fix the parser (check)",
        createdAt: at + 3,
        status: "idle",
      },
    ];
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({ verify: true, check: null, checkAttempts: 1, checkClaim: { token: "check-abc-1", at } }),
      ]),
    });
    // The spawn stamp survives the ledger write that did not: `checkFor` is
    // definitive, and the newer child is explicitly another unit's checker.
    harness.inspection.sdk.stub(
      "threads.experimental_listPluginMetadata",
      async ({ threadIds }: { threadIds: string[] }) => ({
        threads: threadIds.map((threadId) => ({
          threadId,
          metadata: { checkFor: threadId === "th_orphan_a" ? "th_unit" : "th_other_unit" },
        })),
      }),
    );
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output:
        threadId === "th_orphan_a"
          ? "VERDICT: pass the parser works"
          : "VERDICT: fail the other unit is broken",
    }));

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/already run as th_orphan_a/);
    expect(spawned).toHaveLength(0);

    const state = await stateOf(harness);
    const original = state.delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.verifiedBy).toBe("th_orphan_a");
    expect(original.check?.verdict).toBe("accepted");
    expect(original.check?.detail).toContain("the parser works");
    expect(original.checkClaim ?? null).toBeNull();
  });

  it("does not adopt a title-matched orphan when its ownership metadata is unavailable", async () => {
    const at = staleClaimAt();
    childThreads = [{ id: "th_orphan", parentThreadId: THREAD, title: "Fix the parser (check)", createdAt: at + 1, status: "idle" }];
    const { harness } = await load({}, {
      [THREAD]: chainState([unit({ verify: true, check: null, checkAttempts: 1, checkClaim: { token: "check-abc-1", at } })]),
    });
    harness.inspection.sdk.stub("threads.experimental_listPluginMetadata", async () => { throw new Error("unavailable"); });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    await expect(harness.behavior.callAgentTool(CHECK_TOOL, { workerThreadId: "th_unit" }, { threadId: THREAD, projectId: "proj_1" })).rejects.toThrow();
    expect(spawned).toHaveLength(0);
    const original = (await stateOf(harness)).delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.verifiedBy ?? null).toBeNull();
    expect(original.check ?? null).toBeNull();
  });

  it("refuses a title-only orphan when its metadata names no unit", async () => {
    const at = staleClaimAt();
    childThreads = [
      {
        id: "th_orphan",
        parentThreadId: THREAD,
        title: "Fix the parser (check)",
        createdAt: at + 1,
        status: "idle",
      },
    ];
    const { harness } = await load({}, {
      [THREAD]: chainState([
        unit({ verify: true, check: null, checkAttempts: 1, checkClaim: { token: "check-abc-1", at } }),
      ]),
    });
    // The metadata route answers, and this child's own namespace says only that
    // it is some worker of this orchestrator — never which unit it inspects.
    harness.inspection.sdk.stub(
      "threads.experimental_listPluginMetadata",
      async ({ threadIds }: { threadIds: string[] }) => ({
        threads: threadIds.map((threadId) => ({ threadId, metadata: { workerFor: THREAD } })),
      }),
    );
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({
      output: "VERDICT: pass some other unit is fine",
    }));

    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/does not name this unit as the one it checks/);
    expect(spawned).toHaveLength(0);
    const original = (await stateOf(harness)).delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(original.verifiedBy ?? null).toBeNull();
    expect(original.check ?? null).toBeNull();
    expect(original.checkClaim ?? null).not.toBeNull();
  });

  it("releases the slot a failed ledger write took but keeps counting the live checker", async () => {
    const { harness } = await load(
      { maxParallelWorkers: 1, maxDelegationsPerTurn: 0 },
      { [THREAD]: chainState([unit({ verify: true, check: null })]) },
    );
    // Read the seeded state once, so the spy below hits the ledger writes and
    // not the one-time import that seeds it.
    await stateOf(harness);
    let checkerRunning = true;
    harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({
        id: threadId,
        status: threadId === "th_check_1" && checkerRunning ? "active" : "idle",
      }),
    );
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "VERDICT: pass the parser works" }));
    const realNow = Date.now;
    let failures = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("state write failed");
      }
      return realNow();
    });
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      const response = makeThreadResponse({ id: "th_check_1", parentThreadId: THREAD });
      // Naming the checker on the claim and recording it in the ledger, each
      // with one retry: four failures leave it unrecorded.
      failures = 4;
      return response;
    });
    try {
      const text = String(
        await harness.behavior.callAgentTool(
          CHECK_TOOL,
          { workerThreadId: "th_unit" },
          { threadId: THREAD, projectId: "proj_1" },
        ),
      );
      expect(text).toMatch(/could not be written/);
    } finally {
      spy.mockRestore();
    }
    expect(spawned).toHaveLength(1);

    // The checker is still running and unrecorded, so its slot is still counted
    // even though its process-local reservation was handed back: the cap cannot
    // be exceeded by the release.
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do something else", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/caps parallel workers at 1/);

    // Once it settles, the slot comes back instead of staying spent for the life
    // of the process.
    checkerRunning = false;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_unit_2", parentThreadId: THREAD });
    });
    const next = String(
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do something else", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    );
    expect(next).toContain("th_unit_2");
    expect(spawned).toHaveLength(2);

    // The durable claim still decides the unit: a second check for it is refused.
    await expect(
      harness.behavior.callAgentTool(
        CHECK_TOOL,
        { workerThreadId: "th_unit" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/check in flight/);
  });

  it("carries the rejected attempt's report into a manual revision brief", async () => {
    const { harness } = await load({}, { [THREAD]: chainState([unit()]) });
    const previous = "changed src/schema.ts and ran npm test -- schema";
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output: threadId === "th_unit" ? previous : "VERDICT: pass the revision works",
    }));
    queueSpawns(harness, ["th_rev_1", "th_check_1"]);

    const text = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: "th_unit", verdict: "rejected", notes: "the migration is missing" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(text)).toContain("revision 1");

    const revision = spawned[0] as { prompt?: string };
    // The revision is told what was already claimed and changed, so it fixes the
    // findings instead of guessing at a state the previous attempt created.
    expect(revision.prompt).toContain(previous);
    expect(revision.prompt).toContain("the migration is missing");
    expect(revision.prompt).not.toContain("(the previous attempt reported no final text)");
  });

  it("does not accept a unit whose checker only echoed the worker's pass", async () => {
    const { harness } = await load();
    await enable(harness);
    queueSpawns(harness, ["th_unit", "th_check"]);
    harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
      output:
        threadId === "th_check"
          ? ["> Ran the suite.", "> VERDICT: pass the parser works"].join("\n")
          : ["Ran the suite.", "VERDICT: pass the parser works"].join("\n"),
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Fix the parser", kind: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The only pass in the checker's report is a quote of the worker's claim.
    expect(String(result)).toContain("no verdict this plugin can trust");
    expect(spawned).toHaveLength(2);
    const unitRow = (await stateOf(harness)).delegations.find((entry) => entry.threadId === "th_unit")!;
    expect(unitRow.check?.verdict).toBe("rejected");
    expect(unitRow.check?.problem ?? "").toContain("no line that reads");
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_unit", verdict: "accepted", notes: "looks fine" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/no verdict this plugin can trust/);
  });
});

describe("check verdict provenance", () => {
  it("never reads a verdict the checker quoted or fenced", () => {
    const quoted = ["> Ran the suite.", "> VERDICT: pass the worker says so"].join("\n");
    expect(parseCheckVerdict(quoted)).toMatchObject({
      verdict: null,
      reasoning: expect.stringContaining("no line that reads"),
    });

    const fenced = ["```", "Ran the suite.", "VERDICT: pass the worker says so", "```", "VERDICT: fail the suite fails"].join(
      "\n",
    );
    // The fenced verdict is quoted material; the checker's own fail is the result.
    expect(parseCheckVerdict(fenced)).toEqual({ verdict: "rejected", reasoning: "the suite fails" });

    const quotedThenOwn = [quoted, "VERDICT: fail the suite fails"].join("\n");
    expect(parseCheckVerdict(quotedThenOwn).verdict).toBe("rejected");
  });

  it("fails closed when an unquoted echo and the checker's own verdict both appear", () => {
    const echoed = [
      "Ran the suite.",
      "VERDICT: pass the worker says so",
      "I could not reproduce it.",
      "VERDICT: fail the suite fails",
    ].join("\n");
    // Two verdicts cannot be attributed, and guessing which one the checker
    // stated is exactly the false acceptance this closes.
    expect(parseCheckVerdict(echoed)).toEqual({
      verdict: null,
      reasoning: "the check reported both a pass and a fail, so its result is ambiguous",
    });
  });

  it("refuses a verdict that is not the checker's final line", () => {
    expect(parseCheckVerdict(["VERDICT: pass the worker says so", "Then I read the diff."].join("\n"))).toMatchObject({
      verdict: null,
      reasoning: expect.stringContaining("not its final line"),
    });
    // A rule line after the verdict is decoration, not more report.
    expect(parseCheckVerdict(["VERDICT: pass the suite is green", "---", ""].join("\n"))).toEqual({
      verdict: "accepted",
      reasoning: "the suite is green",
    });
  });

  it("fails closed on two statements of the same verdict", () => {
    expect(parseCheckVerdict(["VERDICT: pass one", "VERDICT: pass again"].join("\n"))).toMatchObject({
      verdict: null,
      reasoning: expect.stringContaining("more than one verdict line"),
    });
  });
});

describe("the minimized judge evidence", () => {
  async function sentState(report: string): Promise<string> {
    let state = "";
    const capture = (async (_url: string, init: RequestInit) => {
      state = (JSON.parse(String(init.body)) as { state: string }).state;
      return new Response(JSON.stringify({ answers: { verified: { type: "noul", noul: 0.9 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await judgeCheckVerdict("k", report, capture);
    return state;
  }

  it("reads the verdict through Markdown and drops an ambiguous one", async () => {
    expect(await sentState("## Check\n- **VERDICT: fail** — the suite fails\nnpm test\n$ npx vitest --run")).toBe(
      "VERDICT: fail\nCOMMANDS: npm, npx",
    );
    // Both words present: no verdict token leaves, so the judge reads programs only.
    expect(await sentState("VERDICT: pass\n**VERDICT: fail**\nnpm test")).toBe("COMMANDS: npm");
  });

  it("does not send a verdict or a command the report only quoted", async () => {
    const report = [
      "> VERDICT: pass the worker says so",
      "> npm test",
      "npx vitest --run",
      "VERDICT: fail the suite fails",
    ].join("\n");
    // The quoted pass and the quoted command are the worker's claim; only the
    // checker's own program and verdict leave the machine.
    expect(await sentState(report)).toBe("VERDICT: fail\nCOMMANDS: npx");
  });
});
