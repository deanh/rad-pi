# @rad-pi/autonomy

Autonomous Radicle workflows for pi.

Includes:
- issue loops
- plan loops
- orchestration
- worker agent definitions

Design intent:
- builds on `@rad-pi/core` for baseline Radicle repo operations
- builds on `@rad-pi/cob` for plan/context workflows
- keeps orchestrator-specific mechanics, like worktrees and cherry-picks, inside the autonomy layer

Depends on `@rad-pi/core` and `@rad-pi/cob`.
