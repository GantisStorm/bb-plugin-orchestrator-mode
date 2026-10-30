# Changelog

All notable changes to Orchestrator Mode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `bb orchestrator-mode delegate --verify` runs an independent check for a
  waited CLI delegation, including research and review units.
- Move the advisory judge key from BB's settings form to an owner-only file.
  Existing keys migrate automatically; `setup-jev` remains the entry point.
- Ask checkers to list their executed commands outside fenced blocks so the
  privacy filter can recognize the program names without sending arguments.

- `orchestrator_check` (and `bb orchestrator-mode check --worker <id>`) runs an
  independent check a unit is still waiting for. A manual rejection now revises the
  unit *and* checks the revision, so a revised unit can be accepted and used as a
  dependency instead of being refused forever. A check that cannot start, or a
  call cancelled before it starts, leaves the record honestly pending and names
  this command as the way forward.
- `bb orchestrator-mode review` records a worker verdict from the orchestrator's own
  shell, for sessions that lack the `orchestrator_review` tool. It takes no `--thread`
  override, so a worker cannot judge its own output.
- A unit `kind` (`build`, `review`, `research`) picks where the unit runs under a
  `mixed` workspace — a build gets its own worktree, review and research read the
  orchestrator's checkout — and decides whether it is checked. A kind needs no
  stored execution preset; a stored execution for that kind is applied when one
  exists.
- Stalled workers are detected and resumed. A worker that reports no activity for
  five minutes with no recorded progress while `active` receives a continue-message on the same session, up
  to the scope's **Resumes for a stalled worker**, and is reported as stuck when
  that budget is spent. The worker is never respawned, so its side effects cannot
  run twice.
- A rejected or failed-checked build unit — and any unit delegated with
  `verify: true` — is re-delegated with the reviewer's findings, then checked
  again, bounded by the scope's **Revisions per unit**.
  `orchestrator_review accepted` is refused while the stored check verdict is a
  failure, so a pass in a model's report is never treated as a verdict.
- Dependencies gate on outcome, not just status: an errored dependency, a
  rejected review or a failed check stops the dependent unit, a duplicate id is
  refused, and a recorded cycle is refused with the path that closes it.
- Delegation records keep what was asked for next to what BB resolved (provider,
  and the provider session's model when one exists). Reasoning level and service
  tier are reported as not reported instead of echoed from the request.
- The composer status surface is redesigned: one small robot per recent worker in
  that worker's state, real worker counts, a worker ledger with asked and ran
  executions, the durable retention status, and direct work in its own red box
  with a **Clear** action.
- `get_state` and `bb orchestrator-mode status` report worker counts, accepted and
  rejected decisions, effective and unconfirmed executions, the per-thread record
  caps, records already lost to those caps, and retained thread count.

### Changed

- A delegation's full brief is retained (up to the tool's 20,000-character
  limit), because a rejected unit is re-delegated from that record; the old
  400-character copy would have handed a revision a different task.
- The advisory judge is an explicit scope opt-in (`judgeAdvisory`), not merely a
  stored key. The report evidence is reduced to the check's bare verdict token
  and allowlisted program names (`COMMANDS: npm, git`). Arguments, paths, report
  headers, output and quoted source are excluded. The OpenRouter key is sent
  separately for authentication. A report that names
  no allowlisted program is not sent at all, and the request is bounded by what
  is left of the delegation's deadline and by its cancellation.
- A blocked worker's subagent launches are watched. The watchdog reads each
  worker's timeline and sends a correction message when it starts a subagent,
  within the scope's reminder budget. Before this, the rule was only injected.
- `review-heavy` checks every unit: the plugin starts the check unit itself. `verify: false`
  and `waitForResult: false` are refused under it.
- `read-only` is removed from orchestrator subagents. It behaved exactly like `none`, while
  its help promised reading agents that were never allowed. `none` is the default, and a
  stored `read-only` falls back to it.
- The orchestrator contract, the `orchestrator-mode` skill and the tool descriptions now state
  the behaviour the build actually has: dependency gating on a clean settle (`after`), check
  recovery and its two-attempt budget, cancellation and `--no-wait`, the judge as opt-in advice
  that never records a verdict, the kind/workspace checkout rule, and the difference between
  current children and the ledger. The contract grew inside its 4096-character `configure`
  budget by trimming the same text, so the worst-case build — longest model id, every preset,
  five reminders, a project-rules block at the cap — still fits with its tail intact.

