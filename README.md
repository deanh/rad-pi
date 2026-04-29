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

- `rad-pi`: `1.5.0`
- `@rad-pi/core`: `1.5.0`
- `@rad-pi/cob`: `0.1.0`
- `@rad-pi/autonomy`: `0.1.0`

Rationale:

- `rad-pi` and `@rad-pi/core` continue the existing package line
- `@rad-pi/cob` and `@rad-pi/autonomy` are new packages and start at `0.1.0`
- there is **not** yet a published `@rad-pi/full` package, because pi package resource loading is simplest and most reliable when resources live inside the installed package itself; for now, `rad-pi` is the default/core package and the optional layers are installed explicitly
- experiment publishing is no longer part of this repository; use Community Computer `pi-cc` for `rad experiment publish` automation

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
