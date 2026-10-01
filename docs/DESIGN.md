# Orchestrator Mode design notes

## State and dispatch

The plugin's KV store holds authoritative thread state. The synchronous
`bb.agents.configure` callback reads only the thread metadata mirror. Before
each message dispatch, the plugin refreshes that mirror from its own state;
editing the mirror alone does not disable a tracked thread. A mirror refresh
failure logs a warning and allows dispatch to proceed.

The new-thread default records when it was enabled. At dispatch it requires a
thread created at or after that moment, a user initiator, no parent, and an
origin other than the side-chat plugin. Existing stored thread choices win.
Configuration never guesses eligibility from a missing mirror.

State is bounded: the store retains at most 300 threads by last touch time,
100 violations and 50 delegation records per thread, and 500 seen timeline row
IDs per thread. These are working records, not a permanent audit archive.
Deleted threads lose their stored state.

## Session timing and grace turns

Enabling a thread seeds the watchdog's timeline sequence from the existing
head. Older work is not judged. A provider session cannot have its instructions
changed while it is running, and BB may resume an existing session.

The watchdog therefore grants one grace turn when enabled while idle. When
enabled during an active turn, it grants that turn and one subsequent turn.
These turns advance tracking without being classified as violations. A
session constructed with the contract can begin delegating before the watchdog
starts judging its work.

## Work classification

The classifier in `shared.ts` looks at timeline rows, rather than intercepting
tool calls. File-change rows count as work. Command rows count unless the
read-only command setting allows them. Generic tool rows are classified using
their names; this is a heuristic, not a complete description of their effects.

Recognised research includes reads, searches, web fetches, plans and questions.
Delegation rows remain available. Shell read-only checks reject writes through
redirection and mutating command chains; consult `isReadOnlyCommand` and its
tests for the exact recognised commands.

In `instruct`, no watchdog classification runs. In `guard`, new violations are
recorded and the thread receives corrective messages up to the nudge cap, with
at most one nudge per offending turn. In `block`, the plugin also asks BB to
stop the offending turn, at most once per turn, even after the nudge cap.

Thread events coalesce scans with a 750 ms delay; idle events use 250 ms. These
are scheduling delays, not a guaranteed detection latency. Timeline access,
scan duration and BB's stop handling add time. A write can complete before
the stop request. This plugin is a coordination aid, not a security boundary.

## Worker lifecycle

`orchestrator_delegate` creates a child in the parent's environment, without
passing the parent's conversation. Workers do not inherit the new-root-thread
default. Their permissions and execution remain ordinary BB thread behaviour.

The tool waits by default, reports the settled status and returns up to 12,000
characters of final output. With `waitForResult: false`, it returns the worker
ID immediately. A timeout reports status without stopping the worker. Open or
inspect the worker later to finish reviewing its work.

Only the first 400 characters of a delegation brief are retained in the
parent's delegation record. The full brief is sent to the worker. Hidden
workers are omitted from the sidebar; the delegation result still identifies
their thread.
