---
name: orchestrator-mode
description: "Use when a thread is in orchestrator mode and must delegate every unit of work instead of doing it, or when the user asks to turn orchestrator mode on or off, check what direct work a thread did, or change how new threads start. Covers the composer toggle and the `bb orchestrator-mode` CLI."
---

# Orchestrator mode

Orchestrator mode is a per-thread switch. When it is on, that thread does not
do the work: it reads, plans, asks, delegates, and reports, and every unit of
actual work goes to a worker thread.

## Recognise it

The composer shows a delegation icon (possibly under More plugin actions) and,
while the mode is on, a strip above the input naming the enforcement level and
any direct work already caught. The
thread's own instructions carry the full contract when the mode is on — if you
are reading a "# ORCHESTRATOR MODE IS ON" block, it is on for you.

## Commands

```
bb orchestrator-mode status [--thread <id>] [--json]
bb orchestrator-mode on [--thread <id>] [--enforcement instruct|guard|block] [--json]
bb orchestrator-mode off [--thread <id>] [--json]
bb orchestrator-mode violations [--thread <id>] [--clear] [--json]
bb orchestrator-mode default [on|off] [--json]
```

`--thread` defaults to the thread running the command, so an agent can inspect
or change its own mode. A change applies when the provider session is next
constructed; a live session keeps the instructions it started with.

## Enforcement levels

- `instruct` — the contract is injected, nothing is watched.
- `guard` (default) — the timeline is watched; direct work is recorded and the
  thread gets a corrective message telling it to re-delegate.
- `block` — as `guard`, plus the turn is stopped the moment direct work is
  detected. Detection follows the action, so a fast write can finish before
  the stop; there is no pre-tool-call veto.

The watchdog grants grace turns while provider sessions gain the contract:
one when enabled while idle, or the active turn and the next one when enabled
mid-turn. Historical work is not judged. Follow the contract whenever your
session receives it, including during watchdog grace turns.

The new-thread default only reaches qualifying root threads created while
it is on, at a user-initiated dispatch. It leaves existing threads, child
workers and side chats alone.

Read-only shell commands (`ls`, `cat`, `rg`, `git status`, `git diff`,
`git log`, `find`, `wc`) do not count as work unless the plugin's
"Read-only shell commands are not work" setting is turned off.
Creating images counts as work and must be delegated; inspecting images is
allowed. Git commands that create or delete branches or tags, change remotes,
or rewrite reflogs also count as work.

## Delegating

Use the `orchestrator_delegate` tool, which the mode selects for the thread.
Give it a complete, self-contained brief: the worker cannot see this
conversation. Fan out independent units; sequence only real dependencies.

## Recording a verdict

Every worker whose result you used needs a verdict before you finish the turn:
call `orchestrator_review` with the worker's thread id, `accepted` or
`rejected`, and a line of notes. A turn that ends with unjudged workers gets
one reminder. A rejected result is re-delegated, never patched by you.

`verify: true` on a delegation spawns an independent check unit that inspects
the repository and reports `VERDICT: pass` or `VERDICT: fail`; its report comes
back with the worker's, and its thread is recorded as that delegation's
evidence. Use it when you cannot judge a unit from its report alone.

Arguments are `task` (required, at most 20,000 characters), `title` (optional,
at most 200), `waitForResult` (default `true`), `timeoutSeconds` (default `900`,
integer range 10–3,600) and `hidden` (default `false`). A timeout or
`preset` (optional) names a stored execution preset. `verify` (default `false`)
adds the check unit described above. `waitForResult: false` leaves the worker
running; inspect that worker later and review its result.

## Choosing the worker's execution

Workers run on the model and permission mode the plugin's Worker execution
setting names, falling back to this project's remembered defaults. When the
plugin has a retry target configured it re-delegates a failed worker once on
that provider and model before you hear about the failure, so do not re-run a
failed unit by hand. Override them for one unit
with `provider`, `model`, `reasoning` and `permissionMode` — a stronger model
for a hard unit, a cheaper one for a mechanical unit. Valid ids come from
`bb provider list` and `bb provider models <provider>`, both read-only. A model
the catalog does not offer is refused with the available ids named, so pass a
model you have seen there rather than guessing.



The default corrective-message cap is three per enablement. Recording and
block-mode stops continue after the cap. Clearing violations or disabling the
thread resets correction counters.

Do not try to turn the mode off yourself or work around it. If the work
genuinely cannot be delegated, say so and stop, and ask the user to turn the
mode off in the composer.
