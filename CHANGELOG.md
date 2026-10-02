# Changelog

All notable changes to Orchestrator Mode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Worker execution control.** `workerProviderId`, `workerModel`,
  `workerReasoningLevel` and `workerPermissionMode` settings, and matching
  `provider`, `model`, `reasoning` and `permissionMode` arguments on
  `orchestrator_delegate`, so each worker thread can run on a chosen model and
  permission mode instead of inheriting the project default. Provider and model
  options are read from `bb.sdk.providers` — the same catalog the new-thread
  composer's pickers use — and every requested field is stamped in
  `threads.spawn`'s `executionInputSources`, without which the server drops it.
  A model the catalog does not offer is refused with the available ids named.
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
