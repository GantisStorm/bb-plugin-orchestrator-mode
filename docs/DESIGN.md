# Orchestrator Mode design notes

## State and dispatch

The plugin's KV store holds authoritative thread state. The synchronous
`bb.agents.configure` callback reads only the thread metadata mirror. Before
each message dispatch, the plugin refreshes that mirror from its own state;
editing the mirror alone does not disable a tracked thread. A mirror refresh
failure logs a warning and allows dispatch to proceed.

State mutations serialize the complete read, update and write operation, so
parallel worker delegations and changes to different threads do not overwrite
one another. RPC and CLI use the same operation to clear violation records
and correction counters.

The new-thread default records when it was enabled. At dispatch it requires a
thread created at or after that moment, a user initiator, no parent, and an
origin other than the side-chat plugin. Existing stored thread choices win.
Configuration never guesses eligibility from a missing mirror.

State is durable per thread: one row in the plugin's own table per thread, with
no shared budget, so no thread's history can push another's out. The arrays are
working records with per-thread ceilings — 100 violations, 50 delegation
records, 500 seen timeline row IDs — and every record a ceiling dropped is
counted in the thread's `lost` counters, which `get_state` and
`bb orchestrator-mode status` report next to the caps. These are working
records, not a permanent audit archive. Deleted threads lose their stored state.

An unreadable timeline head while enabling does not seed the cursor at 0, which
would judge the thread's whole history. The thread is marked `headUnknown`; the
first readable scan seeds the cursor from the live head and judges nothing in
that pass. Until a head can be read, the watchdog enforces nothing.

## Child message queue

`childMessageDelivery` defaults to `queued` and resolves through Global/Project
settings. The dispatch hook returns `wait` for messages from direct children
of an enabled, active orchestrator. It verifies each sender's current parent
through `threads.get`, including every sender in a grouped queue re-attempt.
Groups containing a user, a system notice or an unrelated sender proceed.
Lookup errors fail open, as other dispatch-checkpoint errors do.

BB owns the durable queue, retrying and claims. On queue events, the plugin uses
`queuedMessages.reorder` and `setGroupBoundary` to collect compatible updates
from the leading child into one native group. It preserves each child's order,
including when children are interleaved, and all original row contents. A
per-thread job coalesces concurrent events; dispatch and cancellation prepare
the next leading batch, and startup recovers existing plugin-held rows.

Only direct-child inline rows held by this plugin, without scheduling or failure,
are eligible. User rows, unrelated senders and other waits form boundaries.
Updates from one child with different execution options also form a boundary,
so an earlier incompatible update is never overtaken by that child's later one.
The native boundary setter clears trailing group edges, so the plugin skips
batching when it would split an existing group outside the batch. Its expected
prefix IDs protect against stale claims, deletions and reorders; failures retry
with a fresh queue snapshot up to three times.

The plugin keeps no message copies, delivery timers or queue claims. If an idle
dispatch claims a row before grouping completes, the hook allows one preparatory
wait so the original rows can be requeued and grouped. A persisted wait reason
bounds this extra retry; persistent SDK failures leave the original rows
deliverable individually. Otherwise an idle retry proceeds. Disabling
the mode or choosing `immediate` also releases the hold on recheck. BB's manual
Send-now operation bypasses plugin policy. Only `start-turn` attempts reset the
per-turn delegation budget; waits and `join-turn` attempts retain it.

Automatic child system notices use BB's separate parent-system delivery path,
including when a notice was queued for a pending interaction. That path bypasses
`message.dispatch`, so this policy currently applies to direct child messages.
BB's grouping envelope also requires one sender per group, so reports from
different children remain separate dispatches. Tool results returned by
synchronous delegation are unaffected.

## Session timing and grace turns

Enabling a thread seeds the watchdog's timeline sequence from the existing
head. Older work is not judged. A provider session cannot have its instructions
replaced while it is running, so mode changes send steering messages to active
turns. Idle threads receive session configuration on their next construction.
Some providers retain the original native tool list on resume. The CLI
`bb orchestrator-mode delegate` invokes the same delegation handler and remains
usable in those sessions.

The watchdog therefore grants one grace turn when enabled while idle. When
enabled during an active turn, it grants that turn and one subsequent turn.
These turns advance tracking without being classified as violations. A
session constructed with the contract can begin delegating before the watchdog
starts judging its work.

## Work classification

