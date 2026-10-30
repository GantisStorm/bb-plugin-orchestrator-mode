// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { EnforcementLevel, Violation, WorkerConfig } from "./shared";

const app = await loadPluginApp(() => import("./app"));
const customization = app.composerCustomizations[0]!;
const Host = customization.banners![0]!.component;
const Toggle = customization.actions![0]!.component;

const THREAD = "th_1";

interface StateDto {
  enabled: boolean;
  enforcement: EnforcementLevel | null;
  effectiveEnforcement: EnforcementLevel;
  enabledAt: string | null;
  violations: Violation[];
  delegations: never[];
  nudgeCount: number;
  defaultForNewThreads: boolean;
  allowReadCommands: boolean;
  maxNudges: number;
  workers: {
    total: number;
    running: number;
    settled: number;
    accepted: number;
    rejected: number;
    waiting: number;
    unconfirmed: number;
  };
  children: {
    available: boolean;
    total: number;
    running: number;
    error: string | null;
  };
  retention: {
    threads: number;
    caps: { delegations: number; violations: number; seenRows: number };
    lost: { delegations: number; violations: number; seenRows: number };
  };
  judge: { configured: boolean; advisory: boolean };
}

function baseState(overrides: Partial<StateDto> = {}): StateDto {
  return {
    enabled: false,
    enforcement: null,
    effectiveEnforcement: "guard",
    enabledAt: null,
    violations: [],
    delegations: [],
    nudgeCount: 0,
    defaultForNewThreads: false,
    allowReadCommands: true,
    maxNudges: 3,
    workers: {
      total: 0,
      running: 0,
      settled: 0,
      accepted: 0,
      rejected: 0,
      waiting: 0,
      unconfirmed: 0,
    },
    children: { available: true, total: 0, running: 0, error: null },
    retention: {
      threads: 1,
      caps: { delegations: 50, violations: 100, seenRows: 500 },
      lost: { delegations: 0, violations: 0, seenRows: 0 },
    },
    judge: { configured: false, advisory: false },
    ...overrides,
  };
}

/** An in-memory stand-in for the backend's RPC surface. */
function makeRpc(initial: Partial<StateDto> = {}) {
  const state = baseState(initial);
  let defaultEnabled = state.defaultForNewThreads;
  const calls: { method: string; input: unknown }[] = [];
  const handlers = {
    get_state: async () => {
      calls.push({ method: "get_state", input: null });
      return { ...state };
    },
    set_enabled: async (input: {
      threadId: string;
      enabled: boolean;
      enforcement?: EnforcementLevel | null;
    }) => {
      calls.push({ method: "set_enabled", input });
      state.enabled = input.enabled;
      state.enforcement = input.enforcement ?? null;
      state.effectiveEnforcement = input.enforcement ?? "guard";
      return { ...state };
    },
    get_default: async () => {
      calls.push({ method: "get_default", input: null });
      return { enabled: defaultEnabled };
    },
    set_default: async (input: { enabled: boolean }) => {
      calls.push({ method: "set_default", input });
      defaultEnabled = input.enabled;
      return { enabled: defaultEnabled };
    },
    clear_violations: async (input: { threadId: string }) => {
      calls.push({ method: "clear_violations", input });
      state.violations = [];
      return { ...state };
    },
  };
  return { handlers, calls, state, isDefaultEnabled: () => defaultEnabled };
}

type Rpc = ReturnType<typeof makeRpc>;

// renderSlot mounts into the shared document, so every query is scoped to the
// slot it came from; two surfaces of one composer are two slots.
const slots: RenderedSlot[] = [];

function mount(component: typeof Host, rpc: Rpc, options: Record<string, unknown>): RenderedSlot {
  const slot = renderSlot({ component }, {}, { rpc: rpc.handlers as never, ...options });
  slots.push(slot);
  return slot;
}

/** Let the components' effects and RPC promises settle inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** One read can start the next: settle the state read, then the child list. */
async function settle(): Promise<void> {
  await flush();
  await flush();
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
  await flush();
}

function threadOptions() {
  return {
    composer: { scope: { kind: "thread" as const, threadId: THREAD }, text: "do the thing" },
    context: { threadId: THREAD, projectId: "proj_1" },
  };
}

function composeOptions() {
  return {
    composer: { scope: { kind: "new-thread" as const, projectId: "proj_1" }, text: "" },
  };
}

function toggleButton(slot: RenderedSlot): HTMLElement {
  return within(slot.container).getByRole("button");
}

function plusMenuView(scope: unknown) {
  return {
    scope,
    layout: "compact" as const,
    draft: { text: "", isEmpty: true, attachmentCount: 0 },
    run: { isRunning: false, isSubmitting: false },
  };
}

/** One row as BB's own thread list returns it; only the fields the strip reads. */
function childRow(overrides: Record<string, unknown> & { id: string }) {
  return {
    parentThreadId: THREAD,
    title: null,
    titleFallback: null,
    status: "idle",
    visibility: "visible",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** A `useSdk()` stand-in whose child list returns `rows` (or throws `error`). */
function childSdk(rows: unknown[] | string, calls: unknown[] = []) {
  return {
    threads: {
      list: async (args: unknown) => {
        calls.push(args);
        if (typeof rows === "string") throw new Error(rows);
        return rows;
      },
    },
  };
}

afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  cleanup();
});

