---
name: orchestrator-mode
description: "Use when a thread is in orchestrator mode and must delegate every unit of work instead of doing it, or when the user asks to turn orchestrator mode on or off, check what direct work a thread did, or change how new threads start. Covers the composer toggle and the `bb orchestrator-mode` CLI."
---

# Orchestrator mode

Orchestrator mode is a per-thread switch. While it is on, that thread does not
do the work. It reads, plans, asks, delegates and reports, and every unit of
actual work goes to a worker thread.

## Recognise it

The composer shows a delegation icon, which BB may group under More plugin
actions. While the mode is on, a strip above the input names the enforcement
level, the current child threads BB reports, the delegation ledger and any
direct work already caught. The thread's own instructions carry the full
contract, so if you are reading an "# ORCHESTRATOR MODE IS ON" block, the
mode is on for you.

Two of those numbers answer different questions. **Children** is read from BB
right now: direct child threads that are not archived or deleted, hidden ones
included because they still run. **The ledger** is what this thread recorded;
it outlives the threads it names. Never report the ledger as the live count, and
when BB cannot be read the strip and `status` say the count is unknown instead
of substituting a record total.

## Commands

```
bb orchestrator-mode status [--thread <id>] [--json]
bb orchestrator-mode delegate --task <brief> [--title <title>] [--kind build|review|research] [--workspace shared|worktree] [--provider <id>] [--model <id>] [--verify] [--no-wait] [--timeout <seconds>] [--hidden] [--thread <id>] [--json]
bb orchestrator-mode on [--thread <id>] [--enforcement instruct|guard|block] [--json]
bb orchestrator-mode off [--thread <id>] [--json]
bb orchestrator-mode violations [--thread <id>] [--clear] [--json]
bb orchestrator-mode default [on|off] [--json]
bb orchestrator-mode worker [--provider <id>] [--model <id>] [--preset <name>] [--json]
bb orchestrator-mode contract [--thread <id>] [--rules <text>] [--clear-rules] [--json]
bb orchestrator-mode scope [--project <id>] [--max-parallel <n>] [--inherit <key>] [--inherit-all] [--json]
bb orchestrator-mode scope --global|--project <id> [--child-messages queued|immediate] [--json]
bb orchestrator-mode scope --global|--project <id> [--orchestrator-subagents none|all] [--worker-subagents blocked|allowed]
bb orchestrator-mode scope --global|--project <id> [--max-revisions <n>] [--max-stall-resumes <n>] [--judge-advisory on|off]
bb orchestrator-mode setup-jev
```

`--thread` defaults to the thread running the command, so an agent can inspect
or change its own mode. Running turns receive a message when the mode changes.
Session configuration is refreshed when the provider session is next
constructed, but resuming may retain its original tool list.

Direct messages from child threads queue by default until the orchestrator's
current turn ends. BB retains their content and sender. Compatible queued
updates from one child arrive together, preserving every update and its order.
Interleaved children are batched in order of their first pending update. Matching
execution settings are required; user messages, other waits and existing groups
can prevent batching across a boundary. BB requires one sender per queued group,
so reports from different children remain separate dispatches. Send now overrides the hold. The
`childMessageDelivery` scope setting selects `queued` or `immediate`; use
`--inherit childMessageDelivery` to clear a project's override. User messages,
unrelated senders and idle orchestrators proceed immediately. Automatic child
completion/failure/attention notices use BB's separate system delivery path
and cannot be held by this plugin; waiting delegation tool results also return
directly. Finish the current turn after delegating async work so queued child
messages can reach you.

## Enforcement levels

- `instruct` writes the rules into every turn and checks nothing.
- `guard` (the default) writes the rules and warns the orchestrator when it does
  work itself or leaves a worker unjudged.
- `block` writes the rules too and stops the turn as soon as the orchestrator
  does work itself, though a fast write can still land first.

