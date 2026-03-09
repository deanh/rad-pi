---
name: rad-plans
description: Knowledge about Radicle Plan COBs (me.hdh.plan) - a custom Collaborative Object type for storing implementation plans in Radicle repositories. Use when working with rad-plan, plan COBs, or implementation planning in Radicle.
---

# Radicle Plan COB Skill

This skill provides knowledge about Plan COBs (`me.hdh.plan`) - a custom Collaborative Object type for storing implementation plans in Radicle repositories.

## What are Plan COBs?

Plan COBs are first-class collaborative objects that store implementation plans within Radicle repositories. They enable:

- **Persisted planning**: Save plan mode exploration as sharable, versioned plans
- **Task tracking**: Track tasks within plans with estimates, dependencies, and commit-based completion
- **Bidirectional linking**: Link plans to Issues and Patches
- **Network sync**: Plans replicate across the Radicle network like Issues and Patches
- **CRDT semantics**: Conflict-free collaboration on plan updates

## Type Name

```
me.hdh.plan
```

Plans are stored under `refs/cobs/me.hdh.plan/<PLAN-ID>` in the Git repository.

## Plan Structure

A Plan COB contains:

| Field | Description |
|-------|-------------|
| `title` | Plan title |
| `description` | Detailed plan description |
| `status` | Draft, Approved, InProgress, Completed, Archived |
| `tasks[]` | List of tasks with subject, description, estimate, affectedFiles, linkedCommit |
| `related_issues[]` | Linked Radicle issue IDs |
| `related_patches[]` | Linked Radicle patch IDs |
| `critical_files[]` | Files the plan will modify |
| `labels[]` | Plan labels |
| `assignees[]` | Assigned DIDs |
| `discussion` | Thread for comments |

## Task Structure

Each task within a plan:

| Field | Description |
|-------|-------------|
| `id` | Unique task identifier |
| `subject` | Task title |
| `description` | Optional detailed description |
| `estimate` | Time estimate (e.g., "2h", "1d") |
| `affectedFiles[]` | Files this task modifies |
| `linkedCommit` | Commit OID that completes this task (null if not done) |
| `blocked_by[]` | IDs of blocking tasks |
| `linked_issue` | If converted to a Radicle issue |

A task is **done** when `linkedCommit` is present. There is no mutable status field.

## CLI Commands

All commands accept **short-form IDs** (minimum 7 hex characters) for plans, tasks, issues, patches, and commits. Ambiguous prefixes produce a clear error.

### rad-plan open

Create a new plan:

```bash
rad-plan open "Plan title" --description "Description"
```

### rad-plan list

List all plans:

```bash
rad-plan list
rad-plan list --status in-progress
rad-plan list --all  # Include archived
```

### rad-plan show

Show plan details:

```bash
rad-plan show <plan-id>
rad-plan show <plan-id> --json
```

### rad-plan task add

Add a task:

```bash
rad-plan task add <plan-id> "Task subject" \
  --description "Details" \
  --estimate "4h" \
  --files "src/auth.ts,src/middleware.ts"
```

### rad-plan task edit

Edit a task's details:

```bash
rad-plan task edit <plan-id> <task-id> --subject "Updated title"
rad-plan task edit <plan-id> <task-id> --description "New details"
rad-plan task edit <plan-id> <task-id> --estimate "6h"
rad-plan task edit <plan-id> <task-id> --files "src/client.rs,src/config.rs"
```

All flags are optional. Only provided fields are updated.

### rad-plan task link-commit

Link a task to its implementing commit (marks it done):

```bash
rad-plan task link-commit <plan-id> <task-id> --commit <commit-oid>
```

### rad-plan task list

List tasks in a plan:

```bash
rad-plan task list <plan-id>
```

### rad-plan task remove

Remove a task from a plan:

```bash
rad-plan task remove <plan-id> <task-id>
```

### rad-plan task link

Link a task to a Radicle issue:

```bash
rad-plan task link <plan-id> <task-id> --issue <issue-id>
```

### rad-plan edit

Edit plan title or description:

```bash
rad-plan edit <plan-id> --title "New title"
rad-plan edit <plan-id> --description "New description"
```

### rad-plan comment

Add a comment to a plan's discussion thread:

```bash
rad-plan comment <plan-id> "Comment text"
rad-plan comment <plan-id> "Reply text" --reply-to <comment-id>
```

### rad-plan link

Link to issues/patches:

```bash
rad-plan link <plan-id> --issue <issue-id>
rad-plan link <plan-id> --patch <patch-id>
```

### rad-plan export

Export plan:

```bash
rad-plan export <plan-id> --format md
rad-plan export <plan-id> --format json
```

## Interactive Plan Management

These patterns let Claude handle ad-hoc plan operations via the `rad-plan` CLI. All commands accept **short-form IDs** (minimum 7 hex characters).

### Creating a Plan Interactively

