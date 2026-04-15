/**
 * rad-experiment-hook — Pi Extension
 *
 * Bridges pi-autoresearch with rad-experiment COBs.
 *
 * When both rad-pi and pi-autoresearch are installed, this extension:
 * 1. Listens for log_experiment tool results (via tool_result event)
 * 2. On every kept experiment: pushes the commit to rad and publishes a COB
 * 3. On discard/crash/checks_failed: pins the orphan commit to rad storage
 * 4. On agent_end (session stop): runs publish-tape as a safety net
 *
 * This replicates the behavior of the Claude Code hooks in
 * ~/.claude/plugins/marketplaces/community-computer/hooks/hooks.json:
 *   - auto-publish.sh (Stop hook → publish-tape + chain-tip push)
 *   - guard-worktree-cleanup.sh (Stop hook → warn about orphaned worktrees)
 *
 * Requires: rad-experiment CLI on $PATH, a Radicle repo.
 * Gracefully degrades when either is missing (silent no-op).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectTools, hasTool, type ToolRegistry } from "../lib/rad-shared.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExperimentResult {
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

interface ExperimentState {
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  results: ExperimentResult[];
  currentSegment: number;
}

interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
}

interface HookState {
  reg: ToolRegistry;
  /** Whether we've already run publish-tape for this session's jsonl */
  lastPublishTapeJsonl: string | null;
  /** Track which commits we've already pushed/pinned to avoid duplicates */
  pushedCommits: Set<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

/** Check if autoresearch.jsonl exists and has been written to recently (within staleness window) */
function isActiveAutoresearchSession(workDir: string): boolean {
  const jsonlPath = path.join(workDir, "autoresearch.jsonl");
  if (!fs.existsSync(jsonlPath)) return false;
  try {
    const stat = fs.statSync(jsonlPath);
    const ageMs = Date.now() - stat.mtimeMs;
    // Consider active if written to in the last 2 hours (matches cc-experiment heuristic)
    return ageMs < 2 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/** Find the autoresearch working directory from config or fall back to ctx.cwd */
function resolveWorkDir(ctxCwd: string): string {
  try {
    const configPath = path.join(ctxCwd, "autoresearch.config.json");
    if (!fs.existsSync(configPath)) return ctxCwd;
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!config.workingDir) return ctxCwd;
    return path.isAbsolute(config.workingDir)
      ? config.workingDir
      : path.resolve(ctxCwd, config.workingDir);
  } catch {
    return ctxCwd;
  }
}

// ---------------------------------------------------------------------------
// Core publishing logic
// ---------------------------------------------------------------------------

/**
 * Push a single kept commit and the chain tip to rad.
 * Mirrors the cc-experiment auto-publish.sh logic:
 *   - Push chain tip to refs/heads/experiments/<slug> (force-push for ff safety)
 *   - This carries all reachable objects so publish-tape can resolve them
 */
async function pushKeptCommit(
  pi: ExtensionAPI,
  cwd: string,
  commitSha: string,
  sessionName: string | null,
): Promise<void> {
  // Resolve short SHA to full
  const shaResult = await pi.exec("git", ["rev-parse", "--verify", commitSha], { cwd, timeout: 5000 });
  if (shaResult.code !== 0) {
    console.error(`rad-experiment-hook: cannot resolve commit '${commitSha}'`);
    return;
  }
  const fullSha = shaResult.stdout.trim();

  // Push the specific commit under experiments/<oid> for rad storage
  const refspec = `+${fullSha}:refs/heads/experiments/${fullSha}`;
  const pushResult = await pi.exec("git", ["push", "rad", refspec], { cwd, timeout: 30000 });
  if (pushResult.code !== 0) {
    console.error(`rad-experiment-hook: failed to push commit ${fullSha.slice(0, 7)}: ${(pushResult.stderr || "").slice(0, 200)}`);
  }

  // Also push/update the session branch if we have a session name
  if (sessionName) {
    const slug = slugify(sessionName) || "session";
    const sessionRef = `refs/heads/experiments/${slug}`;
    const sessionPush = await pi.exec("git", ["push", "rad", `+${fullSha}:${sessionRef}`], { cwd, timeout: 30000 });
    if (sessionPush.code === 0) {
      console.log(`rad-experiment-hook: session branch ${sessionRef} → ${fullSha.slice(0, 7)}`);
    }
  }
}

/**
 * Pin a discard/crash commit to rad storage so publish-tape can find it later.
 * Discards are orphan (not reachable from chain tip) so they need explicit pinning.
 */
async function pinOrphanCommit(
  pi: ExtensionAPI,
  cwd: string,
  commitSha: string,
): Promise<void> {
  const shaResult = await pi.exec("git", ["rev-parse", "--verify", commitSha], { cwd, timeout: 5000 });
  if (shaResult.code !== 0) return; // Already reverted, commit may not exist
  const fullSha = shaResult.stdout.trim();

  const refspec = `+${fullSha}:refs/heads/experiments/${fullSha}`;
  await pi.exec("git", ["push", "rad", refspec], { cwd, timeout: 30000 }).catch(() => {
    // Best effort — don't block the loop
  });
}

/**
 * Push the autoresearch branch to rad so peers can see it.
 *
 * pi-autoresearch works on a branch like `autoresearch/<goal>-<date>`. Without
 * pushing this branch to rad, the experiments are only reachable via opaque
 * `refs/heads/experiments/<oid>` refs — invisible in the radicle web UI and
 * harder for peers to discover.
 *
 * This is a no-op when HEAD is detached or on a non-autoresearch branch.
 */
async function pushAutoresearchBranch(
  pi: ExtensionAPI,
  cwd: string,
): Promise<void> {
  const branchResult = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5000 });
  if (branchResult.code !== 0) return;
  const branch = branchResult.stdout.trim();
  if (!branch) return; // detached HEAD

  // Only push branches that look like autoresearch branches
  if (!branch.startsWith("autoresearch/")) return;

  const pushResult = await pi.exec("git", ["push", "rad", branch], { cwd, timeout: 30000 });
  if (pushResult.code === 0) {
    console.log(`rad-experiment-hook: pushed branch ${branch} to rad`);
  } else {
    // Force-push as fallback (branch may have been rewritten by discard/revert cycles)
    const forceResult = await pi.exec("git", ["push", "rad", `+${branch}`], { cwd, timeout: 30000 });
    if (forceResult.code === 0) {
      console.log(`rad-experiment-hook: force-pushed branch ${branch} to rad`);
    } else {
      console.error(`rad-experiment-hook: failed to push branch ${branch}: ${(forceResult.stderr || "").slice(0, 200)}`);
    }
  }
}