The watchdog grants grace turns while provider sessions gain the contract: one
when enabled while idle, or the active turn and the next one when enabled
mid-turn. Historical work is not judged. Follow the contract whenever your
session receives it, including during grace turns.

The new-thread default only reaches qualifying root threads created while it is
on, at a user-initiated dispatch. Existing threads, child workers and side chats
are left alone.

Read-only shell commands (`ls`, `cat`, `rg`, `git status`, `git diff`,
`git log`, `find`, `wc`, `bb status`, `bb provider list`, `bb provider models`)
do not count as work while "Let the orchestrator read with shell commands" is
on and the contract is not `delegate-only`. Chained commands are allowed when
every segment is read-only. Literal stderr suppression (`2>/dev/null` or
`2> /dev/null`) is allowed, including on chained `find` queries. Other
output redirects and mutating `find` actions (`-delete`, `-exec`, `-fprint`)
still count as work. Creating images counts as work and must be
delegated; inspecting images is allowed. Git commands that create or delete
branches or tags, change remotes, or rewrite reflogs also count as work.

Your provider's own subagents follow the scope's **Orchestrator subagents**
policy. Under the default `none`, every launch counts as work, reading agents
included: BB exposes no launch-bound proof that a native subagent only reads, so
none can be exempted. `all` allows identified subagents, including editing ones,
within existing user and parent authority. Codex coordination (waiting, messaging,
resuming or closing) is allowed under every policy. An OMP tool whose identity was
erased to `other` cannot establish a subagent exemption. Delegate unverified units
with `orchestrator_delegate` instead.

## Delegating

Use the `orchestrator_delegate` tool, which the mode selects for the thread.
If it is unavailable, use `bb orchestrator-mode delegate --task 'complete brief'`.
The CLI runs the same worker creation, recording and result handling. It is
allowed even when read-only shell exploration is disabled. Quote the brief
safely; `--no-wait` lets you start independent workers without waiting.
Give it a complete, self-contained brief: the worker cannot see this
conversation. Fan out independent units; sequence only real dependencies.

Arguments are `task` (required, at most 20,000 characters), `title` (optional,
at most 200), `kind` (optional: `build`, `review` or `research`), `workspace`
(optional, `shared` or `worktree`, required under a `mixed` scope unless a kind
supplies it), `after` (optional worker ids this unit waits for), `waitForResult`
(default `true`), `timeoutSeconds` (default `900`, integer range 10 to 3,600),
`hidden` (default `false`), `preset` (optional, forces a stored execution),
`verify` (default `false`, adds the check unit described below) and `provider`
(alias `providerId`), `model`, `reasoning`, `permissionMode` for this one unit.
With `waitForResult: false` the worker keeps running: inspect it later and
review its result; its check then waits for `orchestrator_check`.

`after` gates on outcome, not on being spawned: a dependent unit starts only
once every named dependency has settled cleanly — idle, not errored, and not
rejected by its own check or review. A duplicate id, an unknown id or a
dependency cycle is refused with the reason. A cancelled call starts no worker,
and a brief that is already running is never respawned by a cancellation.

A `kind` is a property of the work, not of a stored preset. Under a `mixed`
workspace a build gets its own worktree while a review or research unit reads
your checkout; a build is also checked without asking. A stored execution for
that kind is applied when one exists. A `preset` that is not stored is still
refused rather than ignored.

A worker that records no progress for five minutes while active is resumed on the
same session, up to the scope's resume budget, rather than replaced. If the
budget is spent you are told it is stuck: do not delegate the same unit again
while it may still finish. Each worker record keeps the execution that was asked
for next to the one BB resolved.

Optional `provider` (alias `providerId`, 1–120 characters) and `model`
(1–200) are trimmed; blank pins are rejected. If both provider names are
supplied, they must match. Provider pins are never silently retargeted: name a
model that the pinned provider serves. The CLI equivalents are `--provider`
(aliases `--provider-id` and `--providerId`) and `--model`. Pins take effect
before the first turn and do not require disabling orchestrator mode. Failed
spawns are not retried with unpinned workers; an explicitly configured retry
target still applies.

