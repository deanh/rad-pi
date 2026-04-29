---
name: radicle
description: Use for Radicle repository, patch, issue, node, sync, identity, clone, init, seeding, and collaboration tasks.
version: 0.2.0
---

# Radicle Core Skill

Prefer the dedicated Radicle tools from `@rad-pi/core` over shell commands whenever they cover the user intent.

## Tool-first rules

- Use **`rad_repo_probe`** first when you need to know whether the cwd is a Radicle repo, what branch you are on, whether the node is running, or which optional Radicle CLIs are installed.
- Use **`rad_self_show`** for identity questions like “who am I”, DID, NID, or Radicle home.
- Use **`rad_node_status`** before network actions if node availability is uncertain.
- Use **`rad_sync`** and **`rad_sync_status`** for sync/fetch/announce/status requests.
- Use **`rad_issue_list`**, **`rad_issue_show`**, **`rad_issue_comment`**, **`rad_issue_update_state`**, and **`rad_issue_update_labels`** for issue workflows.
- Use **`rad_patch_list`**, **`rad_patch_show`**, **`rad_patch_checkout`**, **`rad_patch_review`**, **`rad_patch_assign`**, **`rad_patch_update_revision`**, and **`rad_patch_submit`** for common patch workflows.
- Use **`rad_clone`**, **`rad_remote_list`**, **`rad_remote_add`**, and **`rad_inspect`** for core repository and peer operations.
- Use `bash` only when the Radicle core tools do not cover the request.

## Intent mappings

When the user asks to:

- “create a patch”, “open a patch”, “submit for review” → use `rad_patch_submit`
- “list patches” → use `rad_patch_list`
- “show patch” → use `rad_patch_show`
- “list issues” → use `rad_issue_list`
- “show issue” → use `rad_issue_show`
- “comment on issue” → use `rad_issue_comment`
- “close issue”, “reopen issue” → use `rad_issue_update_state`
- “add label”, “remove label” on an issue → use `rad_issue_update_labels`
- “sync”, “fetch”, “announce” → use `rad_sync`
- “check sync status” → use `rad_sync_status`
- “checkout patch” → use `rad_patch_checkout`
- “accept patch”, “reject patch”, “review patch” → use `rad_patch_review`
- “assign patch” → use `rad_patch_assign`
- “update patch”, “refresh patch” → use `rad_patch_update_revision`
- “clone repo” → use `rad_clone`
- “list remotes” → use `rad_remote_list`
- “add rad remote” → use `rad_remote_add`
- “inspect delegates” → use `rad_inspect`
- “who am I”, “my DID”, “my NID” → use `rad_self_show`
- “is the node running?” → use `rad_node_status`

## Shell fallback rules

If you must use `bash`:

- Run one command per step.
- Use exact user-provided titles, descriptions, messages, IDs, and refs.
- Do not add diagnostic commands before the requested action unless needed to complete it safely.
- Prefer non-interactive forms of `rad` commands.

## Core Radicle command reminders

These are the fallback commands for unsupported operations:

- Create patch: `git push rad HEAD:refs/patches`
- Update patch revision: `git push --force`
- List open patches: `rad patch list --state open`
- Checkout patch: `rad patch checkout <PATCH_ID>`
- Review patch: `rad patch review --accept|--reject --message 'msg' <PATCH_ID>`
- List open issues: `rad issue list --state open`
- Comment on issue: `rad issue comment <ISSUE_ID> --message 'msg'`
- Close issue: `rad issue state <ISSUE_ID> --closed`
- Reopen issue: `rad issue state <ISSUE_ID> --open`
- Add issue label: `rad issue label <ISSUE_ID> --add <label>`
- Remove issue label: `rad issue label <ISSUE_ID> --delete <label>`
- Sync both directions: `rad sync`
- Fetch only: `rad sync --fetch`
- Announce only: `rad sync --announce`
- Show identity: `rad self`
- Start node: `rad node start`
- Show node status: `rad node status`
- Clone by RID: `rad clone rad:<RID>`
- Init public repo: `rad init --name <NAME> --public --no-confirm`
- Init private repo: `rad init --private --no-confirm`
- Start seeding: `rad seed rad:<RID>`
- Stop seeding: `rad unseed rad:<RID>`

## Notes

- `RID` means repository ID like `rad:z...`
- `DID` means identity like `did:key:...`
- `NID` means node ID / peer ID
- Prefer short-form IDs only when the command/tool supports them and the local context is unambiguous
- Use `packages/core/skills/radicle/references/commands.md` only for unsupported or edge-case commands