describe("registration", () => {
  it("registers one composer customization for thread and new-thread scopes", () => {
    expect(app.composerCustomizations).toHaveLength(1);
    expect(customization.id).toBe("orchestrator-mode");
    expect(customization.scopes).toEqual(["thread", "new-thread"]);
    expect(customization.actions).toHaveLength(1);
    expect(customization.banners).toHaveLength(1);
    expect(customization.banners![0]!.chrome).toBe("bare");
    expect(customization.plusMenu).toHaveLength(1);
  });

  it("draws the manifest-declared glyph on every surface", async () => {
    const rpc = makeRpc({ enabled: true });
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();
    expect(
      host.container.querySelectorAll('[data-icon="orchestrator-mode/hub"]'),
    ).toHaveLength(1);
    expect(
      toggle.container.querySelectorAll('[data-icon="orchestrator-mode/hub"]'),
    ).toHaveLength(1);
  });
});

describe("thread composer", () => {
  it("leaves an enabled thread's editable draft undecorated", async () => {
    const rpc = makeRpc({ enabled: true });
    const options = threadOptions();
    options.composer.text = "First line\nSecond line";
    const host = mount(Host, rpc, options);
    await flush();

    expect(within(host.container).getByTestId("orch-strip-thread")).toBeTruthy();
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe(options.composer.text);
  });

  it("shows an off toggle and no strip while the mode is off", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();

    expect(within(host.container).queryByTestId("orch-strip-thread")).toBeNull();
    expect(host.container.textContent).toBe("");
    const button = toggleButton(toggle);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toContain("Turn orchestrator mode on");
    expect(host.inspection.composer.textEffect).toBeNull();
  });

  it("turns the mode on from the toggle without decorating the draft", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();

    await click(toggleButton(toggle));

    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(true);
    expect(toggleButton(toggle).getAttribute("aria-pressed")).toBe("true");
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe("do the thing");
    expect(within(host.container).getByTestId("orch-strip-thread")).toBeTruthy();
    expect(
      host.container.querySelector('[data-level="guard"]')?.textContent,
    ).toBe("guard");
  });

  it("turns the mode off from the strip without changing the draft", async () => {
    const rpc = makeRpc({ enabled: true });
    const host = mount(Host, rpc, threadOptions());
    await flush();
    expect(within(host.container).getByTestId("orch-strip-thread")).toBeTruthy();
    expect(host.inspection.composer.textEffect).toBeNull();

    await click(within(host.container).getByText("Turn off"));

    expect(within(host.container).queryByTestId("orch-strip-thread")).toBeNull();
    expect(rpc.state.enabled).toBe(false);
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe("do the thing");
  });

  it("reports the direct work the watchdog caught", async () => {
    const rpc = makeRpc({
      enabled: true,
      effectiveEnforcement: "block",
      violations: [
        {
          id: "row_1",
          turnId: "turn_1",
          workKind: "file-change",
          detail: "changed src/server.ts itself",
          detectedAt: Date.now(),
        },
      ],
    });
    const host = mount(Host, rpc, threadOptions());
    await flush();
    const strip = within(host.container);

    expect(strip.getByTestId("orch-alert")).toBeTruthy();
    expect(strip.getByText("Direct work caught")).toBeTruthy();
    expect(strip.getByText("1")).toBeTruthy();
    expect(strip.getByText("changed src/server.ts itself")).toBeTruthy();
    expect(host.container.querySelector('[data-level="block"]')?.textContent).toBe("block");
    expect(host.container.querySelector('[data-violations="true"]')).not.toBeNull();
  });

  it("draws one robot per child thread BB has now, not per delegation record", async () => {
    const rpc = makeRpc({
      enabled: true,
      workers: {
        total: 21,
        running: 1,
        settled: 20,
        accepted: 18,
        rejected: 2,
        waiting: 0,
        unconfirmed: 0,
      },
      children: { available: true, total: 2, running: 1, error: null },
    });
    const listCalls: unknown[] = [];
    const host = mount(Host, rpc, {
      ...threadOptions(),
      sdk: childSdk(
        [
          childRow({ id: "th_build", title: "Build the settings page", status: "active" }),
          childRow({ id: "th_review", title: "Review the diff", status: "idle" }),
        ],
        listCalls,
      ),
    });
    await settle();
    const strip = within(host.container);

    // The crew is BB's current tree: two child threads, two robots.
    const crew = strip.getByTestId("orch-crew");
    expect(crew.getAttribute("role")).toBe("group");
    expect(crew.getAttribute("aria-label")).toBe("Current child threads");
    const bots = Array.from(crew.querySelectorAll(".orch__bot"));
    expect(bots).toHaveLength(2);
    expect(bots[0]!.getAttribute("aria-label")).toBe("Build the settings page · active");
    expect(bots[0]!.getAttribute("data-state")).toBe("running");
    expect(bots[1]!.getAttribute("aria-label")).toBe("Review the diff · idle");
    expect(bots[1]!.getAttribute("data-state")).toBe("idle");
    // Nothing on this row comes from the 21 delegation records.
    expect(crew.textContent).not.toContain("+");
    // One bounded page of live children: hidden ones count, archived ones never
    // spend the page a live child needs.
    expect(listCalls[0]).toEqual({
      parentThreadId: THREAD,
      archived: false,
      includeHidden: true,
      limit: 50,
    });

    // The live count agrees, and history stays named as history.
    const current = strip.getByTestId("orch-children");
    expect(current.getAttribute("role")).toBe("group");
    expect(current.getAttribute("aria-label")).toBe("Child threads in BB right now");
    expect(current.textContent).toContain("2 children");
    expect(strip.getByTestId("orch-children-running").textContent).toContain("1 running");
    expect(strip.getByTestId("orch-children-running").getAttribute("data-live")).toBe("true");
    const ledger = strip.getByTestId("orch-ledger-stats");
    expect(ledger.getAttribute("aria-label")).toContain("Delegation ledger");
    expect(ledger.textContent).toContain("21 recorded");
    expect(ledger.textContent).toContain("20 finished");
    // The retired reading of the record as a current count is gone.
    expect(host.container.textContent).not.toContain("21 workers");
  });

  it("says no child threads right now only when BB's count says none", async () => {
    const rpc = makeRpc({
      enabled: true,
      workers: {
        total: 21,
        running: 0,
        settled: 21,
        accepted: 21,
        rejected: 0,
        waiting: 0,
        unconfirmed: 0,
      },
      children: { available: true, total: 0, running: 0, error: null },
    });
    const host = mount(Host, rpc, threadOptions());
    await settle();
    const strip = within(host.container);

    // Records cannot make that line false: there are no children now.
    expect(strip.getByText("No child threads right now.")).toBeTruthy();
    expect(strip.queryByTestId("orch-crew")).toBeNull();
    expect(strip.getByTestId("orch-ledger-stats").textContent).toContain("21 recorded");
  });

  it("counts the children it does not draw instead of drawing them", async () => {
    const listed = Array.from({ length: 12 }, (_, index) =>
      childRow({ id: `th_${index}`, title: `Worker ${index}` }),
    );
    const rpc = makeRpc({
      enabled: true,
      children: { available: true, total: 12, running: 0, error: null },
    });
    const host = mount(Host, rpc, { ...threadOptions(), sdk: childSdk(listed) });
    await settle();
    const strip = within(host.container);

    const crew = strip.getByTestId("orch-crew");
    expect(crew.querySelectorAll(".orch__bot")).toHaveLength(8);
    const more = crew.querySelector(".orch__more")!;
    // The overflow is one readable unit for assistive tech, so it carries the
    // image role instead of sitting in the DOM as unlabelled text.
    expect(more.getAttribute("role")).toBe("img");
    expect(more.textContent).toBe("+4");
    expect(more.getAttribute("aria-label")).toBe("4 more child threads");
    expect(strip.getByTestId("orch-children").textContent).toContain("12 children");
  });

  it("draws a hidden child as a child and leaves archived, deleted and foreign ones out", async () => {
    const rpc = makeRpc({
      enabled: true,
      children: { available: true, total: 2, running: 0, error: null },
    });
    const host = mount(Host, rpc, {
      ...threadOptions(),
      sdk: childSdk([
        childRow({ id: "th_hidden", title: "Hidden worker", visibility: "hidden", status: "active" }),
        childRow({ id: "th_archived", title: "Archived worker", archivedAt: Date.now() }),
        childRow({ id: "th_deleted", title: "Deleted worker", deletedAt: Date.now() }),
        childRow({ id: "th_foreign", title: "Someone else's worker", parentThreadId: "th_other" }),
      ]),
    });
    await settle();
    const crew = within(host.container).getByTestId("orch-crew");
    const bots = Array.from(crew.querySelectorAll(".orch__bot"));
    expect(bots).toHaveLength(1);
    expect(bots[0]!.getAttribute("aria-label")).toBe(
      "Hidden worker · active · hidden from the sidebar",
    );
    expect(bots[0]!.getAttribute("data-hidden")).toBe("true");
    // The one child it could not draw is counted, not silently dropped, and the
    // count is readable on its own.
    const more = crew.querySelector(".orch__more")!;
    expect(more.textContent).toBe("+1");
    expect(more.getAttribute("role")).toBe("img");
    expect(more.getAttribute("aria-label")).toBe("1 more child thread");
  });

  it("keeps a live child on the page when archived rows crowd the read limit", async () => {
    // The request asks for live rows only; a page that ignored that must still
    // never let history push a live child out of the crew.
    const archived = Array.from({ length: 50 }, (_, index) =>
      childRow({ id: `th_archived_${index}`, title: `Archived ${index}`, archivedAt: Date.now() }),
    );
    const rpc = makeRpc({
      enabled: true,
      children: { available: true, total: 52, running: 1, error: null },
    });
    const host = mount(Host, rpc, {
      ...threadOptions(),
      sdk: childSdk([
        ...archived,
        childRow({ id: "th_live", title: "Live worker", status: "active" }),
        childRow({ id: "th_hidden", title: "Quiet worker", visibility: "hidden" }),
      ]),
    });
    await settle();
    const crew = within(host.container).getByTestId("orch-crew");

    const bots = Array.from(crew.querySelectorAll(".orch__bot"));
    expect(bots).toHaveLength(2);
    expect(bots.map((bot) => bot.getAttribute("aria-label"))).toEqual([
      "Live worker · active",
      "Quiet worker · idle · hidden from the sidebar",
    ]);
    expect(bots.map((bot) => bot.getAttribute("data-hidden"))).toEqual(["false", "true"]);
    expect(bots.map((bot) => bot.getAttribute("role"))).toEqual(["img", "img"]);

    // 52 counted and 2 painted: the missing 50 are named as a count on a unit
    // assistive tech can read, never silently dropped.
    const more = crew.querySelector(".orch__more")!;
    expect(more.textContent).toBe("+50");
    expect(more.getAttribute("role")).toBe("img");
    expect(more.getAttribute("aria-label")).toBe("50 more child threads");
    expect(within(host.container).getByTestId("orch-children").textContent).toContain(
      "52 children",
    );
  });

  it("reports children as unknown rather than counting the ledger when BB cannot be read", async () => {
    const rpc = makeRpc({
      enabled: true,
      workers: {
        total: 21,
        running: 1,
        settled: 20,
        accepted: 18,
        rejected: 2,
        waiting: 0,
        unconfirmed: 0,
      },
      children: { available: false, total: 0, running: 0, error: "threads.count failed" },
    });
    const host = mount(Host, rpc, threadOptions());
    await flush();
    const strip = within(host.container);

    const unknown = strip.getByTestId("orch-children-unknown");
    expect(unknown.textContent).toContain("Children unknown");
    expect(unknown.textContent).toContain("threads.count failed");
    expect(strip.queryByTestId("orch-children-running")).toBeNull();
    // Neither the ledger total nor a zero is passed off as the live count, and
    // no robot claims an identity the plugin could not read.
    expect(host.container.textContent).not.toContain("21 children");
    expect(host.container.textContent).not.toContain("0 children");
    expect(host.container.textContent).not.toContain("No child threads");
    expect(strip.queryByTestId("orch-crew")).toBeNull();
    expect(strip.getByTestId("orch-ledger-stats").textContent).toContain("21 recorded");
  });

  it("says the child list could not be read instead of drawing records as children", async () => {
    const rpc = makeRpc({
      enabled: true,
      workers: {
        total: 21,
        running: 0,
        settled: 21,
        accepted: 21,
        rejected: 0,
        waiting: 0,
        unconfirmed: 0,
      },
      children: { available: true, total: 2, running: 0, error: null },
    });
    const host = mount(Host, rpc, { ...threadOptions(), sdk: childSdk("threads.list failed") });
    await settle();
    const strip = within(host.container);

    const note = strip.getByTestId("orch-crew-unknown");
    expect(note.textContent).toContain("2 child threads are in BB");
    expect(note.textContent).toContain("threads.list failed");
    expect(strip.queryByTestId("orch-crew")).toBeNull();
    expect(host.container.querySelectorAll(".orch__bot")).toHaveLength(0);
    expect(strip.getByTestId("orch-ledger-stats").textContent).toContain("21 recorded");
  });

  it("refetches when the backend publishes a state change", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    await flush();
    const before = rpc.calls.filter((call) => call.method === "get_state").length;

    rpc.state.enabled = true;
    await act(async () => {
      await host.behavior.emitRealtime("orchestrator-state", { at: Date.now() });
    });
    await flush();

    expect(rpc.calls.filter((call) => call.method === "get_state").length).toBeGreaterThan(before);
    expect(within(host.container).getByTestId("orch-strip-thread")).toBeTruthy();
  });

  it("toggles through the plus-menu row the compact layout falls back to", async () => {
    const rpc = makeRpc();
    mount(Host, rpc, threadOptions());
    await flush();

    const item = customization.plusMenu![0]!;
    expect(item.label).toBe("Orchestrator mode");
    const disabled = item.disabled as (view: unknown) => boolean;
    expect(disabled(plusMenuView({ kind: "thread", threadId: THREAD }))).toBe(false);

    await act(async () => {
      await item.run({ composer: plusMenuView({ kind: "thread", threadId: THREAD }) as never });
    });
    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(true);
  });

  it("disables the plus-menu row in a scope this plugin does not own", async () => {
    const rpc = makeRpc();
    mount(Host, rpc, threadOptions());
    await flush();
    const disabled = customization.plusMenu![0]!.disabled as (view: unknown) => boolean;
    expect(
      disabled(
        plusMenuView({
          kind: "side-chat",
          projectId: "p",
          parentThreadId: "t",
          tabId: "tab",
          childThreadId: null,
        }),
      ),
    ).toBe(true);
  });
});

