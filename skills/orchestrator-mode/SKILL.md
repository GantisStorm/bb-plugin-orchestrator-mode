---
name: orchestrator-mode
description: "Use when a thread is in orchestrator mode and must delegate every unit of work instead of doing it, or when the user asks to turn orchestrator mode on or off, check what direct work a thread did, or change how new threads start. Covers the composer toggle and the `bb orchestrator-mode` CLI."
---

# Orchestrator mode

Orchestrator mode is a per-thread switch. When it is on, that thread does not
do the work: it reads, plans, asks, delegates, and reports, and every unit of
actual work goes to a worker thread.

## Recognize it

The composer shows a hub glyph and, while the mode is on, a strip above the
input naming the enforcement level and any direct work already caught. The
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
  detected.

Read-only shell commands (`ls`, `cat`, `rg`, `git status`, `git diff`,
`git log`, `find`, `wc`) do not count as work unless the plugin's
"Read-only shell commands are not work" setting is turned off.

## Delegating

Use the `orchestrator_delegate` tool, which the mode selects for the thread.
Give it a complete, self-contained brief: the worker cannot see this
conversation. Fan out independent units; sequence only real dependencies.

Do not try to turn the mode off yourself or work around it. If the work
genuinely cannot be delegated, say so and stop, and ask the user to turn the
mode off in the composer.