### Fixed

- Keep an expired check claim when the 200-row child listing may be incomplete,
  instead of starting a duplicate checker that could already be running.

- One independent check per unit at a time. The check slot is reserved, and the
  claim written, in one serialized mutation before any checker starts, so two
  calls — or a call racing a checker a delegation left running — cannot both
  spawn one. A revision's own check takes that claim before it starts its
  checker, so a recovery call cannot duplicate it in the window where the
  revision already reads as idle. A result is stored only by the checker the
  unit is still bound to, so a stale pass cannot overwrite a newer failure.
- `orchestrator_check` refuses a unit that ended in error, and a chain a later
  revision already settled, instead of checking work that never finished or
  re-rolling a fixed finding. A failing check whose run started before the chain
  was settled does not unsettle it.
- Recovery checks are bounded to two attempts per unit, each charged to the
  turn's delegation budget; a reservation that never becomes a worker refunds
  its attempt. Cancellation after the claim is taken starts no worker.
- A checker that was spawned but could not be written to the ledger keeps its
  claim and is named in the result, instead of running untracked. Its
  process-local parallel reservation is handed back, so one failed write cannot
  spend a slot for the life of the process, while the checker itself stays
  counted against the cap from its own thread status until it settles. Check
  units now settle their record's status and are archived under `archive-checks`
  like any other check.
- Releasing a revision that never started now restores the chain resolution the
  claim cleared, so a cancelled or refused revision no longer leaves a previously
  settled chain permanently unsettled. A prior resolution that *is* the rejected
  record is not restored: an explicit rejection of the attempt that settled the
  chain keeps it unsettled, which is what the rejection means.
- One revision chain spends one budget. The spent count lives on the chain's
  root and is read, checked and incremented in one serialized mutation, so an
  automatic check-driven revision, a later manual rejection of any member and a
  revision of a revision cannot each draw the scope's full allowance. With
  `maxRevisions: 5`, a chain that kept failing used to buy up to 9 revisions and
  repeat `(revision 2)` titles.
- A check verdict is read through ordinary Markdown (`**VERDICT: fail**`,
  `- VERDICT: pass`, `VERDICT: failed`), and a report that leaves no readable
  verdict, states both, produced no text or never started a checker is stored as
  a failure with the reason. Before, those reports parsed as no verdict, so
  `orchestrator_review accepted` was allowed and dependent units started on the
  unit anyway.
- A check's verdict must now be the checker's own: a `VERDICT:` line inside a
  block quote or fenced block — where the worker's report is handed over — is
  the worker's claim and no longer gates acceptance. The checker's verdict must
  also be the only one it states and the last content line of its own report,
  because the verifier brief now quotes the worker's report and asks for exactly
  that. A verdict the checker echoed unquoted, with its own report after it, is
  rejected as untrustworthy instead of being read as a pass. The minimized
  advisory evidence follows the same rule, so a quoted verdict or command name
  is never sent as this check's evidence.
- An expired check claim is no longer attributed to the newest same-titled
  child. Every check unit is spawned with `checkFor` metadata naming the unit it
  inspects, which survives a failed ledger write. If metadata cannot be read,
  the call refuses rather than guessing from a title. Ambiguous or unattributed
  candidates also refuse. Before, one unit's checker could be bound as another's
  evidence when two units shared a title.
- A manual revision brief now carries the rejected attempt's final report, read
  from its thread, instead of telling the revision the previous attempt reported
  nothing. Only the cause of an unreadable report is logged, never its text.
- A cancelled call or a disposing plugin starts no further worker: the initial
  spawn, the check unit, the revision and the fallback retry all refuse once the
  call is aborted. Cancelling during the advisory judge could still spawn a
  revision.
- A unit that asked for an independent check and has none — a call cancelled or a
  plugin disposed before the check started — is refused for acceptance and as a
  dependency instead of reading as a pass. Cancelling while a manual revision
  was being set up hands back both its chain slot and its parallel claim.
- A revision that passes its own check, or that the orchestrator accepts,
  resolves its chain: the original's failed check and recorded rejection stop
  refusing acceptance and dependent units, instead of forcing the orchestrator to
  name the revision id forever. Claiming a new revision clears the resolution.
- A delegation's timeout now bounds the whole call: the worker, its check unit
  and every revision share one deadline. Before, each nested wait got the full
  timeout again, so a 900-second call could block well past its own deadline.
