# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Extracted from [rad-skill](https://app.radicle.xyz/nodes/seed.radicle.xyz/rad:zvBj4kByGeQSrSy2c4H7fyK42cS8) which contains the original development history.

## [1.6.0] - 2026-05-29

### Added

- `rad_patch_submit` now supports Radicle push options for advanced patch creation:
  - `base` → `git push -o patch.base=<rev>` for patches based on a non-default commit
  - `draft` → `git push -o patch.draft`
  - `branch` → `git push -o patch.branch=<name>`
  - `noSync` → `git push -o no-sync`
- `rad_patch_show` can include diffs via `--patch`.
- Issue tools now support solved/all/assigned list and state workflows where applicable.

### Changed

- Updated the bundled Radicle skill and command reference to match the latest upstream `rad-skill` guidance.
- `rad_patch_list` now uses `rad patch list` for open patches and boolean list flags for filtered states.
- `rad_patch_review` now uses `-m` for review messages, matching current Radicle CLI guidance.

### Fixed

- Corrected Radicle CLI flag documentation for list filters, label/assignment deletion, patch comments, clone paths, and patch base workflows.

## [1.5.0] - 2026-04-16

### Removed

- `rad-experiment-hook` extension — moved to a separate module
- `rad-experiment` skill — moved to a separate module

## [1.4.4] - 2026-04-15

### Fixed

- `/rad-context` autocomplete now correctly displays the `auto [on|off]` option in the command description

## [1.4.1] - 2026-04-14

### Added

- `rad-experiment-hook` extension — bridges pi-autoresearch experiments to Radicle Experiment COBs
- `/rad-context auto [on|off]` command to toggle automatic session capture

### Fixed

- `rad-context` auto-capture now disabled by default
- Trimmed skill descriptions and improved detection/config documentation

## [1.4.0] - 2026-04-10

### Added

- `rad-experiment` skill — support for `cc.experiment` COB type and autoresearch publishing

### Fixed

- `ToolSpec` cleanup and improved `detectTools` fallback logic
- Consistent guards in `rad-issue-loop`

## [1.3.1] - 2026-04-01

### Added

- Extensible `ToolRegistry` replacing the fixed `RadicleCapabilities`

### Fixed

- Updated to pi SDK 0.64.0 using `getApiKeyAndHeaders` API
- Fixed label removal in `rad-issue-loop` (using `--delete` instead of `--remove`)
- Improved label swap reliability and DONE comment verification

## [1.2.1] - 2026-03-25

### Added

- Biased `rad-plan-loop` toward single-task plans for simpler work-flows

### Fixed

- Improved reliability of label swap with retry and cleanup logic
- Resolved various TypeScript errors across extensions

### Changed

- Refactored the repository into a monorepo with layered packages:
  - `@rad-pi/core` for deterministic Radicle agent tooling
  - `@rad-pi/cob` for optional Plan/Context COB integrations
  - `@rad-pi/autonomy` for issue loops, planning loops, orchestration, and workers
- Converted the root `rad-pi` package into an umbrella package that points pi at the layered package-local skills and extensions
- Moved shared helpers, skills, extensions, tests, and agents into package-scoped locations under `packages/`
- Updated cross-package imports to use package names so the split packages can be published independently
- Simplified the top-level README to document the new package architecture
- Dropped the old `rad-experiment` hook from `@rad-pi/cob`; experiment publishing is now handled by the Community Computer `pi-cc` extension

## [1.1.0] - 2026-03-19

### Added

- `rad-issue-loop` extension — autonomous issue processing loop with `/rad-issue-loop`, `/rad-issue-work`, `/rad-issue-skip`, `/rad-issue-check` commands
- `rad-issue-loop` skill — workflow documentation for automated Radicle issue processing
- Model fallback in `rad-context.ts` and `rad-issue-loop.ts` — uses session model when Haiku is unavailable

### Fixed

- TypeScript errors in `rad-issue-loop.ts` (parameter passing, type narrowing, const reassignment, notify type)

## [1.0.0] - 2026-03-09

### Added

- Initial release as a standalone pi package
- Three skills: `radicle`, `rad-plans`, `rad-contexts` (Agent Skills standard)
- `rad-context` extension — Radicle repo detection, automatic Context COB creation on compaction and shutdown, `/rad-context` command
- `rad-orchestrator` extension — multi-agent worktree orchestration via `/rad-orchestrate <plan-id>` with live dashboard, retry, and context feedback
- `rad-worker` agent — single-task execution in isolated worktrees (commit, Context COB, DONE signal)
- `package.json` with `pi-package` manifest for `pi install`
