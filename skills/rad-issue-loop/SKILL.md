---
name: rad-issue-loop
description: Autonomous issue worker loops - direct issue implementation and label-driven plan creation. Use when you want to run autonomous agents that process Radicle issues, create plans, and orchestrate execution.
version: 0.2.0
---

# Radicle Issue & Plan Loops

This skill defines the two-loop architecture for autonomously processing Radicle issues:

- **Loop 1a** (`/rad-issue-loop`): Direct implementation for simple issues
- **Loop 1b** (`/rad-plan-loop`): Plan creation for complex issues (label-driven)
- **Loop 2** (`/rad-orchestrate-loop`): Watches for approved plans and executes them

## Architecture

```
                    ┌──────────────┐
                    │  Open Issue   │
                    └──────┬───────┘
                           │
                    Has 'toplan' label?
                    /              \
                  No               Yes
                  /                  \
         ┌──────▼──────┐    ┌───────▼────────┐
         │ rad-issue-   │    │  rad-plan-loop  │
         │ loop         │    │  (Loop 1b)      │
         │ (Loop 1a)    │    │                 │
         │ Direct work  │    │ Creates Plan COB│
         └──────┬───────┘    └───────┬─────────┘
                │                    │
                │              'toplan' → 'planned'
                │              Plan status: draft
                │                    │
                │              Human reviews plan
                │              (or --auto-approve)
                │                    │
                │              rad-plan status <id> approved
                │                    │
                │            ┌───────▼──────────┐
                │            │ rad-orchestrate-  │
                │            │ loop (Loop 2)     │
                │            │                   │
                │            │ Worktrees, workers │
                │            │ context COBs       │
                ▼            └───────┬────────────┘
           Patch pushed              │
                                Patch pushed
```

## Prerequisites

- Radicle CLI (`rad`) installed and authenticated
- `rad-context` CLI installed for Context COBs
- `rad-plan` CLI installed (required for Loop 1b and Loop 2)
- Node is running (`rad node start`)

## Loop 1a: Direct Issue Work (`/rad-issue-loop`)

For simple issues that don't need structured planning.

### Commands

```
/rad-issue-loop                    # Start interactively
/rad-issue-loop --auto             # Run without prompts
/rad-issue-loop --oneshot          # Process one issue then stop
/rad-issue-loop --labels bug       # Only process issues with 'bug' label
/rad-issue-loop --exclude-label toplan  # Exclude label (default: 'toplan')
/rad-issue-loop --status           # Show loop status
/rad-issue-loop --stop             # Stop a running loop
```

### Workflow

1. **Sync** with the Radicle network
2. **List** open issues (excluding `toplan`-labeled issues by default)
3. **Select** an issue (interactive or auto)
4. **Inject** work prompt into the agent (branch, implement, commit)
5. **Complete** with `/rad-issue-work` (context COB, patch, announce)
6. **Repeat**

### Completing Work

After the agent finishes implementing:

```
/rad-issue-work <issue-id>    # Or run from issue-* branch
```

This commits changes, creates a Context COB, pushes a Radicle patch, and returns to main.

## Loop 1b: Plan Creation (`/rad-plan-loop`)

Watches for issues labeled `toplan` and creates Plan COBs from them.

### Commands

```
/rad-plan-loop                     # Start watching for 'toplan' issues
/rad-plan-loop --auto-approve      # Create plans and set status to 'approved'
/rad-plan-loop --oneshot           # Process current batch then stop
/rad-plan-loop --plan-label mytag  # Use custom label (default: 'toplan')
/rad-plan-loop --planned-label done  # Custom "processed" label (default: 'planned')
/rad-plan-loop --max-plans 3       # Stop after creating N plans
/rad-plan-loop --status            # Show loop status
/rad-plan-loop --stop              # Stop a running loop
```

### Quick Check

```
/rad-plan-check                    # Show toplan/planned issues and approved plans
```

