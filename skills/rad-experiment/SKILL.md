---
name: rad-experiment
description: Knowledge about rad-experiment CLI and cc.experiment COBs — publishing, reproducing, and curating optimization experiments in Radicle repos. Use when working with rad-experiment, experiment COBs, publish-tape, autoresearch publishing, or cc.experiment.
---

TRIGGER when: user mentions rad-experiment, experiment COBs, publish-tape, publish-evo, autoresearch publishing, cc.experiment, or benchmark optimization workflows.

# Radicle Experiment COB Skill

This skill provides knowledge about Experiment COBs (`cc.experiment`) — a Collaborative Object type for AI-generated optimization experiments in Radicle repositories.

## What are Experiment COBs?

Experiment COBs are first-class collaborative objects that capture optimization experiments — a before/after benchmark comparison produced by an AI agent or human. They enable:

- **Peer-to-peer experiment sharing**: Experiments replicate across the Radicle network like Issues and Patches
- **Independent reproduction**: Any peer can reproduce an experiment by re-running the benchmarks
- **Network-wide curation**: Delegates label and redact experiments; consumers filter by label, author, branch, or date
- **Multi-tool ingestion**: Supports pi-autoresearch (`publish-tape`) and evo (`publish-evo`) session formats

## Type Name

```
cc.experiment
```

Stored under `refs/cobs/cc.experiment/<EXPERIMENT-ID>` in the Git repository.

## Experiment Structure

Each experiment COB contains:

| Field | Description |
|-------|-------------|
| `description` | Hypothesis: what was tried and why |
| `base` | Base (baseline) commit OID |
| `oid` | Candidate (head) commit OID |
| `metrics` | Primary + secondary metrics with measurements |
| `env` | Auto-detected environment (CPU arch, OS, CPU brand, RAM) |
| `schema_version` | COB schema version (current: 5) |
| `reproductions` | Independent reproductions by other peers |
| `labels` | Curation labels (delegates only) |
| `redacted` | Whether the experiment has been redacted |

### Metric Structure

Each metric in the experiment:

| Field | Description |
|-------|-------------|
| `name` | Metric name (must match `autoresearch.yaml` / `optimize.yaml`) |
| `unit` | Unit string (e.g. `"ms"`, `"µs"`, `""` for unitless) |
| `criteria` | `lower_is_better` or `higher_is_better` |
| `baseline` | Baseline measurement (median × 1000, std, samples, n) |
| `candidate` | Candidate measurement (median × 1000, std, samples, n) |
| `is_primary` | Whether this is the primary optimization target |

### Conventions

- **Values are scaled by 1000**: `1.500 s` → `1500`, `14.327 ms` → `14327`. This avoids floating-point drift in COB serialization.
- **Deltas are direction-aware**: Positive percentage always means "better". A latency drop of 1500 → 1425 shows as `+5.00%`; a throughput climb of 1.0 → 1.1 also shows as `+10.00%`.
- **Short IDs accepted**: Every command that takes an experiment ID accepts a 7-character prefix or any git revparse expression resolving to the same OID.

## CLI Commands

### rad-experiment publish

Publish a new experiment with explicit measurements (publishes immediately — no confirmation prompt):

```bash
rad-experiment publish \
  --base <SHA> --head <SHA> \
  --metric duration_ms \
  --baseline-median 1500 --baseline-n 5 \
  --candidate-median 1425 --candidate-n 5 \
  --description "Hoist allocation out of inner loop"
```

With secondary metrics, per-run samples, and environment overrides:

```bash
rad-experiment publish \
  --base 9b32764 --head 5574144 \
  --metric duration_ms \
  --baseline-median 1500 --baseline-std 23 \
    --baseline-samples 1488,1502,1497,1510,1503 --baseline-n 5 \
  --candidate-median 1425 --candidate-std 18 \
    --candidate-samples 1420,1432,1418,1428,1425 --candidate-n 5 \
  --secondary "binary_size_bytes:1000000:950000" \
  --description "Hoist allocation"
```

When publishing from a source without `autoresearch.yaml` at the base commit (e.g. `publish-tape`), provide `--unit` and `--criteria`:

```bash
rad-experiment publish \
  --base 9b32764 --head 5574144 \
  --metric total_us --unit µs --criteria lower_is_better \
  --baseline-median 15200 --baseline-n 5 \
  --candidate-median 13800 --candidate-n 5
```

### rad-experiment publish-tape

Import a pi-autoresearch `autoresearch.jsonl` session file as COBs. **This is the primary integration point for autoresearch workflows.**

```bash
# Dry-run — show what would be published
rad-experiment publish-tape autoresearch.jsonl --dry-run

# Publish every unpublished keep result
rad-experiment publish-tape autoresearch.jsonl --yes
```

For each segment (delimited by `type:config` header lines), the first result is the segment baseline. Every subsequent result with `status:keep` becomes a published experiment. Discards, crashes, and `checks_failed` results are skipped (their code was already reverted).

Idempotent: an index file at `<jsonl_parent>/.cc-experiment/published.json` tracks which `(base,head)` pairs have been published. Re-running the command only publishes new results.

### rad-experiment publish-evo

Import an evo-hq/evo `.evo/` session directory as COBs:

```bash
rad-experiment publish-evo .evo --dry-run
rad-experiment publish-evo .evo --yes
```

### rad-experiment list