- A revision keeps its parallel-fan-out reservation until its own record is
  written, so a check queued in that window can no longer let the cap be
  exceeded by one. A revision whose worker started but whose record failed is
  reported as that, not as one that never ran.
- The settings page reports the judge key's own state ("Key stored" /
  "No key stored") instead of "Judge on" beside "Advisory judge off" when a key
  is stored but the scope has not opted in.
- `bb orchestrator-mode on --json`, `off --json` and `violations --clear --json`
  report the durable retained-thread count, as `status` already did.
- The contract no longer tells the orchestrator that a failed review or research
  unit is never revised: a unit delegated with `verify: true` is checked and
  revised once, and the text now says so.
- An `>&` output redirect (`echo hi >& out.txt`) is work again. The classifier
  skipped any `>` followed by `&`, so a file could be truncated with no violation;
  descriptor duplication (`>&2`, `2>&1`) still writes no file and stays read-only.
- A failed timeline-head read no longer judges the thread's pre-enable history.
  Enabling marks the thread's cursor as unknown, and the first readable scan
  seeds it and judges nothing, instead of seeding `0` and classifying the past.
- A running worker is no longer mistaken for a settled one. A timed-out or
  errored wait with the worker still `active` is reported as running, started no
  check unit against unfinished work and is never archived; running workers keep
  counting against the parallel cap; and the review gate only asks for verdicts on
  workers that have actually finished.
- Saving the advisory judge key reports a failed write (an over-long key, or a
  refused secret write) instead of leaving an unhandled rejection with the draft
  on screen.
- The checks that guard the advisory judge now send only minimized evidence and
  report refusals, unreachable endpoints and unusable answers as named failures.
- The advisory judge draws on what is left of the delegation's deadline and on
  its cancellation. Before, its request had neither, so a stalled OpenRouter
  endpoint held a call past the timeout it advertised; an expired or cancelled
  call now names that and sends nothing.
- The contract states the scope's own **Revisions per unit** budget instead of
  promising one revision. At `0` it now says no automatic revision runs, and at
  two or more it names the count, instead of contradicting the setting.
- A rejected unit that asked for `verify: true` is revised like a build, keeping
  its kind and its check rule, and a unit outside that rule is told why no
  revision ran instead of being skipped in silence. Before, only a `build` kind
  was revised through `orchestrator_review`, so a checked review or research
  unit was dropped without a word.
- `docs/DESIGN.md` no longer claims a 300-thread eviction that was removed in
  favour of one durable row per thread; it now documents the real per-thread
  record caps and the lost-record counters.
- A `delegate-only` contract's watchdog now refuses shell reads too, matching
  the contract, which runs no shell commands.
- One worker provider that cannot list its models no longer stalls the worker catalog. The
  other providers stay validated, its saved choices are kept, and discovery retries until it
  can list its models.
- A generic tool whose name uses `update`, `set`, `publish` or `archive` as a whole word is
  now judged as work. Before, names like `update_config` or `set_setting` passed unjudged.
  Names that only share letters, such as `get_settings` or `list_archived_threads`, stay reads.
- A `bb thread tell` to a thread in the orchestrator's project created after it counts as
  coordination, so a worker spawned with `bb thread spawn`, which records no parent, is
  covered. A thread in that project created before the orchestrator is still flagged, and so
  is a tell to a thread in another project.
- `curl` and `gh api` count as reads when they only fetch: `curl` with GET or HEAD, `gh api`
  with GET. A flag that sends a body, writes a file or reads a config, and `gh api graphql`,
  stay work. Before, every `curl` and `gh api` call was work, even a plain status check.
- Per-thread state is stored as one row per thread in the plugin's own database instead of a
  single key-value map. The map had one 256 KB ceiling for every thread, so one busy thread
  forced the least recently touched threads out of it and their delegation and violation
  records were lost. Nothing is evicted now, and the existing map is imported once on
  upgrade. `bb orchestrator-mode status` reports retained threads instead of dropped ones.
- The text filters `cut`, `tr`, `sort` and `uniq` count as reads, so
  `bb thread show <id> | head -n 6 | cut -c1-160` is no longer flagged as doing the work
  itself. `sort -o`, `sort --compress-program`, `cut --output` and `uniq IN OUT` still write
  and stay work, as do redirects and `tee`. `sed` and `awk` stay work: a script can write a
  file or run a program in ways no argument table can see.
- The advisory judge's OpenRouter key is a secret plugin setting, stored in an owner-only
  file rather than in the database, and is never returned to the frontend.
