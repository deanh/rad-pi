/**
 * Shared utilities for Radicle extensions.
 * Common helpers used by rad-issue-loop, rad-plan-loop, and rad-orchestrator.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Types ---

export interface Issue {
  id: string;
  title: string;
  status: string;
  labels: string[];
  assignees: string[];
  description: string;
  discussion: {
    comments: Record<string, {
      body: string;
      edits: Array<{ body: string }>;
    }>;
  };
}

/**
 * @deprecated Use ToolRegistry + hasTool() instead. Kept for backward compatibility.
 */
export interface RadicleCapabilities {
  isRadicleRepo: boolean;
  radPlanInstalled: boolean;
  radContextInstalled: boolean;
  repoId: string | null;
}

// --- Tool Registry ---

/**
 * Capability level for a COB tool.
 *
 * - "none"  — tool not available (not a radicle repo, or rad not installed)
 * - "read"  — can read COBs via `rad cob` (always true when isRadicleRepo)
 * - "full"  — custom CLI installed (e.g. rad-plan, rad-context)
 */
export type ToolLevel = "none" | "read" | "full";

/**
 * A tool specification passed to detectTools().
 */
export interface ToolSpec {
  /** Binary name on $PATH (e.g. "rad-plan") */
  name: string;
}

/**
 * Resolved capability state for the current session.
 * Replaces the fixed RadicleCapabilities struct with an extensible registry.
 */
export interface ToolRegistry {
  isRadicleRepo: boolean;
  repoId: string | null;
  tools: Map<string, ToolLevel>;
}

/**
 * Check whether a tool is available at the given capability level.
 *
 * Usage:
 *   hasTool(reg, "rad-plan")           // full only (default)
 *   hasTool(reg, "rad-plan", "read")  // read or full
 */
export function hasTool(reg: ToolRegistry, name: string, minLevel: ToolLevel = "full"): boolean {
  const level = reg.tools.get(name) ?? "none";
  if (minLevel === "none") return true;
  if (minLevel === "read") return level === "read" || level === "full";
  return level === "full";
}

/**
 * Guard helper for command handlers. Returns true if all required tools are
 * available; otherwise notifies the user and returns false.
 *
 * @param installHints - optional map of tool name → install instructions
 *   (shown when the tool is missing)
 */
export function requireTools(
  reg: ToolRegistry,
  ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
  required: string[],
  installHints?: Record<string, string>,
): boolean {
  if (!reg.isRadicleRepo) {
    ctx.ui.notify("Not a Radicle repository", "error");
    return false;
  }
  for (const tool of required) {
    if (!hasTool(reg, tool)) {
      const hint = installHints?.[tool];
      ctx.ui.notify(
        `${tool} not installed.` + (hint ? ` ${hint}` : ` Install it and ensure it's on $PATH.`),
        "error",
      );
      return false;
    }
  }
  return true;
}

// --- Helpers ---

export function shortId(id: string): string {
  return id.slice(0, 7);
}

// --- Network ---

export async function syncNetwork(pi: ExtensionAPI): Promise<boolean> {
  const fetchResult = await pi.exec("rad", ["sync", "--fetch"], { timeout: 30000 });
  return fetchResult.code === 0;
}

export async function announceNetwork(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("rad", ["sync", "--announce"], { timeout: 15000 });
  return result.code === 0;
}

// --- Capability Detection ---

/**
 * Detect Radicle repo status and tool availability.
 *
 * Each tool spec names a CLI binary. If the binary is on $PATH, the tool
 * gets level "full"; otherwise "none".
 *
 * All `which` checks run in parallel.
 */
export async function detectTools(
  pi: ExtensionAPI,
  toolSpecs: ToolSpec[],
): Promise<ToolRegistry> {
  const reg: ToolRegistry = {
    isRadicleRepo: false,
    repoId: null,
    tools: new Map(),
  };

  const radResult = await pi.exec("rad", ["."], { timeout: 5000 });
  if (radResult.code !== 0) {
    // Not a radicle repo — all tools are "none"
    for (const spec of toolSpecs) reg.tools.set(spec.name, "none");
    return reg;
  }

  reg.isRadicleRepo = true;
  reg.repoId = radResult.stdout.trim();

  const checks = await Promise.all(
    toolSpecs.map(async (spec) => {
      const result = await pi.exec("which", [spec.name], { timeout: 3000 });
      return [spec.name, result.code === 0 ? "full" as const : "none" as const] as const;
    }),
  );

  for (const [name, level] of checks) {
    reg.tools.set(name, level);
  }

  return reg;
}