/**
 * Run publish-tape on the autoresearch.jsonl. Idempotent — skips entries
 * already tracked in .cc-experiment/published.json.
 */
async function runPublishTape(
  pi: ExtensionAPI,
  workDir: string,
): Promise<void> {
  const jsonlPath = path.join(workDir, "autoresearch.jsonl");
  if (!fs.existsSync(jsonlPath)) return;

  const indexPath = path.join(workDir, ".cc-experiment", "published.json");

  const args = ["publish-tape", jsonlPath, "--yes"];
  if (fs.existsSync(indexPath)) {
    args.push("--index", indexPath);
  }

  const result = await pi.exec("rad-experiment", args, { timeout: 60000 }).catch(() => null);
  if (result && result.code !== 0) {
    console.error(`rad-experiment-hook: publish-tape failed: ${(result.stderr || "").slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const state: HookState = {
    reg: {
      isRadicleRepo: false,
      repoId: null,
      tools: new Map(),
    },
    lastPublishTapeJsonl: null,
    pushedCommits: new Set(),
  };

  function isEnabled(): boolean {
    return state.reg.isRadicleRepo && hasTool(state.reg, "rad-experiment");
  }

  // Detect capabilities at session start
  pi.on("session_start", async (_event, _ctx) => {
    state.reg = await detectTools(pi, [
      { name: "rad-experiment" },
    ]);
  });

  // Re-detect on reload
  pi.on("resources_discover", async () => {
    state.reg = await detectTools(pi, [
      { name: "rad-experiment" },
    ]);
  });

  // -----------------------------------------------------------------------
  // Main hook: intercept log_experiment tool results
  // -----------------------------------------------------------------------
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "log_experiment") return;
    if (!isEnabled()) return;

    const details = event.details as LogDetails | undefined;
    if (!details) return;

    const { experiment, state: expState } = details;
    const workDir = resolveWorkDir(ctx.cwd);

    // Don't act if the autoresearch session is stale or missing
    if (!isActiveAutoresearchSession(workDir)) return;

    const commit = experiment.commit;

    switch (experiment.status) {
      case "keep": {
        // Push the kept commit + update session branch
        if (commit && commit !== "—" && !state.pushedCommits.has(commit)) {
          await pushKeptCommit(pi, workDir, commit, expState.metricName || null);
          state.pushedCommits.add(commit);
        }

        // Push the autoresearch branch to rad so peers can see it
        await pushAutoresearchBranch(pi, workDir);

        // Run publish-tape after every keep (idempotent, only publishes new entries)
        await runPublishTape(pi, workDir);
        break;
      }

      case "discard":
      case "crash":
      case "checks_failed": {
        // Pin orphan commit so publish-tape can resolve it if needed
        // (publish-tape skips discards but having them in rad storage is useful
        // for anyone who wants to inspect the full tape)
        if (commit && commit !== "—" && !state.pushedCommits.has(commit)) {
          await pinOrphanCommit(pi, workDir, commit);
          state.pushedCommits.add(commit);
        }
        break;
      }
    }
  });

  // -----------------------------------------------------------------------
  // Safety net: publish-tape on agent_end (mirrors cc-experiment Stop hook)
  // -----------------------------------------------------------------------
  pi.on("agent_end", async (_event, ctx) => {
    if (!isEnabled()) return;

    const workDir = resolveWorkDir(ctx.cwd);
    if (!isActiveAutoresearchSession(workDir)) return;

    const jsonlPath = path.join(workDir, "autoresearch.jsonl");
    if (!fs.existsSync(jsonlPath)) return;

    // Push the autoresearch branch as a safety net
    await pushAutoresearchBranch(pi, workDir);

    // Run publish-tape as a safety net (idempotent)
    await runPublishTape(pi, workDir);

    // Announce to network
    await pi.exec("rad", ["sync", "--announce"], { timeout: 15000 }).catch(() => {
      // Best effort
    });
  });
}
