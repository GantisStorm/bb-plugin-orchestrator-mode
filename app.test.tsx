// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";
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
  it("shows an off toggle and no strip while the mode is off", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();

    expect(within(host.container).queryByText(/Orchestrator mode is on/)).toBeNull();
    expect(host.container.textContent).toBe("");
    const button = toggleButton(toggle);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toContain("Turn orchestrator mode on");
    expect(host.inspection.composer.textEffect).toBeNull();
  });

  it("turns the mode on from the toggle and paints the draft", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();

    await click(toggleButton(toggle));

    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(true);
    expect(toggleButton(toggle).getAttribute("aria-pressed")).toBe("true");
    expect(host.inspection.composer.textEffect).toEqual({ className: "orch-draft" });
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
    expect(within(host.container).getByText(/may only read, plan, ask/)).toBeTruthy();
  });

  it("turns the mode off from the strip and clears the draft effect", async () => {
    const rpc = makeRpc({ enabled: true });
    const host = mount(Host, rpc, threadOptions());
    await flush();
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
    expect(host.inspection.composer.textEffect).toEqual({ className: "orch-draft" });

    await click(within(host.container).getByText("Turn off"));

    expect(within(host.container).queryByText(/Orchestrator mode is on/)).toBeNull();
    expect(rpc.state.enabled).toBe(false);
    expect(host.inspection.composer.textEffect).toBeNull();
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

    expect(strip.getByText(/Direct work caught \(1 total\)/)).toBeTruthy();
    expect(strip.getByText(/changed src\/server.ts itself/)).toBeTruthy();
    expect(strip.getByText(/· block/)).toBeTruthy();
    expect(host.container.querySelector('[data-violations="true"]')).not.toBeNull();
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
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
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
      await item.run({ composer: {} as never, view: plusMenuView({ kind: "thread", threadId: THREAD }) as never });
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
  });

  it("renders nothing in the root compose screen while the default is off", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, composeOptions());
    await flush();
    expect(host.container.textContent).toBe("");
  });
});

describe("the workers settings section", () => {
  /** The section's own RPC surface: the worker configuration and the rules append. */
  function makeSettingsRpc(initial: WorkerConfig = {}) {
    let worker: WorkerConfig = initial;
    let extra = "";
    const calls: { method: string; input: unknown }[] = [];
    const handlers = {
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
    };
    return { handlers, calls, worker: () => worker };
  }

  /** A catalog stand-in: one available provider, one default model. */
  const settingsSdk = {
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
});