### Workflow

1. **Sync** with the Radicle network
2. **Find** open issues with the `toplan` label
3. **Check idempotency**: skip issues that already have a linked plan
4. **Analyze** the issue and codebase via LLM
5. **Create** a Plan COB with structured tasks, estimates, and affected files
6. **Link** the plan to the issue
7. **Swap labels**: remove `toplan`, add `planned`
8. **Set status**: `draft` (default) or `approved` (with `--auto-approve`)
9. **Announce** to the network
10. **Repeat**

### Label Lifecycle

```
Issue created with 'toplan' label
        │
        ▼
rad-plan-loop picks it up
        │
        ▼
Plan COB created, linked to issue
        │
        ▼
Label swapped: 'toplan' → 'planned'
        │
        ▼
Human re-adds 'toplan'?  →  New plan created (supports multiple plans per issue)
```

### Plan Quality

The planning LLM is instructed to:
- Explore the actual codebase file tree before generating tasks
- Use real file paths in `affectedFiles` (critical for orchestrator conflict detection)
- Break work into 3-7 independently implementable tasks
- Include test tasks alongside implementation tasks
- Express task ordering via `blocked_by` references

## Loop 2: Plan Execution (`/rad-orchestrate-loop`)

Watches for approved plans and dispatches them to the orchestrator.

### Commands

```
/rad-orchestrate-loop              # Start watching for approved plans
/rad-orchestrate-loop --oneshot    # Execute one plan then stop
/rad-orchestrate-loop --cooldown 60000  # Set poll interval (ms)
/rad-orchestrate-loop --status     # Show loop status
/rad-orchestrate-loop --stop       # Stop
```

### Workflow

1. **Sync** with the Radicle network
2. **List** plans with status `approved`
3. **Set** plan status to `in-progress`
4. **Delegate** to `/rad-orchestrate <plan-id>` for full worktree dispatch
5. After completion, **loop** back to check for more plans

### Approving Plans

After `rad-plan-loop` creates a draft plan:

```bash
# Review the plan
rad-plan show <plan-id>

# Edit tasks if needed
rad-plan task edit <plan-id> <task-id> --description "Updated details"

# Approve when ready
rad-plan status <plan-id> approved
```

## Composable Workflows

| Workflow | Commands |
|----------|----------|
| Fully manual | Human creates plans, `/rad-orchestrate <id>` |
| Planning only | `/rad-plan-loop` → human reviews → manual orchestrate |
| Full auto with human gate | `/rad-plan-loop` + `/rad-orchestrate-loop` (human approves between) |
| Full auto, no gate | `/rad-plan-loop --auto-approve` + `/rad-orchestrate-loop` |
| Simple issues only | `/rad-issue-loop` (no plans involved) |
| Mixed | `/rad-issue-loop` for simple + `/rad-plan-loop` for complex |

## Configuration

- **Plan label**: `--plan-label <label>` (default: `toplan`)
- **Planned label**: `--planned-label <label>` (default: `planned`)
- **Exclude label**: `--exclude-label <label>` on issue loop (default: `toplan`)
- **Max plans**: `--max-plans <n>` to throttle plan creation
- **Cooldown**: Wait period between iterations (default: 30s)

## Error Handling

- If plan creation fails: log error, skip issue, continue to next
- If an issue already has a linked plan: skip (idempotent)
- If `rad-plan` is not installed: report and suggest installation
- If LLM call fails: report error, continue
- If label operations fail: non-blocking, continue

## Boundaries

- **Do NOT** close issues directly (patches should resolve them)
- **Do NOT** work on `toplan` issues in the direct loop (they belong to plan-loop)
- **Do NOT** approve plans automatically unless `--auto-approve` is set
- **DO** create one plan per `toplan` issue (re-adding label creates a new plan)
- **DO** link plans to issues for traceability
- **DO** swap labels to signal processing state