- The advisory judge asks Jev on OpenRouter's decisions endpoint with a typed question, the
  way Jev is served. It used to post to `/api/v1/chat/completions` with a model that endpoint
  does not carry, so it could never answer. It sends only minimized structured metadata — the
  check's verdict token and the names of the allowlisted programs it says it ran — never the
  report body, arguments, paths or output, and still never records a verdict.
- The composer strip reports the delegation ledger as the current worker count. Two children in
  the sidebar could read as "21 workers, 20 finished, 1 running" because the numbers came from
  this thread's records. It now shows **children**, read live from BB's own thread tree through
  `threads.list` with `parentThreadId`, `includeHidden` and `archived: false`, paged until a short
  page makes the total exact: `threads.count` takes no `includeHidden`, so its total left every
  hidden child out of the count. A tree that fills every page is probed with one more row — exact
  when none is there, unknown when one is, instead of a count that is silently short. `running` is
  `starting`/`active`/`stopping`. The ledger is labelled as history and never substituted for the
  live count; when BB cannot be read, the count says unknown with the reason. `status` reports both
  lines, and the strip marks the live count with a shape-coded dot (hollow idle, filled running,
  dashed unknown) plus text, so color is never the only signal.
- A check claim now records the checker thread as soon as BB spawns it, written and retried on
  its own so ownership survives a failed ledger write. An expired claim is reconciled against
  BB before another check may start: a checker still running keeps the unit and the call is
  refused, a checker that settled has its real report parsed and stored (fail-closed when it
  left no verdict), and only a run that never produced a worker is released. An unrecorded
  checker can no longer be duplicated after the claim's TTL.
- The advisory judge key is entered through `setup-jev`, stored in an owner-only
  file and never returned in a status response.

## 0.1.4 - 2026-10-18

### Fixed

- Avoid the 30-second startup dependency loop by discovering worker models and
  recovering queues after registration. Preserve saved worker choices until
  discovery succeeds, retry failed reads, and cancel consumers on reload.

### Added

- Add a worker model policy setting — **Per-unit model overrides** in the scope
  editor, `scope --model-policy pinned|flexible` on the CLI. `Flexible` lets a
  delegation pass `model`, `provider` and `reasoning` and keeps the contract's
  "give a hard unit a stronger model" advice. `Pinned` refuses those three and
  says so in the contract, while leaving stored presets reachable.
- Add subagent policies — **Orchestrator subagents** (`read-only` default,
  `all`, `none`; `scope --orchestrator-subagents`) and **Worker subagents**
  (`blocked` default, `allowed`; `scope --worker-subagents`). The watchdog now
  judges identified provider subagents instead of always allowing them. The
  default requires launch-specific read-only provenance, which BB does not yet
  expose; native reading support remains blocked on that upstream metadata.
  Familiar names and cached telemetry grant no trust. Codex coordination stays allowed;
  unrelated task arrays retain normal classification. Legacy opaque OMP calls
  remain unverified work. Every policy is explicit in the contract and grants
  no additional user or parent authority. Blocked workers receive
  an injected rule against starting subagents; BB cannot remove the provider's
  own tool, so it is an instruction rather than enforcement.
- Queue direct child messages while an orchestrator turn is running, using
  BB's persistent queue and delivery when idle. Global/Project settings
  and `scope --child-messages queued|immediate` control the policy. Automatic
  child system notices still use BB's separate delivery path.

### Changed

- Default the worker model policy to `Pinned`, so a delegation can no longer
  upgrade or downgrade a worker on its own. A scope that wants the previous
  behaviour switches to `Flexible`; scopes that never opened the setting now run
  every worker on the stored execution or a stored preset.

### Fixed

- Deliver compatible queued updates from the same child together, preserving
  all content and each child's message order, including interleaved arrivals.
  Recover pending batches on reload and handle concurrent queue changes.
- Preserve the per-turn delegation budget when messages join a running turn
  or wait in the queue; reset it only when a new turn starts.
- Treat a correction sent to a thread this orchestrator owns, including a
  hidden child and a fork, as coordination rather than direct work.

### Contributors

