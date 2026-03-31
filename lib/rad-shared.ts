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

export interface RadicleCapabilities {
  isRadicleRepo: boolean;
  radPlanInstalled: boolean;
  radContextInstalled: boolean;
  repoId: string | null;
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

export async function detectCapabilities(pi: ExtensionAPI): Promise<RadicleCapabilities> {
  const caps: RadicleCapabilities = {
    isRadicleRepo: false,
    radPlanInstalled: false,
    radContextInstalled: false,
    repoId: null,
  };

  const radResult = await pi.exec("rad", ["."], { timeout: 5000 });
  if (radResult.code !== 0) return caps;

  caps.isRadicleRepo = true;
  caps.repoId = radResult.stdout.trim();

  const [planResult, ctxResult] = await Promise.all([
    pi.exec("which", ["rad-plan"], { timeout: 3000 }),
    pi.exec("which", ["rad-context"], { timeout: 3000 }),
  ]);

  caps.radPlanInstalled = planResult.code === 0;
  caps.radContextInstalled = ctxResult.code === 0;

  return caps;
}

// --- Issue Operations ---

/**
 * List open issues, optionally filtering by label.
 * Returns parsed issue objects with full details.
 */
export async function listOpenIssues(pi: ExtensionAPI, labelFilter?: string[]): Promise<Issue[]> {
  const result = await pi.exec("rad", ["issue", "list", "--all"], { timeout: 10000 });
  if (result.code !== 0) return [];

  const lines = result.stdout.trim().split("\n").filter(l => l.trim());
  const issues: Issue[] = [];

  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{7,40})/);
    if (!match) continue;

    const issue = await getIssueDetails(pi, match[1]);
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
 * Get full details for a single issue.
 */
export async function getIssueDetails(pi: ExtensionAPI, issueId: string): Promise<Issue | null> {
  const result = await pi.exec("rad", ["issue", "show", issueId], { timeout: 5000 });
  if (result.code !== 0) return null;

  const output = result.stdout;
  const titleMatch = output.match(/title:\s*(.+)/i);
  const statusMatch = output.match(/status:\s*(\w+)/i);

  // Parse labels from output (format varies, try common patterns)
  const labelsMatch = output.match(/labels:\s*(.+)/i);
  const labels = labelsMatch
    ? labelsMatch[1].split(",").map(l => l.trim()).filter(Boolean)
    : [];

  // Extract description (everything after the header section)
  const descMatch = output.match(/\n\n([\s\S]*)/);
  const description = descMatch ? descMatch[1].trim() : "";

  return {
    id: issueId,
    title: titleMatch?.[1]?.trim() ?? "Untitled",
    status: statusMatch?.[1]?.trim() ?? "open",
    labels,
    assignees: [],
    description,
    discussion: { comments: {} },
  };
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
    .map(line => line.match(/^([0-9a-f]{7,40})/)?.[1])
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
  const result = await pi.exec("rad", ["issue", "label", issueId, "--remove", label], { timeout: 5000 });
  return result.code === 0;
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
