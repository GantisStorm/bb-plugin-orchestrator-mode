# Changelog

All notable changes to Orchestrator Mode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

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

- Apply the new-thread default only to qualifying root threads created while
  it is enabled, on a user-initiated dispatch.
- Refresh the metadata mirror from plugin storage before each dispatch.
- Preserve monitoring of state saved by earlier builds.
- Skip historical work and grant grace turns while provider sessions gain the
  orchestrator contract; allow read-only exploration by default.