A resumed session may retain an older native tool schema without the pin
arguments. Use the CLI with `--provider` and `--model` rather than unpinned
delegation in that case.

### Following up with a worker

`bb thread tell <worker-id> ...` (alias `message`) counts as delegation when
the target is in this orchestrator's retained delegation records. It remains
allowed when read-only shell exploration is disabled. Literal quoted messages
and `--message-file <path>` can carry the follow-up. For stdin, use a quoted
heredoc delimiter so the shell cannot execute substitutions in the message:

```sh
bb thread tell <worker-id> --model <model-id> --mode steer --message-file - <<'FOLLOWUP'
Review the implementation and add the missing tests in your worker thread.
FOLLOWUP
```

Unknown/unrecorded targets (including the orchestrator itself), unquoted
heredocs, command substitutions outside literal message data, file-output
redirects and mixed chains doing local work are not delegation. Each worker
in a chained follow-up must be recorded. At most 50 worker records are kept in
the ledger; a record dropped at that cap is counted in the thread's `lost`
totals rather than disappearing silently.

## Recording a verdict

Every worker whose result you used needs a verdict before you finish the turn.
Call `orchestrator_review` with the worker's thread id, `accepted` or `rejected`,
and a line of notes. A turn that ends with unjudged workers gets one reminder. A
rejected result is re-delegated, never patched by you. Name what is wrong in the
notes: on a rejected `build` unit they become the revision brief, and the plugin
re-delegates that unit once inside the scope's revision budget.

An `accepted` verdict is refused while the unit's stored check verdict is a
failure, and a dependent unit will not start on it. A check report with no
readable `VERDICT:` line — or one that states both a pass and a fail, states more
than one verdict, or puts its verdict before further report text — is recorded
as a failure with the reason, so silence never counts as a pass. A `VERDICT:`
line inside a block quote or a fenced block is the worker's claim, not the
checker's: the checker's own verdict has to be the last line of its report.

Every revision of one unit shares one budget: rejecting the original after an
automatic revision, or rejecting a revision, does not buy a fresh allowance. A
revision whose own check passes settles the chain, so the original can then be
accepted and used as a dependency; do not delegate the same unit again.

If `orchestrator_review` is not among this session's tools, run
`bb orchestrator-mode review --worker <id> --verdict accepted|rejected --notes "..."`
from your own shell. It records the same verdict. It takes no `--thread`, so only the
orchestrator thread can judge its workers.

A unit that asked for a check and has none is **pending**, not passed: accepting it
is refused and dependent units will not start on it. That happens when a call was
cancelled before the check started, or a check unit could not spawn. Call
`orchestrator_check` with that worker's thread id to run the check now (or
`bb orchestrator-mode check --worker <id>` without the tool); a pass stores the
verdict and settles the chain, a failure is reported like any other. Do not
re-delegate the same unit to work around a pending check. Only one check runs per
unit at a time, and recovery is bounded: two attempts per unit, each counting
against the turn's delegation budget. A unit that ended in error, or a chain a
later revision already settled, is refused rather than re-checked.

A check claim names the checker thread as soon as BB spawns it, so a claim that
outlives its deadline is reconciled, never silently discarded: a checker that is
still running keeps the unit and the call is refused, a checker that settled has
its result recorded from what it actually reported (fail-closed when it left no
verdict), and a run that never spawned a worker is released. An unrecorded
checker is found by the `checkFor` metadata it was spawned with. If that
metadata cannot be read, the call refuses rather than guessing from a title.
Multiple matching owners or a title-only match whose metadata names no unit
also refuse, so one unit's checker can never
become another's evidence. That is what makes a second check behind a live one
impossible, including when the ledger write that would have recorded the checker
failed, and why such a checker still counts against the parallel cap while it
runs.

