---
name: rad-issue-loop
description: Autonomous issue worker loop - checks for new issues, works them to completion, creates context COBs, and submits patches. Use when you want to run an autonomous agent that processes Radicle issues.
version: 0.1.0
---

# Radicle Issue Loop Skill

This skill defines the workflow for autonomously processing Radicle issues in a continuous loop.

## Overview

The issue loop automates the following cycle:

1. **Sync** - Fetch latest changes from the network
2. **Check Issues** - List open issues, identify new ones
3. **Work Issue** - Implement a solution for the selected issue
4. **Create Context** - Document learnings in a Context COB
5. **Submit Patch** - Push changes as a Radicle patch
6. **Clear Context** - Reset agent state for the next issue
7. **Repeat** - Return to step 1

## Prerequisites

- Radicle CLI (`rad`) installed and authenticated
- `rad-context` CLI installed for Context COBs
- `rad-plan` CLI installed (optional, for plan-based workflows)
- Node is running (`rad node start`)

## Workflow

### Step 1: Sync with Network

```bash
rad sync --fetch
rad sync status
```

### Step 2: Check for Open Issues

```bash
rad issue list
```

Identify issues that:
- Are open (not closed)
- Not already being worked on (check for linked patches/contexts)
- Match any configured priority labels

For each candidate issue, get details:

```bash
rad issue show <issue-id>
```

### Step 3: Work the Issue

Before starting work:

1. **Create a feature branch:**
   ```bash
   git checkout -b issue-<issue-id>
   ```

2. **Read the issue carefully** and understand requirements

3. **Check for related contexts** that may inform the approach:
   ```bash
   rad-context list
   rad-context show <context-id> --json
   ```

4. **Implement the solution** following codebase conventions

5. **Run verification** (tests, lints, builds):
   ```bash
   # Run project-appropriate verification commands
   ```

### Step 4: Create Context COB

Document the session:

```bash
echo '{
  "title": "Fix: <brief description>",
  "description": "<what was done>",
  "approach": "<reasoning, alternatives considered>",
  "constraints": ["<assumptions that must remain true>"],
  "learnings": {
    "repo": ["<patterns discovered>"],
    "code": [{"path": "<file>", "line": 0, "finding": "<insight>"}]
  },
  "friction": ["<problems encountered>"],
  "openItems": ["<unfinished work>"],
  "filesTouched": ["<modified files>"],
  "verification": [
    {"check": "<command>", "result": "pass", "note": "<detail>"}
  ]
}' | rad-context create --json
```

Link the context to the issue:

```bash
rad-context link <context-id> --issue <issue-id>
```

### Step 5: Submit Patch

Commit changes:

```bash
git add <files>
git commit -m "<conventional commit message>"
```

Push as a patch:

```bash
git push rad HEAD:refs/patches
```

Link patch to issue (if the push output provides the patch ID):

```bash
rad issue comment <issue-id> "Patch submitted: <patch-id>"
```

Announce to network:

```bash
rad sync --announce
```

### Step 6: Clear Context

Return to main branch:

```bash
git checkout main
git pull
```

Reset working state for the next issue.

### Step 7: Check for New COBs

Before looping, check for new collaborative objects:

```bash
# Check for new issues
rad issue list

# Check for new patches (may need review)
rad patch list

# Check for new contexts (may contain relevant learnings)
rad-context list
```

### Loop

Return to Step 1 and repeat.

## Configuration

The loop can be configured via:

- **Labels** - Only process issues with specific labels (e.g., `good-first-issue`, `bug`)
- **Priority** - Process issues in priority order
- **Exclusion** - Skip issues matching certain patterns
- **Batch size** - Process N issues before syncing
- **Cooldown** - Wait period between issues

## Extension API

The `/rad-issue-loop` command provides:

```
/rad-issue-loop              # Start the loop interactively
/rad-issue-loop --auto       # Run without prompts (autonomous mode)
/rad-issue-loop --labels bug,feature  # Filter by labels
/rad-issue-loop --oneshot    # Process one issue then stop
/rad-issue-loop --status     # Show loop status
/rad-issue-loop --stop       # Stop a running loop
```

## Error Handling

- If issue work fails: log error, leave branch, continue to next issue
- If patch push fails: preserve commit, report error
- If context creation fails: continue without context (non-blocking)
- If sync fails: retry with exponential backoff

## Boundaries

- **Do NOT** close issues directly (patches should resolve them)
- **Do NOT** work on issues with existing open patches (check first)
- **Do NOT** modify issues you didn't create unless delegated
- **DO** create one commit and one context per issue
- **DO** link context to issue and commits
