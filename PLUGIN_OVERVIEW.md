Turn any thread into a pure orchestrator from the composer: it may only read,
plan, ask, delegate and report, and every unit of real work goes to a worker
thread.

## What you get

- A **hub toggle** in the composer, plus a `+` menu row for compact layout, and
  a strip above the input that shows the enforcement level and any direct work
  the watchdog caught.
- A hard **contract** injected into every turn the mode is on for, and an
  `orchestrator_delegate` tool that spawns a worker thread and brings back its
  result.
- A **watchdog** that reads the timeline and, depending on the level, records
  direct work, corrects the thread, or stops the turn outright.
- A `bb orchestrator-mode` command for the same switches from a terminal.

## How it works

Authoritative per-thread state lives in this plugin's own storage, which the
thread's agent cannot write; a mirror of it is written onto the thread's plugin
metadata at every dispatch, because that is the only per-thread input the
synchronous agent-configuration callback can read.

## For agents

The bundled skill tells an agent how to recognize the mode, delegate with
`orchestrator_delegate`, and inspect or change the mode with
`bb orchestrator-mode`.
