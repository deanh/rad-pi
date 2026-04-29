# @rad-pi/core

## 1.5.1

### Patch Changes

- fix: correct CLI flag arguments for 6 radicle tools

  - `rad_patch_list`: `--state <state>` → `--<state>` (--open, --merged, etc.)
  - `rad_patch_update_revision`: `--state open` → `--open`
  - `rad_issue_list`: `--state closed` → `--closed`
  - `rad_clone`: `--path <path>` → positional `<path>`
  - `rad_self_show --nid` (deprecated) → `rad node status --only nid`
  - `rad_patch_assign`: `--add <did> <id>` → `<id> --add <did>` (arg order)