- Thank you [@GantisStorm](https://github.com/GantisStorm) for
  [PR #10](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/10):
  pin worker models to the scope's stored execution, and
  [PR #12](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/12):
  orchestrator and worker subagent policies.
- [@MacHatter1](https://github.com/MacHatter1) contributed queued child
  messages, batched child updates in
  [PR #9](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/9),
  and the startup stall fix in
  [PR #11](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/11).

## 0.1.3 - 2026-10-07

### Fixed

- Remove the draft-text decoration that drew a stray edge inside the composer
  while orchestrator mode was on; the toggle and status banner remain unchanged.

## 0.1.2 - 2026-10-06

### Added

- Per-delegation worker provider, model, reasoning and permission controls,
  with BB's provider/model picker, named execution presets and an optional
  configured retry target.
- Project-scoped settings, worker execution and appended rules, with global
  defaults and explicit inheritance controls.
- Shared, worktree and mixed worker workspaces. Verification workers and
  fallback retries reuse the unit's checkout.
- Recorded worker verdicts through `orchestrator_review` and independent
  verification with `verify: true`.
- Parallel-worker and per-turn delegation caps, worker-retention policies,
  and an inspectable contract with standard, review-heavy and delegate-only
  levels.

### Fixed

- Apply provider/model pins before workers start, with explicit execution
  provenance. Support the native `providerId` alias and CLI `--provider-id`
  and `--providerId` aliases; trim pins and reject blanks, conflicting
  aliases and incompatible provider/model combinations.
- Recognise `bb thread tell`/`message` follow-ups to recorded workers as
  delegation, including literal quoted stdin heredocs, even when read-only
  exploration is disabled.
- Allow literal `2>/dev/null` stderr suppression on read-only commands,
  without allowing output-file redirects or mutating `find` actions.
- Preserve stricter shell classification: writing/execution flags,
  executable substitutions, unsafe wrappers and mixed work chains remain
  work. Git's program-running global options are checked after directory
  and namespace operands, not only before them.
- Share native and CLI worker handling, including project execution,
  caps, verification and retention; preserve delegation in resumed sessions.
- Harden timeline scans against malformed rows, repeated row IDs and
  missing sequence/timing fields. Attribute block-mode intervention to
  the live turn and retain the post-enable grace period.
- Enforce delegation caps and review reminders under concurrency, sanitise
  stored state, and retain workers still owed a verdict within bounded records.
- Keep injected instructions within the 4096-character limit without
  losing the contract tail or supported project-rules append.

### Changed

- Settings resolve through the plugin's Global/Project scope editor rather
  than BB's single-install settings form; unchanged projects inherit defaults.
- Remove the `.github` directory and GitHub Actions workflow. Verification
  remains available through the local test, typecheck and build commands.

### Contributors

- Thank you [@GantisStorm](https://github.com/GantisStorm) for
  [PR #1](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/1):
  worker execution controls, scoped configuration, reviews and verification,
  workspaces, guardrails, and classifier/watchdog hardening.
- [@MacHatter1](https://github.com/MacHatter1) contributed the delegation and
  watchdog usability fixes in
  [PR #4](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/4)
  and release preparation in
  [PR #5](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/5).

## 0.1.1 - 2026-10-05

### Fixed

- Notify running turns when orchestrator mode changes and provide CLI delegation
  for existing or resumed sessions without the native tool.
- Allow read-only `bb provider list` and `bb provider models` commands, including
  chains with `bb status --json`.

## 0.1.0 - 2026-10-01

### Added

- Composer toggle, `+` menu fallback and status strip for orchestrator threads.
- Instructions that limit the orchestrator to reading, planning, asking,
  delegating and reporting, with a tool that creates worker threads.
- `instruct`, `guard` and `block` enforcement levels, configurable read-only
  command handling and a corrective-message cap.
- CLI commands to inspect and change thread mode, clear violations and set the
  default for new threads.
- Repository documentation, a logo using the plugin's delegation icon and an
  MIT licence.

### Changed

- Explain how long-running threads can drift from delegation into direct work,
  and how ongoing watchdog checks help catch that behaviour.

### Fixed

- Read incremental timeline patches and nested work in completed turns so the
  watchdog does not miss direct work.
- Serialize state mutations to retain simultaneous thread choices and worker
  delegation records.
- Count mutating Git command forms and direct image generation as work.
- Share violation clearing between RPC and CLI, and remove unused vendored UI.
- Apply the new-thread default only to qualifying root threads created while
  it is enabled, on a user-initiated dispatch.
- Refresh the metadata mirror from plugin storage before each dispatch.
- Preserve monitoring of state saved by earlier builds.
- Skip historical work and grant grace turns while provider sessions gain the
  orchestrator contract; allow read-only exploration by default.
