# Changelog

All notable changes to Orchestrator Mode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Worker execution control.** A **Worker execution** settings section with a
  switch that opens BB's own provider and model picker, plus matching
  `provider`, `model`, `reasoning` and `permissionMode` arguments on
  `orchestrator_delegate`, so a worker thread can run on a chosen model and
  permission mode instead of inheriting the project default. Picking a provider
  scopes the model list to that provider, and one pick resolves provider, model,
  reasoning level and service tier as a single value — the same value
  `threads.spawn` takes, which is why the choice is stored by the plugin rather
  than as a settings `select` whose options cannot depend on another. Every
  requested field is stamped in `threads.spawn`'s `executionInputSources`,
  without which the server drops it and re-derives the project defaults. A model
  the catalog does not offer is refused with the available ids named.
- The worker execution is a visible `Inherit` / `Custom` pair, so inheriting the
  project's own provider and model is a choice rather than the absence of one.
- A **Retry a failed worker** target: `Report` (the default) hands a failure
  back, `Retry` re-delegates the same brief once on a second provider and model.
  It covers a refused spawn and a worker that lands in `error`, and the retry
  inherits every field the fallback does not name.
- `bb orchestrator-mode worker` shows, sets and clears the stored execution, and
  manages the retry target with `--fallback-provider`, `--fallback-model` and
  `--clear-fallback`. Each flag leaves the rest of the stored configuration
  alone.
- `bb provider list` and `bb provider models` count as read-only commands, so an
  orchestrator can discover valid worker ids.
- `bb orchestrator-mode status` reports the execution delegations default to.
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