The classifier in `shared.ts` looks at timeline rows, rather than intercepting
tool calls. Scans consume full rows or incremental `delta.upsertRows` patches
and request nested rows so completed turn summaries still expose their work.
File changes and image generation count as work. Command rows count unless they
delegate through the plugin CLI or the read-only command setting allows them.
Delegation command checks respect quoted briefs and reject executable
substitutions, output redirections and mixed chains that perform direct work.
Worker follow-ups through `bb thread tell`/`message` are delegation only when
the literal target ID is in this parent's retained delegation records, even
when read-only exploration is disabled. The watchdog refreshes that worker
list after reading the timeline so newly recorded workers are included.
Quoted stdin heredocs (including tab-stripping `<<-`) are read as literal
message data; unquoted, unfinished or unsupported heredocs remain work.
Generic tool rows are classified using
their names; this is a heuristic, not a complete description of their effects.

Recognised research includes reads, searches, web fetches, plans and questions.
Native subagent launches resolve through `orchestratorSubagents`. Provider
identity scopes the compatibility adapters: BB 0.46.1's Claude display detail
retains the requested role, and Codex's fixed presentation labels distinguish
launches from waiting, messaging, resuming and closing. Display names never grant
read-only access. BB currently supplies no launch-bound resolved definition,
capabilities or revision. Its context API returns stored usage telemetry, which
can predate a custom override or a session change. Even a cached `built-in`
entry therefore grants no exemption. Native reading support remains blocked
on upstream provenance; all unverified launches stay conservative.
Identified OMP `task` tools carry task arrays, but unrelated tools with the same
argument key retain normal classification. Legacy OMP calls named only `other`
cannot prove tool identity; opaque task-shaped calls remain unverified work
under every policy. These limits avoid guessing permissions from payloads.

Shell read-only checks reject writes through
redirection and mutating command chains. Literal stderr suppression with
`2>/dev/null` (or `2> /dev/null`) is allowed when every command only reads;
other output redirects still count as work. `find` actions that delete,
execute programs, or write result files also count as work, even with errors
suppressed. Consult `isReadOnlyCommand` and its tests for the exact recognised
commands.
Mixed Git subcommands require recognised query forms: listing branches or
tags, inspecting remotes and showing reflogs. Creating or deleting branches
and tags, changing remotes and rewriting reflogs count as work.

In `instruct`, no watchdog classification runs. In `guard`, new violations are
recorded and the thread receives corrective messages up to the nudge cap, with
at most one nudge per offending turn. The review gate draws on the same cap, so
one budget covers both kinds of correction; `status` reports the split. In `block`, the plugin also asks BB to
stop the offending turn, at most once per turn, even after the nudge cap.

Thread events coalesce scans with a 750 ms delay; idle events use 250 ms. These
are scheduling delays, not a guaranteed detection latency. Timeline access,
scan duration and BB's stop handling add time. A write can complete before
the stop request. This plugin is a coordination aid, not a security boundary.

## Worker lifecycle

`orchestrator_delegate` and the `delegate` CLI create a child without passing
the parent's conversation. Shared workers reuse the parent's environment;
worktree workers receive their own checkout. Workers do not inherit the
new-root-thread default.
Optional `provider` (alias `providerId`) and `model` pins (CLI: `--provider`
and `--model`) are trimmed and validated at the input boundary. Conflicting
provider aliases or a model incompatible with a pinned provider are refused.
Execution is passed to `threads.spawn` with explicit provenance, before the
worker's first turn, never through a later update. Omitted fields resolve
through presets, scoped worker settings and BB's defaults. The plugin checks
its provider/model catalog and BB validates availability. A failed spawn
creates no delegation record and is never retried unpinned; a configured
retry target may still apply.

The tool waits by default, reports the settled status and returns up to 12,000
characters of final output. With `waitForResult: false`, it returns the worker
ID immediately. A timeout reports status without stopping the worker. Open or
inspect the worker later to finish reviewing its work.