```bash
rad-experiment list                           # all experiments, grouped by branch
rad-experiment list --json                    # JSONL output for piping to jq
rad-experiment list --reproduced              # only reproduced
rad-experiment list --unmerged                # branches not yet in main
rad-experiment list --landable                # branches that 3-way merge cleanly
rad-experiment list --author z6MkfEaY         # by author (DID prefix)
rad-experiment list --label shipped           # by label
rad-experiment list --since 2026-04-01        # since date
rad-experiment list --delegates-only          # only delegates
```

### rad-experiment show

```bash
rad-experiment show <ID>
rad-experiment show <ID> --json
rad-experiment show <ID> --diff               # include code diff
```

### rad-experiment reproduce

**WARNING**: reproduction runs untrusted code. It checks out a branch you may not control and executes its `bench_cmd`. Review the candidate diff first, or run inside a container/VM.

```bash
# Auto mode — re-runs benchmarks from autoresearch.yaml
rad-experiment reproduce <ID>
rad-experiment reproduce <ID> --runs 10

# Manual mode — provide your own measurements
rad-experiment reproduce <ID> \
  --baseline-median 1498 --baseline-n 5 \
  --candidate-median 1430 --candidate-n 5 \
  --notes "warm cache, perf governor"
```

### rad-experiment benchmark

Stateless helper — runs benchmarks on a worktree, outputs JSON. Does not touch the COB store.

```bash
rad-experiment benchmark \
  --worktree /tmp/repo-base --config autoresearch.yaml \
  --runs 5 --label baseline > /tmp/baseline.json
```

### rad-experiment compute-delta

Stateless helper — computes direction-aware deltas from two benchmark JSON files.

```bash
rad-experiment compute-delta \
  --baseline /tmp/baseline.json --candidate /tmp/candidate.json \
  --config autoresearch.yaml \
  --base-commit 9b32764 --head-commit 5574144 \
  --description "Hoist allocation" --pending=false
```

### rad-experiment label

Add or remove labels (delegates only):

```bash
rad-experiment label <ID> shipped
rad-experiment label <ID> reviewed nominated
rad-experiment label <ID> nominated --remove
```

### rad-experiment labels

List all labels in use across the repo:

```bash
rad-experiment labels
rad-experiment labels --json
```

### rad-experiment redact

Mark an experiment as unreliable (not a delete — still replicates, but hidden by default):

```bash
rad-experiment redact <ID>
rad-experiment redact <ID> --reason "benchmark used a stale input dataset"
```

## Network Propagation

- **Mutating commands** (`publish`, `publish-tape`, `publish-evo`, `reproduce`, `label`, `redact`) call `announce_refs_for` to broadcast new refs to peers
- **`publish`** additionally pins base and candidate commits under `refs/heads/experiments/{oid}` via `git push rad` so peers receive the actual git objects
- If the node is not running, a hint is shown instead of an error — the COB is committed locally and will sync on the next `rad sync`

## Integration with pi-autoresearch

The main workflow for publishing autoresearch results to the community-computer network has **two required steps**:

### Step 1: Push the experiment branch to Radicle

The autoresearch branch must be pushed so peers can access the git objects (commits, diffs):

```bash
git push rad <branch-name>
```

Or push the current branch:

```bash
git push rad HEAD
```

### Step 2: Publish the autoresearch session tape

After the autoresearch session completes (or at any point during it), publish the kept experiments:

```bash
rad-experiment publish-tape autoresearch.jsonl --yes
```

### Complete workflow example

```bash
# 1. Run autoresearch (handled by the autoresearch skill)
#    - Creates autoresearch.md, autoresearch.sh
#    - Runs experiments, keeps improvements, discards regressions
#    - All results logged to autoresearch.jsonl

# 2. Push the branch to Radicle
git push rad autoresearch/optimize-liquid

# 3. Publish the experiment tape
rad-experiment publish-tape autoresearch.jsonl --yes

# 4. Sync with network
rad sync --announce
```

### What gets published

- Only experiments with `status:keep` are published
- Discards, crashes, and `checks_failed` results are skipped
- Metric unit and criteria come from the jsonl config header — no `autoresearch.yaml` required at the base commit
- ASI (Actionable Side Information) annotations are carried through to the COB
- Re-running `publish-tape` is idempotent — only new results are published

## Configuration: autoresearch.yaml

The benchmark configuration file at the repository root (also accepted as `optimize.yaml` for backward compatibility):

```yaml
bench_cmd: ./autoresearch.sh
metrics:
  - name: total_us
    unit: µs
    criteria: lower_is_better
    regex: "METRIC total_µs=(\\d+)"
  - name: compile_µs
    unit: µs
    criteria: lower_is_better
    regex: "METRIC compile_µs=(\\d+)"
```

- First metric in the list is the primary optimization target
- `bench_dir` defaults to `"bench"` if omitted
- Supports `build_cmd` and `test_cmd` fields for pre-benchmark steps

## Installation

```bash
# Recommended — prebuilt binary
curl -sSf https://community.computer/install | sh

# Or build from source
rad clone rad:z3trgPnc9KqoFHpZj8KD9s7iX7nwX
cd radicle-experiment
cargo install --path .

# Verify
rad-experiment --version
```

### Detection

Ensure `rad-experiment` is on `$PATH`. Extensions that need it can register `{ name: "rad-experiment" }` with `detectTools()` from `rad-shared.ts`.