/**
 * @deprecated Use detectTools() instead. Kept for backward compatibility.
 */
export async function detectCapabilities(pi: ExtensionAPI): Promise<RadicleCapabilities> {
  const reg = await detectTools(pi, [
    { name: "rad-plan" },
    { name: "rad-context" },
  ]);

  return {
    isRadicleRepo: reg.isRadicleRepo,
    radPlanInstalled: hasTool(reg, "rad-plan"),
    radContextInstalled: hasTool(reg, "rad-context"),
    repoId: reg.repoId,
  };
}

// --- Issue Operations ---

/**
 * Get the Radicle repository ID for the current working directory.
 */
async function getRepoId(pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("rad", ["."], { timeout: 5000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * List open issues, optionally filtering by label.
 * Uses `rad cob list` + `rad cob show` for reliable JSON parsing.
 */
export async function listOpenIssues(pi: ExtensionAPI, labelFilter?: string[]): Promise<Issue[]> {
  const repoId = await getRepoId(pi);
  if (!repoId) return [];

  const listResult = await pi.exec("rad", ["cob", "list", "--repo", repoId, "--type", "xyz.radicle.issue"], { timeout: 10000 });
  if (listResult.code !== 0) return [];

  const issueIds = listResult.stdout.trim().split("\n").filter(l => l.trim());
  const issues: Issue[] = [];

  for (const id of issueIds) {
    const issue = await getIssueDetails(pi, id);
    if (!issue) continue;
    if (issue.status !== "open") continue;

    // Apply label filter if provided
    if (labelFilter && labelFilter.length > 0) {
      if (!issue.labels.some(l => labelFilter.includes(l))) continue;
    }

    issues.push(issue);
  }

  return issues;
}

/**
 * Get full details for a single issue using JSON COB output.
 * Accepts both short and full IDs; resolves short IDs via `rad cob list`.
 */
export async function getIssueDetails(pi: ExtensionAPI, issueId: string): Promise<Issue | null> {
  const repoId = await getRepoId(pi);
  if (!repoId) return null;

  // Resolve short IDs to full IDs
  let fullId = issueId;
  if (issueId.length < 40) {
    const listResult = await pi.exec("rad", ["cob", "list", "--repo", repoId, "--type", "xyz.radicle.issue"], { timeout: 10000 });
    if (listResult.code !== 0) return null;
    const match = listResult.stdout.trim().split("\n").find(l => l.startsWith(issueId));
    if (!match) return null;
    fullId = match.trim();
  }

  const result = await pi.exec("rad", ["cob", "show", "--repo", repoId, "--type", "xyz.radicle.issue", "--object", fullId], { timeout: 5000 });
  if (result.code !== 0) return null;

  try {
    const cob = JSON.parse(result.stdout.trim());

    // Extract description from the first comment in the thread
    let description = "";
    const comments = cob.thread?.comments ?? {};
    const firstCommentId = cob.thread?.timeline?.[0];
    if (firstCommentId && comments[firstCommentId]) {
      description = comments[firstCommentId].body ?? "";
    }

    return {
      id: fullId,
      title: cob.title ?? "Untitled",
      status: cob.state?.status ?? "open",
      labels: cob.labels ?? [],
      assignees: cob.assignees ?? [],
      description,
      discussion: { comments },
    };
  } catch {
    return null;
  }
}

/**
 * Check if an issue already has a linked plan.
 * Uses rad-plan list and checks relatedIssues.
 */
export async function issueHasLinkedPlan(pi: ExtensionAPI, issueId: string): Promise<boolean> {
  const result = await pi.exec("rad-plan", ["list", "--all"], { timeout: 10000 });
  if (result.code !== 0) return false;

  // Parse plan list and check each for the issue link
  const planIds = result.stdout.trim().split("\n")
    .map(line => line.match(/\b([0-9a-f]{7,40})\b/)?.[1])
    .filter((id): id is string => !!id);

  for (const planId of planIds) {
    const showResult = await pi.exec("rad-plan", ["show", planId, "--json"], { timeout: 5000 });
    if (showResult.code !== 0) continue;

    try {
      const plan = JSON.parse(showResult.stdout.trim());
      const relatedIssues: string[] = plan.relatedIssues ?? plan.related_issues ?? [];
      // Match by prefix (short IDs)
      if (relatedIssues.some(ri => ri.startsWith(issueId) || issueId.startsWith(ri.slice(0, 7)))) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

// --- Label Operations ---

/**
 * Add a label to an issue.
 */
export async function addLabel(pi: ExtensionAPI, issueId: string, label: string): Promise<boolean> {
  const result = await pi.exec("rad", ["issue", "label", issueId, "--add", label], { timeout: 5000 });
  return result.code === 0;
}

/**
 * Remove a label from an issue.
 */
export async function removeLabel(pi: ExtensionAPI, issueId: string, label: string): Promise<boolean> {
  const result = await pi.exec("rad", ["issue", "label", issueId, "--delete", label], { timeout: 5000 });
  return result.code === 0;
}

/**
 * Swap labels on an issue: add one label, then remove another.
 * Uses a delay between operations to avoid Radicle CRDT storage contention,
 * and verifies removal via getIssueDetails() to handle cases where the CLI
 * returns an error but the operation actually succeeded.
 */
export async function swapLabels(
  pi: ExtensionAPI,
  issueId: string,
  addLbl: string,
  removeLbl: string,
  opts?: { maxRetries?: number; delayMs?: number },
): Promise<{ addOk: boolean; removeOk: boolean }> {
  const maxRetries = opts?.maxRetries ?? 2;
  const delayMs = opts?.delayMs ?? 1000;

  // Step 1: Add the new label with retries
  let addOk = false;
  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs));
    addOk = await addLabel(pi, issueId, addLbl);
    if (addOk) break;
  }

  // Step 2: Delay to let CRDT store flush before the remove
  await new Promise(r => setTimeout(r, delayMs));

  // Step 3: Remove the old label with retries + verification
  let removeOk = false;
  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs));
    const cliOk = await removeLabel(pi, issueId, removeLbl);
    if (cliOk) {
      removeOk = true;
      break;
    }
    // CLI failed — verify whether the label is actually gone
    const issue = await getIssueDetails(pi, issueId);
    if (issue && !issue.labels.includes(removeLbl)) {
      removeOk = true;
      break;
    }
  }

  return { addOk, removeOk };
}