The full brief (to the tool's 20,000-character limit) is retained in the
parent's delegation record, because a rejected unit is re-delegated from it. A
truncated brief would hand the revision a different task. Hidden workers are
omitted from the sidebar; the delegation result still identifies their thread.

A unit names its `kind` (`build`, `review` or `research`). The kind is a
property of the work, not of a stored execution: under a `mixed` workspace it
picks the checkout (a build gets a worktree; review and research read the
orchestrator's), and a build is checked without being asked. A stored execution
for that kind is applied when one exists; no preset is required for either
behaviour. `preset` remains the explicit way to force a stored execution.

A dependent unit (`after: [...]`) waits for every named dependency to settle
cleanly. The check is on the outcome, not only the status: an errored worker, a
rejected review or a failed check stops the dependent unit before it spawns.
The recorded `after` graph is walked first, so a cycle is refused with the path
that closes it instead of waiting until the deadline.

Every request is recorded next to what BB resolved. `resolved` carries the
thread's provider and, once a provider session exists, the session snapshot's
model. Reasoning level and service tier are exposed nowhere by BB, so they are
null and named in `unreported`; the request is never presented as the fact.

A worker whose `updatedAt` and timeline sequence both stand still for five
minutes while `active` receives a resume message on the same session, up to the
scope's `maxStallResumes`. The resume count lives on the delegation record and is
claimed atomically, so all waiters watching one worker share one budget. The
worker is continued, never replaced, so its side effects cannot run twice. After
the budget it is reported as stuck, and the result says not to delegate the same
unit again.

A delegation may name a stored execution preset, which is applied under the
call's own arguments and over the worker execution. A preset is partial by
design: it only loses the ids the catalog no longer lists, and the provider
follows whichever model the preset names. The `presets` and `fallback` keys are
stripped before anything reaches `threads.spawn`, because they are this plugin's
own bookkeeping rather than spawn fields.

`verify: true` spawns a check unit on the same execution, carrying the original
brief and the worker's claim, and records its thread on the delegation record.
A check unit is evidence for the unit it checks: it is excluded from the review
gate, since judging the checker as well would add ceremony rather than a
decision. Its parsed `VERDICT:` line is stored on the unit, so a later
acceptance cannot pretend it passed. The verdict is read through ordinary
Markdown (`**VERDICT: fail**`, `- VERDICT: pass`, `VERDICT: failed`), and only
from the checker's own text: a `VERDICT:` line inside a block quote or a fenced
block is the report the checker was handed, because the brief embeds the
worker's final text as a quote. The checker's verdict must also be the last
content line of its own report and the only one it states. A report that leaves
no readable verdict, quotes one, states two, states both a pass and a fail, puts
its verdict before further report text, produced no text, was still running at
the deadline, or never started a checker is stored as `rejected` with the reason
in `problem`. Acceptance and dependent units read that record, so unreadable
evidence fails closed instead of reading as a pass, and the reason is returned
to the orchestrator rather than swallowed.

A rejected **build** unit's revision brief carries the previous attempt's own
final text, read from its thread, so the revision knows what was already claimed
and changed; a failed read is logged by its cause only, never the report, and
the brief still states plainly that no report was available.

A failed check on a build unit, or on a unit delegated with `verify: true`,
re-delegates it once (bounded by `maxRevisions`) with the check's report as the
revision brief, on the same execution and checkout, and checks the revision in
turn. A rejected **build** unit, or any unit that asked for `verify: true`, does the
same through `reviseRejected`, using the reviewer's notes; the revision keeps the
unit's kind and its check rule. A rejected unit outside that rule is reported
back with a line saying why it was not revised, so the orchestrator re-delegates
it instead of waiting for a revision that will not come. The contract states the
scope's own `maxRevisions`, including `0`, rather than promising one revision.
The budget belongs to the chain, not to one record: every revision names the
chain's root, the spent count lives on that root, and the read, check and
increment happen inside one serialized mutation. An automatic check-driven
revision, a later manual rejection of any member and a revision of a revision
therefore spend the same allowance, so a capped chain cannot restart at 1, and
concurrent rejections cannot both start a revision. A revision also takes a
parallel slot; its reservation is held until its own record is written, so a
delegation queued in that window cannot pass the cap, and one that cannot start
is reported beside the result and hands its slot back. The plugin never records
an acceptance itself: a pass in a model's report, including the advisory judge's,
is not a verdict, and an `accepted` verdict is refused while the stored check
verdict is a failure.

A chain's outcome is recorded on its root. When a revision's own check passes,
or the orchestrator accepts that revision, the root names it in `resolvedBy`;
the original's failed check and recorded rejection then stop refusing acceptance
and dependent units, because the finding was fixed in that attempt. Claiming a
new revision clears the resolution, and a later check that does not pass leaves
the chain unresolved, so the pointer only ever names the attempt that settled it.
A cancelled call or a disposing plugin starts no further worker, check or
revision: the initial spawn, the check unit, the revision and the fallback retry
all consult the same cancellation check.

Two caps bound a fan-out, counted from this plugin's own records so the refusal
can name which cap it hit. The per-turn count starts at the last dispatch, which
is where a turn begins. A refusal is a distinct error type: the delegation tool
retries a provider failure on the fallback, and a cap is not a provider failure.

One unit has one check slot at a time, and the slot is a durable claim on the
unit's record. The claim names the checker thread as soon as `threads.spawn`
returns, written on its own and retried once, so ownership survives a failed
ledger write. A claim that outlives its TTL (`REVISION_WAIT_MS` plus two minutes)
is reconciled against BB instead of being assumed dead: a checker that is still
running keeps the unit and the call is refused, a checker that has settled has
its real output parsed and stored (fail-closed when it left no verdict), and only
a run that never produced a worker is released. A claim with no recorded thread
id is resolved against the checker's own metadata first: every check unit is
spawned with `checkFor` naming the unit it inspects, and that stamp survives the
ledger write that did not. A same-titled child whose metadata assigns it to
another unit is never adopted. If ownership metadata or the child list cannot
be read, or the 200-row child page is full and might be incomplete, the call
refuses rather than releasing the claim. Multiple matching owners and title-only
matches are also refused.
That is what keeps an
unrecorded checker from being duplicated while it still runs, without ever
inventing a verdict for it or storing one unit's checker as another's evidence.
The failed ledger write also hands back the process-local parallel reservation,
because one write that failed must not spend a slot for the life of the process;
the checker itself stays counted against the cap until BB reports it settled.

## Counts and status

Two numbers the strip and `status` show answer different questions and are never
substituted for each other. **Children** is BB's own thread tree read live through
`threads.list` with `parentThreadId`, `includeHidden` and `archived: false`, paged by
`limit`/`offset`: `threads.count` takes no `includeHidden`, so its total leaves every
hidden child — a worker kept out of the sidebar that still runs — out of the count.
Deleted threads are never listed and archived ones are dropped, so a listed row is a
current child; `starting`, `active` and `stopping` are counted as running.
**The ledger** is this thread's own delegation records, which outlive the threads they
name and are capped at 50.

A short page ends the walk and makes the total exact. A read that fills all three
pages of 200 is probed with one more row: none means the tree ended exactly at
the cap, one means there are more children than the read can see, and the count
is then reported unknown instead of short. The read is cached for two seconds per
thread and concurrent callers share one in-flight read, so a state read per
realtime event does not become a query burst. Any failed page marks the whole
answer unavailable with the reason: a partial count is a number nobody can act
on, and the ledger is never offered as a substitute. The panel draws no field for
it, so a failed or inexact read reads as "Children unknown: BB could not be read"
plus the reason, rather than as zero; `status` names the same limit instead of a
number.

## The review gate

A verdict is recorded by the tool rather than inferred from the timeline. Reads
leave no row, so "did the orchestrator look at this" is unobservable from the
outside; making the verdict an explicit call is what makes it checkable at all.

The gate runs when an orchestrator's turn ends and when a worker settles, and
only nudges a thread that is idle: a message sent mid-turn would queue behind
the work it is asking about. It remembers the set of workers it last reminded
about, so an ignored reminder is not repeated for the same set. A finished turn
cannot be stopped, so `block` behaves as `guard` here; the nudge text says so
rather than implying a stop that did not happen.

A worker that settles while nothing is waiting on it is found by looking its
thread id up in every stored orchestrator's delegations. A delegation made with
`waitForResult: false` settles that way. That lookup also carries the failure text from
`thread.failed` onto the record, so the orchestrator is told why a worker failed
and not only that it did.

## Contract shapes

The contract is emitted, never rewritten. It states which acts the classifier
flags, so a free-form replacement could desync the two and make the watchdog
wrong; the two shape settings swap sections and project rules append one.

`configure` truncates dynamic instructions at 4096 characters, so the budget is
an invariant rather than a hope: the budget test builds the largest contract
every combination of the two can produce — the longest model id the catalog accepts, presets in
every kind, five reminders, an appended section at the cap — and asserts it fits
and that the tail survives. That test is what sets the append cap, and the
render clamps the append as its last resort rather than handing BB a block it
would cut.

## The advisory judge

The judge is off unless the scope sets `judgeAdvisory` and a key is stored.
`bb orchestrator-mode setup-jev` opens the secure key form; the plugin stores the
key in an owner-only file beside BB's data directory and migrates the previous
secret setting on upgrade. The settings panel reports only whether a key exists.
A key alone sends nothing: consent is a separate, explicit scope value. When it
runs, the plugin sends the key to OpenRouter for authentication and asks Jev on
the decisions endpoint with one typed question. The answer is appended as advice;
it never records a verdict, blocks a unit or changes a check.

The evidence is structured metadata, minimized before the request is
built: `minimizeCheckEvidence` keeps the check's bare verdict token —
`VERDICT: pass` or `VERDICT: fail`, never the sentence after it — and the names
of the allowlisted programs the report says it ran, deduplicated
(for example, `COMMANDS: npm, git`). No report argument, path, header value,
file content or output survives, so report credentials cannot be carried:
`curl -u user:pass`, an `Authorization: Basic …` or `Bearer …` header, a dotted
JWT as a header value, a `--password`/`--token` flag. A pattern match cannot
prove a line is safe, and a redacted line still says where a secret was, so the
filter sends a name or nothing — and when no allowlisted program is named,
nothing is sent. Prose, quoted source and anything unrecognised stay local.

The request draws on what is left of the delegation's own deadline and on the
call's cancellation, through an abort signal that also caps the whole request, so
a stalled endpoint cannot hold a call past the timeout it advertised. A refusal,
a non-JSON answer, a missing probability, an unreachable endpoint, an expired
deadline or a cancellation is reported as the failure it was, in the delegation
result, instead of failing silently.