1. Gather details via `AskUserQuestion`: title, description, labels (optional), initial tasks (optional), linked issue (optional)
2. Create the Plan COB:
```bash
rad-plan open "<title>" --description "<description>" --labels "<labels>"
```
3. Add tasks if provided:
```bash
rad-plan task add <plan-id> "<task-subject>" \
  --description "<description>" \
  --estimate "<time-estimate>" \
  --files "<file1>,<file2>"
```
4. Link to issue if specified:
```bash
rad-plan link <plan-id> --issue <issue-id>
```
5. Announce to network:
```bash
rad sync --announce
```

### Editing a Plan

```bash
rad-plan edit <plan-id> --title "New title"
rad-plan edit <plan-id> --description "Updated description"
rad-plan edit <plan-id> --title "New title" --description "Updated description"
```

### Exporting a Plan

```bash
rad-plan export abc1234 --format md
rad-plan export abc1234 --format json
rad-plan export abc1234 --format md --output plan.md
```

### Changing Plan Status

```bash
rad-plan status <plan-id> draft
rad-plan status <plan-id> approved
rad-plan status <plan-id> in-progress
rad-plan status <plan-id> completed
rad-plan status <plan-id> archived
```

### Plan Comments

```bash
rad-plan comment <plan-id> "Implementation note"
rad-plan comment <plan-id> "Reply to comment" --reply-to <comment-id>
```

## Claude Code Integration

### Creating Plans from Plan Mode

After completing plan mode exploration, save as a Plan COB. The `/rad-import` command offers this interactively after task creation. The plan-manager agent handles the creation process.

### Task Metadata

Claude Code tasks created from plans include:

```json
{
  "radicle_plan_id": "abc123...",
  "radicle_plan_task_id": "task-id...",
  "radicle_issue_id": "def456...",
  "source": "radicle"
}
```

### Syncing Completion

Use `/rad-sync` to synchronize:

- Claude Code task completion → Plan COB task via `task link-commit`
- Plan status auto-updates when all tasks have `linkedCommit`

## Workflow Example

### 1. Import Issue with Plan

```
/rad-import abc123
```

After task creation, `/rad-import` offers to save as a Plan COB. This:
- Fetches issue details
- Enters plan mode to design implementation
- Creates Claude Code tasks
- Optionally creates Plan COB with tasks and links to issue

### 2. Work on Tasks

Complete tasks normally. Claude Code tracks progress locally.

### 3. Sync Progress

```
/rad-sync
```

This links commits to Plan COB tasks, marking them done.

### 4. Close Issue

When all tasks have `linkedCommit`:
- Plan status → Completed
- `/rad-sync` marks issue as solved

## Authorization

| Action | Who Can Do It |
|--------|--------------|
| Create plan | Any user |
| Edit plan | Author or delegate |
| Add/edit tasks | Author or delegate |
| Comment | Any user |
| Label/Assign | Delegates only |

## Multi-Agent Orchestration

Plans are the primary coordination layer for the multi-agent worktree workflow:

- **`/rad-orchestrate <plan-id>`** (pi extension) — Automated dispatch loop that creates worktrees, spawns worker subagents, and manages the full plan lifecycle
- Workers claim tasks via plan comments (`CLAIM task:<id>`), signal file scope changes (`SIGNAL task:<id> files-added:<paths>`), and mark completion via `task link-commit`
- The orchestrator creates **one Radicle patch per plan** at completion — workers produce commits only
- Task branches are merged with `--no-ff` (merge commits include task IDs for traceability)
- Context COBs created by workers feed back into the orchestrator's dispatch decisions

### Key Plan Fields for Orchestration

- **`affectedFiles`** on each task — used for file conflict detection between parallel workers
- **`blocked_by`** — dependency ordering; a task is ready only when all dependencies have `linkedCommit`
- **`linkedCommit`** — the sole indicator that a task is complete
- **Discussion thread** — carries CLAIM/SIGNAL conventions for in-flight coordination

See `agents-cobs-worktrees.md` for the full design and `.pi/extensions/rad-orchestrator.ts` for the implementation.

## Related Commands

- `/rad-import` — Import issues, optionally create plans (interactive plan-save prompt)
- `/rad-sync` — Sync task completion to issues and plans
- `/rad-status` — View repo state including plan progress

## Installation

The Plan COB functionality requires:

1. **rad-plan CLI**: Install from the `radicle-plan-cob` repository
2. **Radicle**: Standard Radicle CLI (`rad`)
3. **rad-skill plugin**: This plugin

```bash
# Clone and install rad-plan from Radicle
rad clone rad:z4L8L9ctRYn2bcPuUT4GRz7sggG1v
cd radicle-plan-cob
cargo install --path .

# Verify
rad-plan --version
```

### Detection

The session-start hook automatically detects whether `rad-plan` is installed. If it is not found, the hook will display install instructions. All Plan COB features (plan save, plan sync) gracefully degrade when `rad-plan` is not available.
