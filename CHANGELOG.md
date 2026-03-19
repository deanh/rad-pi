# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Extracted from [rad-skill](https://app.radicle.xyz/nodes/seed.radicle.xyz/rad:zvBj4kByGeQSrSy2c4H7fyK42cS8) which contains the original development history.

## [Unreleased]

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