`verify: true` on a delegation spawns an independent check unit that inspects the
repository and reports `VERDICT: pass` or `VERDICT: fail`. Its report comes back
with the worker's, and its thread is recorded as that delegation's evidence. Use
it when you cannot judge a unit from its report alone.

Under a `review-heavy` scope every unit gets a check unit, so `verify: false` and
`waitForResult: false` are refused there.

## Choosing the worker's execution

Workers run on the provider, model and access the settings section's worker rows
name, falling back to this project's remembered defaults. The scope is pinned by
default, so a delegation must not pass `provider`, `model` or `reasoning`: every
worker runs on what the settings say. Only when the user switches the scope to
`flexible` do those three work, and then a hard unit may take a stronger model
and a mechanical one a cheaper one. A refusal names the policy; re-delegate
without the argument rather than asking for it again.

`kind` names what the unit is, and the plugin applies that kind's stored
execution when the scope has saved one. It needs no preset, so a scope with no
presets still gets the checkout and the check its kind implies. `preset` is the
explicit way to force a stored execution; one that is not stored is refused
rather than ignored. Under `flexible` your own arguments beat either; under the
default `pinned` a kind's stored execution is how a unit gets a different
execution, because raw `model`, `provider` and `reasoning` are refused. Naming a
kind also titles the child `BUILD:`, `REVIEW:` or `RESEARCH:`, so the sidebar
shows what it is doing.

`workspace` picks where the unit runs. `shared` (the default) uses the checkout
you are in, so its edits are visible to you immediately. `worktree` gives the
unit its own worktree and branch; nothing it writes lands in your checkout, the
result names the branch, and the user merges it. Ask for `worktree` when two units
would touch the same files, or when a unit should not disturb the working tree.

Under a `mixed` scope every delegation has to name one. To land a worktree unit,
delegate the merge as its own unit with `workspace: "shared"`, naming the branch
to bring in; merging by hand counts as doing the work yourself.

When the plugin has a retry target configured, it re-delegates a failed worker
once on that provider and model before you hear about the failure, so do not
re-run a failed unit by hand.

Valid ids come from `bb provider list` and `bb provider models <provider>`, both
read-only. A model the catalog does not offer is refused with the available ids
named, so pass a model you have seen there rather than guessing.

Two caps can refuse a delegation: workers running at once, and workers per turn.
The refusal names the cap, and it is not a provider failure, so re-delegating
through the retry target will not help. Fold what came back into a report
instead.

The default corrective-message cap is three per enablement. Recording and
block-mode stops continue after the cap. Clearing violations or disabling the
thread resets correction counters.

## Advisory judge

The advisory judge is off unless the scope opts in with **Advisory judge**
(on `judgeAdvisory`). Its OpenRouter key is stored once, as a secret, and never
shown again; the plugin holds no second copy and never returns the value.
Run `bb orchestrator-mode setup-jev` to open a secure BB prompt with a masked
field and explicit Save/Cancel. The plugin stores the key in an owner-only file.
Run that command only when the user asks to set up or replace the key, and never
ask them to paste it into chat, a shell argument, a file or a log: the prompt is
the only place it is typed. A key alone sends nothing: the opt-in must also be
on.

When both are on, a check's report gets a second opinion from Jev that is
appended as advice. It never records a verdict, blocks a unit or stops a turn.
The evidence contains only the check's bare verdict token and the names of the
allowlisted programs its report says it ran (`COMMANDS: npm, git`), not report
arguments, paths, headers, quoted source or output. The OpenRouter key is sent for
authentication. A report that names no allowlisted program is not sent at all,
and a failed call is reported as a
failure rather than a silent pass.

Do not try to turn the mode off yourself or work around it. If the work genuinely
cannot be delegated, say so and stop, and ask the user to turn the mode off in
the composer.