// --- Git Operations ---

export async function returnToMain(pi: ExtensionAPI): Promise<void> {
  await pi.exec("git", ["checkout", "main"], { timeout: 10000 });
  await pi.exec("git", ["pull"], { timeout: 10000 });
}

export async function createFeatureBranch(pi: ExtensionAPI, name: string): Promise<boolean> {
  const result = await pi.exec("git", ["checkout", "-b", name], { timeout: 10000 });
  return result.code === 0;
}

export async function commitChanges(pi: ExtensionAPI, message: string): Promise<string | null> {
  const addResult = await pi.exec("git", ["add", "-A"], { timeout: 5000 });
  if (addResult.code !== 0) return null;

  const commitResult = await pi.exec("git", ["commit", "-m", message], { timeout: 10000 });
  if (commitResult.code !== 0) return null;

  const shaResult = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
  return shaResult.code === 0 ? shaResult.stdout.trim() : null;
}

export async function pushPatch(pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("git", ["push", "rad", "HEAD:refs/patches"], { timeout: 30000 });
  if (result.code !== 0) return null;

  const match = (result.stdout + result.stderr).match(/([0-9a-f]{40})/);
  return match ? match[1] : null;
}

export async function getModifiedFilesSince(pi: ExtensionAPI, ref: string): Promise<string[]> {
  const result = await pi.exec("git", ["diff", "--name-only", ref], { timeout: 5000 });
  if (result.code !== 0) return [];
  return result.stdout.trim().split("\n").filter(l => l.length > 0);
}
