---
name: rad-contexts
description: Knowledge about Radicle Context COBs (me.hdh.context) - a custom Collaborative Object type for storing AI session observations in Radicle repositories. Use when working with rad-context, context COBs, or preserving session learnings.
---

# Radicle Context COB Skill

This skill provides knowledge about Context COBs (`me.hdh.context`) - a custom Collaborative Object type for storing observations from AI-assisted development sessions in Radicle repositories.

## What are Context COBs?

Context COBs are first-class collaborative objects that capture what an AI agent learned and experienced during a coding session. They enable:

- **Session memory**: Preserve approach, constraints, learnings, and friction across sessions
- **Agent-first design**: Every field ranked by utility to future coding agents
- **Immutable observations**: Core fields set at creation, no CRDT conflicts
- **Radicle-native linking**: Bidirectional links to Issues, Patches, Plans, and commits
- **Network sync**: Replicate across the Radicle network like Issues and Patches

## Type Name

```
me.hdh.context
```

Stored under `refs/cobs/me.hdh.context/<CONTEXT-ID>` in the Git repository.

## Context Structure

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Brief session identifier |
| `description` | string | Free-form (for standalone contexts) |
| `approach` | string | Reasoning chain — what was tried, why the chosen path won, rejected alternatives |
| `constraints` | string[] | Forward-looking assumptions — "valid as long as X remains true" |
| `learnings` | LearningsSummary | Codebase discoveries (see below) |
| `friction` | string[] | Past-tense problems encountered — specific and actionable |
| `open_items` | string[] | Unfinished work, tech debt introduced, known gaps |
| `files_touched` | string set | Files actually modified during the session |
| `verification` | VerificationResult[] | Structured pass/fail/skip results from checks run during the session |
| `task_id` | string? | Plan task ID that produced this context (links context to a specific plan task) |
| `related_commits` | string set | Git commit SHAs (mutable via link/unlink) |
| `related_issues` | ObjectId set | Linked Radicle issues (mutable via link/unlink) |
| `related_patches` | ObjectId set | Linked Radicle patches (mutable via link/unlink) |
| `related_plans` | ObjectId set | Linked Radicle plans (mutable via link/unlink) |

### LearningsSummary

```json
{
  "repo": ["Uses conventional commits", "Error types follow thiserror pattern"],
  "code": [
    {
      "path": "src/auth.rs",
      "line": 42,
      "finding": "Auth middleware expects Request to carry session state"
    }
  ]
}
```

- `repo`: Repository-level patterns and conventions
- `code`: File-specific findings with optional line references (`line`, `endLine`)

### VerificationResult

```json
{
  "check": "cargo test",
  "result": "pass",
  "note": "all 25 tests passed"
}
```

- `check`: Name of the verification step (e.g. "cargo test", "clippy", "unit tests")
- `result`: One of `"pass"`, `"fail"`, or `"skip"` (lowercase)
- `note`: Optional details about the outcome

## Agent-Utility Priority Order

When consuming contexts, surface fields in this order:

1. **constraints** — Guard rails that affect correctness
2. **friction** — Avoid repeating past mistakes
3. **learnings** — Accelerate understanding of the codebase
4. **approach** — Understand reasoning and rejected alternatives
5. **open_items** — Know what's incomplete

## Relationship to Plan COBs

| Aspect | Plan COB (`me.hdh.plan`) | Context COB (`me.hdh.context`) |
|--------|--------------------------|-------------------------------|
| Purpose | Coordination | Observation |
| Content | Intent, tasks, status | Approach, learnings, friction |
| Lifecycle | Draft → Completed → Archived | Created (no status transitions) |
| Mutability | Most fields mutable | Core fields immutable, links mutable |

When linked together: the **"what"** comes from the Plan, the **"how"** comes from the Context.

## Short-Form IDs

All commands accept short-form IDs (minimum 7 hex characters) for both context IDs and linked object IDs. For example:

```bash
rad-context show 0ab784b           # instead of full 40-char ID
rad-context link 0ab784b --issue 40c8b56
```

If a prefix is ambiguous (matches multiple objects), the error lists all matches.

## CLI Commands

### rad-context create

`filesTouched` is auto-populated from the HEAD commit by default. Use `--no-auto-files` to disable this and rely only on explicitly provided files (from `--file` flags or JSON input).