describe("new-thread composer", () => {
  it("leaves the new-thread draft undecorated when the default is on", async () => {
    const rpc = makeRpc({ defaultForNewThreads: true });
    const options = composeOptions();
    options.composer.text = "Start a new task";
    const host = mount(Host, rpc, options);
    await flush();

    expect(within(host.container).getByText(/New threads start as orchestrators/)).toBeTruthy();
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe(options.composer.text);
  });

  it("toggles the plugin-wide default instead of a thread", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, composeOptions());
    const toggle = mount(Toggle, rpc, composeOptions());
    await flush();

    expect(toggleButton(toggle).getAttribute("aria-label")).toContain("Start new threads");
    await click(toggleButton(toggle));

    expect(within(host.container).getByText(/New threads start as orchestrators/)).toBeTruthy();
    expect(rpc.calls.some((call) => call.method === "set_default")).toBe(true);
    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(false);
    expect(rpc.isDefaultEnabled()).toBe(true);
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe("");
  });

  it("renders nothing in the root compose screen while the default is off", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, composeOptions());
    await flush();
    expect(host.container.textContent).toBe("");
  });
});

describe("the settings section", () => {
  /** The section's own RPC surface: the settings of one scope, the worker configuration and the rules append. */
  function makeSettingsRpc(initial: WorkerConfig = {}) {
    let worker: WorkerConfig = initial;
    let extra = "";
    let newThreads = false;
    /** Whether the fake secret store holds a judge key. */
    let judgeKeyStored = false;
    /** The global record the server would resolve every scope over. */
    const globals: Record<string, unknown> = {
      enforcement: "guard",
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
      judgeAdvisory: false,
      maxRevisions: 1,
      maxStallResumes: 1,
    };
    const projectWorker: Record<string, WorkerConfig> = {};
    const projectRules: Record<string, string> = {};
    const projectSettings: Record<string, Record<string, unknown>> = {};
    /** One scope's settings as the server returns them. */
    const scopeView = (projectId: string | null) => ({
      values: projectId === null ? globals : { ...globals, ...(projectSettings[projectId] ?? {}) },
      global: globals,
      overridden: projectId === null ? [] : Object.keys(projectSettings[projectId] ?? {}),
    });
    const calls: { method: string; input: unknown }[] = [];
    const handlers = {
      get_default: async () => {
        calls.push({ method: "get_default", input: null });
        return { enabled: newThreads };
      },
      set_default: async (input: { enabled: boolean }) => {
        calls.push({ method: "set_default", input });
        newThreads = input.enabled;
        return { enabled: newThreads };
      },
      get_worker_execution: async () => {
        calls.push({ method: "get_worker_execution", input: null });
        return worker;
      },
      set_worker_execution: async (next: WorkerConfig | null) => {
        calls.push({ method: "set_worker_execution", input: next });
        worker = next ?? {};
        return worker;
      },
      get_contract: async () => {
        calls.push({ method: "get_contract", input: { threadId: null } });
        return { text: "contract text", extra, limit: 370 };
      },
      set_contract: async (input: { extra: string }) => {
        calls.push({ method: "set_contract", input });
        extra = input.extra;
        return { text: "contract text", extra, limit: 370 };
      },
      get_project_worker: async (input: { projectId: string }) => {
        calls.push({ method: "get_project_worker", input });
        return projectWorker[input.projectId] ?? {};
      },
      set_project_worker: async (input: { projectId: string; config: WorkerConfig | null }) => {
        calls.push({ method: "set_project_worker", input });
        if (input.config === null) delete projectWorker[input.projectId];
        else projectWorker[input.projectId] = input.config;
        return projectWorker[input.projectId] ?? {};
      },
      get_project_rules: async (input: { projectId: string }) => {
        calls.push({ method: "get_project_rules", input });
        return { text: "contract text", extra: projectRules[input.projectId] ?? "", limit: 370 };
      },
      set_project_rules: async (input: { projectId: string; extra: string }) => {
        calls.push({ method: "set_project_rules", input });
        projectRules[input.projectId] = input.extra;
        return { text: "contract text", extra: input.extra, limit: 370 };
      },
      get_scope_settings: async (input: { projectId: string | null }) => {
        calls.push({ method: "get_scope_settings", input });
        return scopeView(input.projectId);
      },
      get_judge: async () => {
        calls.push({ method: "get_judge", input: null });
        return { configured: judgeKeyStored };
      },
      set_scope_setting: async (input: { projectId: string | null; key: string; value: unknown }) => {
        calls.push({ method: "set_scope_setting", input });
        if (input.projectId === null) {
          globals[input.key] = input.value;
        } else {
          const current = { ...(projectSettings[input.projectId] ?? {}) };
          if (input.value === null) delete current[input.key];
          else current[input.key] = input.value;
          projectSettings[input.projectId] = current;
        }
        return scopeView(input.projectId);
      },
    };
    return {
      handlers,
      calls,
      /** The inputs one method was called with, in order. */
      inputsOf: (method: string) => calls.filter((call) => call.method === method).map((call) => call.input),
      worker: () => worker,
      setJudgeStored: (value: boolean) => {
        judgeKeyStored = value;
      },
    };
  }

  /** A catalog stand-in: one available provider, one default model. */
  const settingsSdk = {
    projects: {
      list: async () => [
        { id: "proj_alpha", name: "Alpha" },
        { id: "proj_beta", name: "Beta" },
      ],
    },
    providers: {
      models: async (input?: { providerId?: string }) =>
        input?.providerId === undefined
          ? { providers: [{ id: "command-code", name: "Command Code", available: true }], permissionCeiling: "accept-edits" }
          : { models: [{ id: "model-a", name: "Model A", isDefault: true, defaultReasoningEffort: "high" }] },
    },
  };

  const section = app.settingsSections[0]!;

  function mountSettings(rpc: ReturnType<typeof makeSettingsRpc>) {
    const slot = renderSlot({ component: section.component }, {}, {
      rpc: rpc.handlers as never,
      sdk: settingsSdk as never,
    });
    slots.push(slot);
    return slot;
  }

  const lastWrite = (rpc: ReturnType<typeof makeSettingsRpc>) =>
    [...rpc.calls].reverse().find((call) => call.method === "set_worker_execution")?.input as WorkerConfig | undefined;

  it("writes a seeded execution on Custom and clears it on Inherit", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    await click(within(slot.container).getByRole("button", { name: "Custom" }));
    expect(lastWrite(rpc)).toMatchObject({ providerId: "command-code", model: "model-a", reasoningLevel: "high" });

    await click(within(slot.container).getByRole("button", { name: "Inherit" }));
    expect(lastWrite(rpc)).toEqual({});
  });

  it("sets a retry target on Retry and drops it on Report", async () => {
    const rpc = makeSettingsRpc({ providerId: "command-code", model: "model-a" });
    const slot = mountSettings(rpc);
    await flush();

    await click(within(slot.container).getByRole("button", { name: "Retry" }));
    expect(lastWrite(rpc)).toMatchObject({ fallback: { providerId: "command-code", model: "model-a" } });

    await click(within(slot.container).getByRole("button", { name: "Report" }));
    expect(lastWrite(rpc)).toEqual({ providerId: "command-code", model: "model-a" });
  });

  it("shows a partial preset as repairable instead of Unsupported", async () => {
    const rpc = makeSettingsRpc({ providerId: "command-code", model: "model-a", presets: { research: { reasoningLevel: "high" } } });
    const slot = mountSettings(rpc);
    await flush();

    // Scoped to the Research row: the provider pickers elsewhere on the page render the
    // SDK's own "Unsupported" for a model their catalog does not list, which is not this.
    const researchRow = within(slot.container).getByText("Research").closest("div")!;
    expect(researchRow.textContent).not.toContain("Unsupported");
    expect(researchRow.textContent).toContain("Saved without a provider and model");

    // The Set button repairs it into a complete preset, which is what fills the row.
    const setButtons = within(slot.container).getAllByRole("button", { name: "Set" });
    await click(setButtons[2]!);
    expect(lastWrite(rpc)).toMatchObject({ presets: { research: { providerId: "command-code", model: "model-a" } } });
  });

  it("writes the project rules through", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    const textarea = within(slot.container).getByRole("textbox");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Never touch files under generated/." } });
    });
    await click(within(slot.container).getByRole("button", { name: "Save rules" }));
    expect(rpc.calls.filter((call) => call.method === "set_contract").at(-1)?.input).toEqual({
      extra: "Never touch files under generated/.",
    });
  });
  it("writes the global record from the rows while Global is selected", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    // Global scope offers no Inherit: the record has nothing above it to fall back to.
    const enforcement = within(slot.container).getByLabelText("Enforcement") as HTMLSelectElement;
    expect(Array.from(enforcement.options, (option) => option.textContent)).toEqual([
      "instruct",
      "guard",
      "block",
    ]);
    await act(async () => {
      fireEvent.change(enforcement, { target: { value: "block" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "enforcement",
      value: "block",
    });
    expect((within(slot.container).getByLabelText("Enforcement") as HTMLSelectElement).value).toBe("block");

    // The contract level is one row with three levels, and writes its own key.
    const shape = within(slot.container).getByLabelText("What the orchestrator is told") as HTMLSelectElement;
    expect(Array.from(shape.options, (option) => option.textContent)).toEqual([
      "standard",
      "review-heavy",
      "delegate-only",
    ]);
    await act(async () => {
      fireEvent.change(shape, { target: { value: "delegate-only" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "contractPreset",
      value: "delegate-only",
    });
  });

  it("writes the two boolean switches as booleans, so the server stores them", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();
    const query = within(slot.container);
    const reads = query.getByLabelText("Read-only commands") as HTMLSelectElement;
    expect(reads.value).toBe("true");
    await act(async () => {
      fireEvent.change(reads, { target: { value: "false" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "allowReadCommands",
      value: false,
    });

    const judge = query.getByLabelText("Advisory judge") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(judge, { target: { value: "true" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "judgeAdvisory",
      value: true,
    });
  });

  it("names the judge key's state instead of the opt-in", async () => {
    const rpc = makeSettingsRpc();
    rpc.setJudgeStored(true);
    const slot = mountSettings(rpc);
    await flush();
    const query = within(slot.container);
    const optIn = query.getByLabelText("Advisory judge") as HTMLSelectElement;
    // The scope never opted in, so the row below must not claim the judge is on
    // just because a key exists.
    expect(optIn.value).toBe("false");
    expect(query.getByText("Key stored.")).toBeTruthy();
    expect(query.queryByText(/Judge on/)).toBeNull();
  });

  it("says no key is stored when the secret store is empty", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();
    expect(within(slot.container).getByText("No key stored.")).toBeTruthy();
  });

  it("draws no second password field for the judge key", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();
    const query = within(slot.container);

    // BB's own plugin settings render the single secret field from the
    // descriptor. This panel only reports whether a key exists, so it draws no
    // field and makes no write: one place to enter the key, one label.
    expect(slot.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(query.getByTestId("orch-judge-key-state").textContent).toBe("No key stored.");
    expect(rpc.calls.some((call) => call.method === "set_judge_key")).toBe(false);
  });

  it("re-reads the judge key state after a settings write in BB", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();
    const state = () => within(slot.container).getByTestId("orch-judge-key-state").textContent;
    expect(state()).toBe("No key stored.");

    rpc.setJudgeStored(true);
    await act(async () => {
      await slot.behavior.emitRealtime("orchestrator-state", { at: Date.now() });
    });
    await flush();
    expect(state()).toBe("Key stored.");
  });

  it("writes the worker model policy from the scope editor", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();
    const query = within(slot.container);
    const policy = query.getByLabelText("Per-unit model overrides") as HTMLSelectElement;
    // Pinned first, because it is the value a scope that never opened the row keeps.
    expect(Array.from(policy.options, (option) => option.textContent)).toEqual([
      "pinned",
      "flexible",
    ]);
    await act(async () => {
      fireEvent.change(policy, { target: { value: "flexible" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "workerModelPolicy",
      value: "flexible",
    });
  });

  it("writes the orchestrator and worker subagent policies from the scope editor", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();
    const query = within(slot.container);

    // None first: the value a scope that never opened the row keeps is the one the row shows when it opens.
    const orchestrator = query.getByLabelText("Orchestrator subagents") as HTMLSelectElement;
    expect(Array.from(orchestrator.options, (option) => option.textContent)).toEqual([
      "none",
      "all",
    ]);
    await act(async () => {
      fireEvent.change(orchestrator, { target: { value: "all" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "orchestratorSubagents",
      value: "all",
    });

    // The worker policy keeps its own key, one row further down.
    const worker = query.getByLabelText("Worker subagents") as HTMLSelectElement;
    expect(Array.from(worker.options, (option) => option.textContent)).toEqual([
      "blocked",
      "allowed",
    ]);
    await act(async () => {
      fireEvent.change(worker, { target: { value: "allowed" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "workerSubagents",
      value: "allowed",
    });
  });

  it("lets a project override queued child messages and inherit the global policy again", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();
    const query = within(slot.container);
    expect((query.getByLabelText("Child messages") as HTMLSelectElement).value).toBe("queued");
    await act(async () => {
      fireEvent.change(query.getByLabelText("Scope"), { target: { value: "proj_alpha" } });
    });
    await flush();
    expect(query.getByRole("option", { name: "Inherit (queued until turn ends)" })).toBeTruthy();
    await act(async () => {
      fireEvent.change(query.getByLabelText("Child messages"), { target: { value: "immediate" } });
    });
    await flush();
    expect(rpc.inputsOf("set_scope_setting").at(-1)).toEqual({
      projectId: "proj_alpha", key: "childMessageDelivery", value: "immediate",
    });
    await act(async () => {
      fireEvent.change(query.getByLabelText("Child messages"), { target: { value: "" } });
    });
    await flush();
    expect(rpc.inputsOf("set_scope_setting").at(-1)).toEqual({
      projectId: "proj_alpha", key: "childMessageDelivery", value: null,
    });
  });

  it("keeps the new-thread default global, and out of a project's scope", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    await click(within(slot.container).getByRole("button", { name: "On" }));
    expect(rpc.calls.filter((call) => call.method === "set_default").at(-1)?.input).toEqual({ enabled: true });

    // A project has no such setting: it is a composer default, not thread behaviour.
    const selector = within(slot.container).getByLabelText("Scope") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(selector, { target: { value: "proj_alpha" } });
    });
    await flush();
    expect(within(slot.container).queryByText("Start new threads as orchestrators")).toBeNull();
  });

  it("scopes the section to a project, and writes the override there", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    // Global by default: the project RPCs are untouched.
    expect(rpc.calls.some((call) => call.method === "get_project_worker")).toBe(false);
    const selector = within(slot.container).getByLabelText("Scope") as HTMLSelectElement;
    expect(Array.from(selector.options, (option) => option.textContent)).toEqual(["Global", "Alpha", "Beta"]);

    await act(async () => {
      fireEvent.change(selector, { target: { value: "proj_alpha" } });
    });
    await flush();
    expect(rpc.inputsOf("get_project_worker")).toContainEqual({ projectId: "proj_alpha" });

    // A settings row writes one field for the project, and Inherit clears it again.
    const enforcement = within(slot.container).getByLabelText("Enforcement") as HTMLSelectElement;
    expect(Array.from(enforcement.options, (option) => option.textContent)).toEqual([
      "Inherit (guard)",
      "instruct",
      "block",
    ]);
    await act(async () => {
      fireEvent.change(enforcement, { target: { value: "block" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: "proj_alpha",
      key: "enforcement",
      value: "block",
    });

    // The select's first option is the inherit affordance for an enum row.
    await act(async () => {
      fireEvent.change(within(slot.container).getByLabelText("Enforcement"), { target: { value: "" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: "proj_alpha",
      key: "enforcement",
      value: null,
    });
  });

  it("clears a project's worker execution when Inherit is pressed in project scope", async () => {
    const rpc = makeSettingsRpc({ providerId: "command-code", model: "model-a" });
    const slot = mountSettings(rpc);
    await flush();
    const selector = within(slot.container).getByLabelText("Scope") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(selector, { target: { value: "proj_beta" } });
    });
    await flush();

    // Custom stores a project execution; Inherit then hands it back to the global one.
    await click(within(slot.container).getByRole("button", { name: "Custom" }));
    expect(rpc.calls.filter((call) => call.method === "set_project_worker").at(-1)?.input).toMatchObject({
      projectId: "proj_beta",
    });
    await click(within(slot.container).getByRole("button", { name: "Inherit" }));
    expect(rpc.calls.filter((call) => call.method === "set_project_worker").at(-1)?.input).toEqual({
      projectId: "proj_beta",
      config: null,
    });
  });
});

describe("setup-jev pending interaction", () => {
  const setup = app.pendingInteractions[0]!;
  const SYNTHETIC_KEY = "sk-or-v1-synthetic-test-key";

  function mountSetup(
    options: {
      submitError?: string;
      cancelError?: string;
      payload?: Record<string, boolean | string>;
    } = {},
  ) {
    const submitted: unknown[] = [];
    let cancellations = 0;
    const slot = renderSlot(
      { component: setup.component },
      {
        interaction: {
          id: "pi_1",
          threadId: THREAD,
          title: "Store the OpenRouter key for the advisory judge",
          payload: options.payload ?? { configured: false },
          createdAt: 1,
          expiresAt: null,
        },
        submit: async (value: unknown) => {
          if (options.submitError !== undefined) throw new Error(options.submitError);
          submitted.push(value);
        },
        cancel: async () => {
          if (options.cancelError !== undefined) throw new Error(options.cancelError);
          cancellations += 1;
        },
      },
    );
    slots.push(slot);
    return { slot, submitted, cancellations: () => cancellations };
  }

  async function typeKey(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      fireEvent.change(input, { target: { value } });
    });
  }

  it("registers one renderer under the setup-jev id", () => {
    expect(app.pendingInteractions).toHaveLength(1);
    expect(setup.id).toBe("setup-jev");
  });

  it("submits exactly the typed key and nothing else", async () => {
    const { slot, submitted, cancellations } = mountSetup();
    const query = within(slot.container);
    const input = query.getByLabelText("OpenRouter key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");

    await typeKey(input, SYNTHETIC_KEY);
    await click(query.getByRole("button", { name: "Save key" }));

    expect(submitted).toEqual([{ key: SYNTHETIC_KEY }]);
    expect(cancellations()).toBe(0);
  });

  it("saves without offering a value read back from the secret store", async () => {
    // The payload's only field is a boolean; a renderer that read it as a secret
    // would leak it into the document.
    const { slot } = mountSetup({ payload: { configured: true, judgeKey: `stored-${SYNTHETIC_KEY}` } });
    await flush();
    const text = slot.container.textContent ?? "";
    expect(text).toContain("A key is already stored; saving replaces it.");
    expect(text).not.toContain(SYNTHETIC_KEY);
    expect(slot.container.querySelectorAll('input[type="password"]')).toHaveLength(1);
  });

  it("cancels without submitting and leaves no error", async () => {
    const { slot, submitted, cancellations } = mountSetup();
    const query = within(slot.container);
    await click(query.getByRole("button", { name: "Cancel" }));
    expect(cancellations()).toBe(1);
    expect(submitted).toEqual([]);
    expect(query.queryByRole("alert")).toBeNull();
  });

  it("blocks an empty key in place with an accessible error", async () => {
    const { slot, submitted } = mountSetup();
    const query = within(slot.container);
    const input = query.getByLabelText("OpenRouter key") as HTMLInputElement;

    await click(query.getByRole("button", { name: "Save key" }));

    const alert = query.getByRole("alert");
    expect(alert.textContent).toBe("Enter the key before saving.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(submitted).toEqual([]);
  });

  it("reports a failed save accessibly without echoing the key or losing it", async () => {
    const { slot, submitted } = mountSetup({ submitError: `Rejected: ${SYNTHETIC_KEY}` });
    const query = within(slot.container);
    const input = query.getByLabelText("OpenRouter key") as HTMLInputElement;

    await typeKey(input, SYNTHETIC_KEY);
    await click(query.getByRole("button", { name: "Save key" }));

    const alert = query.getByRole("alert");
    expect(alert.textContent).not.toContain(SYNTHETIC_KEY);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe(SYNTHETIC_KEY);
    expect((query.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(false);
    expect(submitted).toEqual([]);
  });

  it("reports a failed cancel in the same alert region", async () => {
    const { slot, cancellations } = mountSetup({ cancelError: "The prompt has already closed." });
    const query = within(slot.container);
    await click(query.getByRole("button", { name: "Cancel" }));
    expect(query.getByRole("alert")).toBeTruthy();
    expect(cancellations()).toBe(0);
  });

  it("reveals the key on Show and masks it again on Hide", async () => {
    const { slot } = mountSetup();
    const query = within(slot.container);
    const input = query.getByLabelText("OpenRouter key") as HTMLInputElement;
    await typeKey(input, SYNTHETIC_KEY);

    const show = query.getByRole("button", { name: "Show" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    await click(show);
    expect((query.getByLabelText("OpenRouter key") as HTMLInputElement).type).toBe("text");
    expect(query.getByRole("button", { name: "Hide" }).getAttribute("aria-pressed")).toBe("true");

    await click(query.getByRole("button", { name: "Hide" }));
    expect((query.getByLabelText("OpenRouter key") as HTMLInputElement).type).toBe("password");
    expect((query.getByLabelText("OpenRouter key") as HTMLInputElement).value).toBe(SYNTHETIC_KEY);
  });
});
