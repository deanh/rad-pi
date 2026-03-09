# rad-pi

A [pi](https://github.com/badlogic/pi-mono) package for working with [Radicle](https://radicle.xyz) — a peer-to-peer code collaboration protocol. Provides skills, extensions, and an agent for Radicle workflows including Plan COBs, Context COBs, and multi-agent worktree orchestration.

## Install

Global (all projects):

```bash
pi install npm:rad-pi
```

Per-project (shared with your team via `.pi/settings.json`):

```bash
pi install -l npm:rad-pi
```

Try without installing:

```bash
pi -e npm:rad-pi
```

Also available via git:

```bash
pi install git:seed.radicle.garden/zSM6rc7C18JjDxn4tj1r7PuP9QHc.git
pi install https://github.com/deanh/rad-pi
```

## Requirements

- [Radicle](https://radicle.xyz/install) installed and configured (`rad auth`)
- Radicle node running for network operations (`rad node start`)
- Optional: [`rad-plan`](#install-rad-plan) CLI for Plan COB support
- Optional: [`rad-context`](#install-rad-context) CLI for Context COB support

All COB features gracefully degrade when their CLIs are not installed.

## What's Included

### Skills

Three knowledge skills following the [Agent Skills](https://agentskills.io) standard:

| Skill | Description |
|-------|-------------|
| **radicle** | Core `rad` CLI operations — init, clone, patch, issue, sync, node management |
| **rad-plans** | Plan COBs (`me.hdh.plan`), `rad-plan` CLI, and interactive plan management |
| **rad-contexts** | Context COBs (`me.hdh.context`) and `rad-context` CLI |

### Extensions

| Extension | Description |
|-----------|-------------|
| **rad-context** | Detects Radicle repos at session start, auto-creates Context COBs on compaction and shutdown, provides `/rad-context` command |
| **rad-orchestrator** | Multi-agent worktree orchestration via `/rad-orchestrate <plan-id>` |

### Agent

| Agent | Description |
|-------|-------------|
| **rad-worker** | Executes a single Plan COB task in an isolated worktree — produces one commit and one Context COB, then signals completion |

## Commands

### `/rad-context [list | show <id> | create]`

Manage Context COBs:

- **list** — show all contexts in the repo (default)
- **show \<id\>** — display a specific context
- **create** — trigger LLM reflection to create a context from the current session

Context COBs are also created automatically:
- On **compaction** — when the context window fills, the extension extracts observations from the compacted portion
- On **shutdown** — if no context was created during the session, one is extracted from the full conversation

### `/rad-orchestrate <plan-id>`

Orchestrate multi-agent execution of a Plan COB across git worktrees:

1. Analyzes the plan and identifies ready tasks (unblocked, no file conflicts)
2. Creates isolated worktrees and spawns worker agents (up to 4 concurrent)
3. Workers claim tasks, implement changes, commit, create Context COBs, and signal completion
4. Orchestrator cherry-picks completed commits into a plan branch
5. Repeats until all tasks are complete, then creates a single Radicle patch

Features:
- Live dashboard showing worker progress, turns, and activity
- Retry failed workers interactively
- Context feedback from completed workers informs subsequent batches
- File conflict detection prevents parallel workers from touching the same files

## Context COBs

Context COBs (`me.hdh.context`) capture what an agent learned during a coding session — approach, constraints, friction, learnings, and open items. They're durable records stored in Radicle that replicate across the network.

The rad-context extension hooks into pi's lifecycle:

1. When compaction triggers, the extension stashes the serialized conversation
2. After compaction completes, a side-channel LLM call extracts structured observations
3. The Context COB is created via `rad-context create --json`
4. Commits from the session are linked, and the COB is announced to the network

At shutdown, if no context was created during the session, the same extraction runs on the full conversation.

### Install rad-context

```bash
rad clone rad:z2qBBbhVCfMiFEWN55oXKTPmKkrwY
cd radicle-context-cob
cargo install --path .
rad-context --version
```

## Plan COBs

Plan COBs (`me.hdh.plan`) store implementation plans as first-class Radicle objects. They track tasks with status, estimates, affected files, and dependencies, and link bidirectionally to issues and patches.

### Install rad-plan

```bash
rad clone rad:z4L8L9ctRYn2bcPuUT4GRz7sggG1v
cd radicle-plan-cob
cargo install --path .
rad-plan --version
```

## Provenance

Extracted from [rad-skill](https://app.radicle.xyz/nodes/seed.radicle.xyz/rad:zvBj4kByGeQSrSy2c4H7fyK42cS8) which contains the original development history. The Claude Code plugin remains in that repository.

**Radicle:** `rad:zSM6rc7C18JjDxn4tj1r7PuP9QHc`
**GitHub mirror:** https://github.com/deanh/rad-pi

## License

MIT
