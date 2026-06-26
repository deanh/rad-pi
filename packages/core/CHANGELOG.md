# @rad-pi/core

## 1.6.1

### Patch Changes

- Update pi coding agent peer dependency and imports to `@earendil-works/pi-coding-agent` `^0.80.2`.
- Apply non-breaking npm audit lockfile updates.

## 1.6.0

### Minor Changes

- feat: support non-default patch bases in `rad_patch_submit`

  `rad_patch_submit` now accepts Radicle push options:

  - `base` → `git push -o patch.base=<rev> HEAD:refs/patches`
  - `draft` → `git push -o patch.draft HEAD:refs/patches`
  - `branch` → `git push -o patch.branch=<name> HEAD:refs/patches`
  - `noSync` → `git push -o no-sync HEAD:refs/patches`

### Patch Changes

- docs: update bundled Radicle skill and command reference to match latest upstream guidance
- fix: use current Radicle CLI forms for patch/issue list filters and patch review messages
- feat: add `includeDiff` option to `rad_patch_show` for `rad patch show --patch`
- feat: support `all`, `solved`, and `assigned` issue list/state workflows where applicable

## 1.5.1

### Patch Changes

- fix: correct CLI flag arguments for 6 radicle tools

  - `rad_patch_list`: `--state <state>` → `--<state>` (--open, --merged, etc.)
  - `rad_patch_update_revision`: `--state open` → `--open`
  - `rad_issue_list`: `--state closed` → `--closed`
  - `rad_clone`: `--path <path>` → positional `<path>`
  - `rad_self_show --nid` (deprecated) → `rad node status --only nid`
  - `rad_patch_assign`: `--add <did> <id>` → `<id> --add <did>` (arg order)
