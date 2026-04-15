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
- Optional: [`rad-experiment`](https://app.radicle.xyz/nodes/seed.radicle.xyz/rad:z3trgPnc9KqoFHpZj8KD9s7iX7nwX) CLI for Experiment COB support

All COB features gracefully degrade when their CLIs are not installed.

## What's Included

### Skills

Five knowledge skills following the [Agent Skills](https://agentskills.io) standard:

| Skill | Description |
|-------|-------------|
| **radicle** | Core `rad` CLI operations — init, clone, patch, issue, sync, node management |
| **rad-plans** | Plan COBs (`me.hdh.plan`), `rad-plan` CLI, and interactive plan management |
| **rad-contexts** | Context COBs (`me.hdh.context`) and `rad-context` CLI |
| **rad-experiment** | Experiment COBs (`cc.experiment`), `rad-experiment` CLI, and autoresearch publishing |
| **rad-issue-loop** | Autonomous issue processing loop — check issues, work them, create contexts, submit patches |

### Extensions

| Extension | Description |
|-----------|-------------|
| **rad-context** | Detects Radicle repos at session start, auto-creates Context COBs on compaction and shutdown, provides `/rad-context` command |
| **rad-plan-loop** | Watches for labeled issues and creates Plan COBs via `/rad-plan-loop` |
| **rad-orchestrator** | Multi-agent worktree orchestration via `/rad-orchestrate` and `/rad-orchestrate-loop` |
| **rad-issue-loop** | Autonomous issue processing loop via `/rad-issue-loop` |

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

### `/rad-orchestrate-loop [options]`

Poll for approved plans and orchestrate their execution automatically:

```
/rad-orchestrate-loop            # Poll every 30s for approved plans
/rad-orchestrate-loop --oneshot  # Execute one approved plan then stop
/rad-orchestrate-loop --cooldown 60000  # Custom poll interval (ms)
/rad-orchestrate-loop --status   # Show loop status
/rad-orchestrate-loop --stop     # Stop a running loop
```

### `/rad-plan-loop [options]`

Watch for labeled issues and create Plan COBs:

```
/rad-plan-loop                   # Watch for issues labeled "TODO"
/rad-plan-loop --oneshot         # Process one issue then stop
/rad-plan-loop --auto-approve    # Skip manual plan review
/rad-plan-loop --plan-label X    # Custom label to watch (default: TODO)
/rad-plan-loop --planned-label X # Label applied after planning (default: ready)
/rad-plan-loop --status          # Show loop status
/rad-plan-loop --stop            # Stop a running loop
```

### `/rad-plan-check`

Check for issues ready for planning and list approved plans.

### Issue Loop Commands

#### `/rad-issue-loop [options]`

Run autonomous issue processing loop:

```
/rad-issue-loop              # Interactive mode (prompts for issue selection)
/rad-issue-loop --auto       # Autonomous mode (selects first eligible issue)
/rad-issue-loop --oneshot    # Process one issue then stop
/rad-issue-loop --labels bug,feature  # Filter issues by labels
/rad-issue-loop --status     # Show loop status
/rad-issue-loop --stop       # Stop a running loop
```

The loop:
1. **Sync** with network
2. **Check** for open issues
3. **Select** an eligible issue (open, no existing patch, matches labels)
4. **Work** the issue (creates branch, injects work prompt)
5. After completion, use `/rad-issue-work` to commit, create context, and push patch
6. **Repeat** from step 1

#### `/rad-issue-work [issue-id]`

Complete the current issue work:

- Commits any pending changes
- Creates a Context COB with session observations
- Pushes a Radicle patch
- Links patch to issue
- Returns to main branch

If `issue-id` is omitted, detects from the current branch name (`issue-*`).

#### `/rad-issue-skip`

Skip the current issue work and return to main branch.

#### `/rad-issue-check`

Check for new issues, patches, and contexts (syncs first).

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
