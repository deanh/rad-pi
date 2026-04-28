# @rad-pi/cob

Optional Radicle COB integrations for pi.

Includes:
- `rad-plan` support
- `rad-context` support

Design intent:
- builds on `@rad-pi/core` for baseline repo and network operations
- keeps COB-specific behavior here instead of bloating the default package
- does not include experiment publishing

Experiment publishing is handled by the Community Computer `pi-cc` extension in the Community Computer repository (`rad:z4Wk8hdpwG4HtoCxr1uuoQDpnfr25`).

Depends on `@rad-pi/core`.