Use `--auto-link-commits <ref>` to automatically link all commits between `<ref>` (exclusive) and HEAD (inclusive) to the new context.

Create from flags:

```bash
rad-context create "Session title" \
  --description "Free-form description" \
  --approach "What was tried and why" \
  --constraint "Assumes X remains true" \
  --friction "Type errors with async closures" \
  --open-item "Refresh token rotation not implemented" \
  --file src/auth.rs --file src/middleware.rs \
  --task <plan-task-id>
```

Create from JSON (used by `/rad-context` command):

```bash
echo '<json>' | rad-context create --json
```

### rad-context list

```bash
rad-context list
```

Shows all contexts with IDs, titles, and link counts.

### rad-context show

```bash
rad-context show <context-id>
rad-context show <context-id> --json
```

### rad-context link

```bash
rad-context link <context-id> --commit <sha>
rad-context link <context-id> --issue <issue-id>
rad-context link <context-id> --patch <patch-id>
rad-context link <context-id> --plan <plan-id>
```

### rad-context unlink

```bash
rad-context unlink <context-id> --commit <sha>
rad-context unlink <context-id> --issue <issue-id>
```

## JSON Format for Creation

```json
{
  "title": "Implement auth flow",
  "description": "Session to add OAuth support",
  "approach": "Used passport.js for OAuth, rejected manual token handling",
  "constraints": ["Assumes Redis is available for session storage"],
  "learnings": {
    "repo": ["Uses conventional commits"],
    "code": [
      {
        "path": "src/auth.rs",
        "line": 42,
        "finding": "Auth middleware expects Request to carry session state"
      }
    ]
  },
  "friction": ["Type errors with async middleware closures"],
  "openItems": ["Refresh token rotation not implemented"],
  "filesTouched": ["src/auth.rs", "src/middleware.rs"],
  "verification": [
    {"check": "cargo test", "result": "pass", "note": "all tests passed"},
    {"check": "cargo clippy", "result": "pass"}
  ],
  "taskId": "task-a1b2"
}
```

Note: JSON uses camelCase (`openItems`, `filesTouched`, `taskId`). Verification and taskId are optional — omit when not applicable.

### JSON Validation

The `--json` input is strict:
- **Unknown fields are rejected** with an error listing all valid field names (catches typos)
- **`title`, `description`, and `approach` are required** — empty values produce a hard error with guidance
- Agents can self-correct from the error messages

## Multi-Agent Orchestration

Context COBs are the observation layer in the multi-agent worktree workflow:

- Each worker creates **one Context COB per task** capturing approach, constraints, friction, learnings, open items, verification results, and files touched
- The **`taskId`** field links the context back to its Plan COB task
- The orchestrator reads Context COBs between dispatch batches to evaluate feedback:
  - **Constraints** that conflict with remaining tasks trigger warnings
  - **Open items** suggesting new scope are surfaced for human decision
  - **Friction** relevant to upcoming tasks' affected files is flagged
  - **Verification failures** may block dependent tasks
- COBs live in `~/.radicle/storage/` — accessible from any worktree without sync
- Context COBs form a complete observational record of how a feature was built across multiple agents

### Worker Context Protocol

Workers link their Context COB to the plan and issue:
```bash
rad-context link <context-id> --plan <plan-id>
rad-context link <context-id> --issue <issue-id>
rad-context link <context-id> --commit <commit-oid>
```

See `.pi/agents/rad-worker.md` for the full worker protocol and `.pi/extensions/rad-orchestrator.ts` for the orchestrator's context evaluation logic.

## Claude Code Integration

- `/rad-context create` — Primary creation mechanism (Claude reflects on session)
- `/rad-context list` — View existing contexts
- `/rad-context show <id>` — View context details
- `/rad-context link <id>` — Add links to issues/patches/plans/commits
- `/rad-import` surfaces linked contexts during planning
- `/rad-sync` offers context creation when closing issues

## Installation

```bash
# Clone and install from Radicle
rad clone rad:z2qBBbhVCfMiFEWN55oXKTPmKkrwY
cd radicle-context-cob
cargo install --path .

# Verify
rad-context --version
```

### Detection

The session-start hook automatically detects whether `rad-context` is installed. All Context COB features gracefully degrade when `rad-context` is not available.
