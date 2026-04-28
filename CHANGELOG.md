# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Extracted from [rad-skill](https://app.radicle.xyz/nodes/seed.radicle.xyz/rad:zvBj4kByGeQSrSy2c4H7fyK42cS8) which contains the original development history.

## [Unreleased]

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
