# rad-pi

Default Radicle package for [pi](https://github.com/badlogic/pi-mono).

## Install behavior

`npm install rad-pi` maps to the **core** experience:

- deterministic Radicle agent tooling
- a thin, tool-first core Radicle skill
- shared baseline Radicle helpers and typed core tools

It does **not** include the optional COB or autonomy layers by default.

## Package lineup

- `rad-pi` — default package, aligned with **core**
- `@rad-pi/core` — deterministic Radicle agent tooling
- `@rad-pi/cob` — optional Plan/Context COB integrations
- `@rad-pi/autonomy` — optional issue loops, planning loops, orchestration, and workers

## Versioning

Managed with [changesets](https://github.com/changesets/changesets). Per-package versions are tracked in their respective `package.json` files and `CHANGELOG.md` files are auto-generated on release.

```bash
npx changeset          # describe a change
npx changeset version  # bump packages
npx changeset publish  # publish to npm
```

## Monorepo layout

```text
packages/
  core/       # baseline Radicle skill + shared helpers
  cob/        # rad-plan and rad-context integrations
  autonomy/   # loops, orchestrator, worker agent
```

## Development

Run all package tests:

```bash
npm test
```
