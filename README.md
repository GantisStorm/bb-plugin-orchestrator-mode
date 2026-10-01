# Orchestrator Mode

A composer toggle that turns a BB thread into a **pure orchestrator**: it may
only read, plan, ask, delegate and report. Every unit of actual work has to go
to a worker thread, and the plugin catches the thread doing the work itself.

Flip the hub glyph in the composer (or the row in the `+` menu) and the next
turn on that thread is handed a hard contract instead of the ordinary one.

## Why

A strong model left alone will just do the task. That is fine for one thread and
useless for ten: you get one long serial transcript instead of a fan-out you can
watch, retry and parallelize. Orchestrator mode removes the option. The thread
keeps its judgment — decomposition, review, synthesis — and loses its hands.

## What turning it on does

**1. The contract.** `bb.agents.configure` injects an instruction block into
every session the mode is on for, and selects one extra tool,
`orchestrator_delegate`, which is the only sanctioned way to get work done:

```
orchestrator_delegate({ task, title?, waitForResult?, timeoutSeconds?, hidden? })
```

It spawns a worker thread under the orchestrator, in the same environment, with
`task` as a self-contained brief, waits for it, and returns its result. The
worker is a normal BB thread you can open in the sidebar.

**2. The dispatch checkpoint.** The authoritative per-thread state lives in this
plugin's own KV store, which the thread's agent cannot write. The
`message.dispatch` hook rewrites a mirror of it onto the thread's plugin
metadata before every turn — that mirror is what `configure` can read
synchronously. If the agent edits its own metadata to switch the mode off, the
next dispatch puts it back.

**3. The watchdog.** In `guard` and `block`, the plugin reads the thread's
timeline, classifies every new work row, and acts:

| Level | What happens |
| --- | --- |
| `instruct` | The contract only. Nothing is watched. |
| `guard` *(default)* | Direct work is recorded, published to the composer strip, and the thread gets a corrective message telling it to re-delegate. |
| `block` | As `guard`, plus the turn is **stopped** the moment direct work is detected. |

Classification:

- **Work** — `file-change` rows; `command` rows that are not read-only; generic
  tool rows whose name mutates (`write`, `edit`, `apply`, `exec`, `commit`, …).
- **Not work** — delegation, questions, forms, approvals, plans, file reads,
  searches, web fetches, and read-only shell commands (`ls`, `cat`, `rg`,
  `git status`, `git diff`, `git log`, `find`, `wc`, …). An orchestrator still
  needs to look around.

Read-only command leniency is a setting; turn it off and every command counts.

## Using it

### Composer

- **Hub glyph** beside the voice/submit buttons — toggles the mode for the
  current thread. In the root compose screen it toggles the *"new threads start
  as orchestrators"* default instead.
- **`+` menu → Orchestrator mode** — the same toggle, available in compact
  layout where action buttons do not render.
- **Strip above the input** — shows the enforcement level and the last direct
  work caught, with a Turn off button.
- The draft gets a left-edge accent while the mode is on.

### CLI

```
bb orchestrator-mode status [--thread <id>] [--json]
bb orchestrator-mode on [--thread <id>] [--enforcement instruct|guard|block] [--json]
bb orchestrator-mode off [--thread <id>] [--json]
bb orchestrator-mode violations [--thread <id>] [--clear] [--json]
bb orchestrator-mode default [on|off] [--json]
```

`--thread` defaults to the thread running the command, so an agent can inspect
its own mode.

### Settings

Settings → Plugins → Orchestrator Mode, or `bb plugin config orchestrator-mode`:

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultForNewThreads` | `false` | Root threads created while this is on start as orchestrators. Existing threads are untouched. |
| `enforcement` | `guard` | Level used by threads with no override of their own. |
| `allowReadCommands` | `true` | Read-only shell commands are research, not work. |
| `maxNudges` | `3` | Corrective messages per thread before the plugin only records. |

## Honest limits

- **BB gives plugins no pre-tool-call veto.** The only admission checkpoint is
  `message.dispatch`, which decides whether a *message* runs, not what the agent
  does inside a turn. So `block` is detect-and-stop, with roughly a second of
  latency from the coalesced thread-event notification — not
  prevent-at-source. A fast `write` can land before the stop arrives. The
  contract is the primary control; the watchdog is the backstop.
- **Instructions apply when a session is next constructed.** Turning the mode on
  mid-turn does not rewrite the running session's instructions; it takes effect
  on the next turn. The watchdog, by contrast, applies immediately.
- **Not a security boundary.** Plugin metadata is writable by any API client and
  by the thread's own agent, which is exactly why the authoritative state lives
  in this plugin's KV store and the metadata copy is only a projection refreshed
  at every dispatch.

## Development

```
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest: policy, backend behavior, composer surfaces
bb plugin build
bb plugin install .
bb plugin dev         # rebuild + reload on save
```

Three test files, one per layer:

- `shared.test.ts` — the policy on its own: read-only command detection,
  work-row classification, the metadata mirror, the contract's 4096-character
  budget.
- `server.test.ts` — `server.ts` driven through `@get-bb/plugin-sdk/testing`'s
  fake plugin host: `configure` resolution, the dispatch hook, the watchdog's
  record/correct/stop ladder, the delegation tool, RPC and the CLI.
- `app.test.tsx` — the composer surfaces through `renderSlot`: the toggle, the
  strip, the draft effect, the plus-menu fallback, and the new-thread default.

`shared.ts` holds the whole policy with no SDK imports, which is what makes the
first file possible and keeps the contract text and the classifier from
drifting apart.
