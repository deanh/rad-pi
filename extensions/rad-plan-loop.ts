/**
 * rad-plan-loop: Watches for issues with a configurable label (default: "TODO"),
 * creates Plan COBs from them via LLM analysis, and optionally auto-approves.
 *
 * This is Loop 1 of the two-loop architecture:
 *   Loop 1 (this): issue → plan (human reviews/edits → approves)
 *   Loop 2 (rad-orchestrator --loop): approved plan → execution → patch
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import {
  type Issue,
  type ToolRegistry,
  shortId,
  syncNetwork,
  announceNetwork,
  detectTools,
  hasTool,
  requireTools,
  listOpenIssues,
  issueHasLinkedPlan,
  swapLabels,
} from "../lib/rad-shared.ts";

// --- Types ---

interface PlanLoopState {
  reg: ToolRegistry;
  isRunning: boolean;
  cooldownMs: number;
  planLabel: string;
  plannedLabel: string;
  processedCount: number;
}

interface PlannedTask {
  subject: string;
  description: string;
  estimate: string;
  affectedFiles: string[];
  blocked_by?: string[];
}

interface PlanSpec {
  title: string;
  description: string;
  tasks: PlannedTask[];
}

// --- Constants ---

const DEFAULT_COOLDOWN_MS = 30000;
const DEFAULT_PLAN_LABEL = "TODO";
const DEFAULT_PLANNED_LABEL = "ready";

const PLANNING_PROMPT = `You are a senior software engineer creating an implementation plan from a Radicle issue. Given the issue details and codebase context, produce a structured plan broken into discrete tasks.

Output ONLY valid JSON matching this schema — no markdown fences, no commentary:

{
  "title": "Plan title (concise, action-oriented)",
  "description": "Overview of the implementation approach — what will be built, key architectural decisions, and overall strategy",
  "tasks": [
    {
      "subject": "Task title (imperative mood, e.g. 'Add retry middleware')",
      "description": "Detailed description including: what to implement, acceptance criteria, edge cases to handle. Be specific enough that a developer could implement this without further context.",
      "estimate": "Time estimate (e.g. '2h', '4h', '1d')",
      "affectedFiles": ["src/exact/file/paths.ts", "tests/exact/test/paths.test.ts"],
      "blocked_by": []
    }
  ]
}

Rules:
- DEFAULT TO A SINGLE TASK. Most issues — bug fixes, small features, config changes, label tweaks — should produce exactly one task. A single coherent commit is better than fragmented worktree overhead for focused changes.
- Only decompose into multiple tasks when ALL of these apply:
  (a) The work spans genuinely independent subsystems (e.g. backend API + frontend UI + infra config)
  (b) Parallel execution across independent files would provide a real speedup
  (c) The scope exceeds ~300 lines of changes across 5+ files
- Each task should be independently implementable (2-8 hours of work)
- affectedFiles must be REAL file paths from the codebase — explore before guessing
- Use blocked_by to express task ordering: reference task indices as "task-0", "task-1", etc.
- Include tests in the same task as the implementation unless the test suite is in a separate subsystem
- Keep tasks scoped: one logical change per task
- Order tasks by dependency (tasks with no blockers first)`;

// --- Plan Creation ---

async function createPlanFromIssue(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  issue: Issue,
): Promise<string | null> {
  // 1. Gather codebase context
  ctx.ui.notify(`Analyzing issue and codebase for plan...`, "info");

  // Get a directory listing for context
  const treeResult = await pi.exec("find", [".", "-type", "f", "-not", "-path", "./.git/*", "-not", "-path", "./node_modules/*", "-not", "-path", "./target/*"], { timeout: 10000 });
  const fileTree = treeResult.code === 0 ? treeResult.stdout.trim() : "(could not list files)";

  // Get issue full details
  const issueShowResult = await pi.exec("rad", ["issue", "show", issue.id], { timeout: 5000 });
  const issueFullText = issueShowResult.code === 0 ? issueShowResult.stdout.trim() : issue.description;

  // 2. Call LLM to generate plan
  // Prefer session model first (handles custom API endpoints/configurations)
  let model = ctx.model;

  // Fall back to specific Claude models if no session model
  if (!model) {
    model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5-20250514")
      ?? ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
    if (model) {
      ctx.ui.notify(`rad-plan-loop: using ${model.id} for planning`, "info");
    }
  }

  if (!model) {
    ctx.ui.notify("rad-plan-loop: no model available for plan creation", "error");
    return null;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(`rad-plan-loop: no API key for ${model.provider}`, "error");
    return null;
  }

  try {
    const response = await complete(
      model,
      {
        messages: [{
          role: "user" as const,
          content: [{
            type: "text" as const,
            text: `${PLANNING_PROMPT}\n\n<issue>\nTitle: ${issue.title}\n\n${issueFullText}\n</issue>\n\n<codebase-files>\n${fileTree}\n</codebase-files>`,
          }],
          timestamp: Date.now(),
        }],
      },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192 },
    );

    const responseText = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (!responseText) {
      ctx.ui.notify("rad-plan-loop: LLM returned empty response", "error");
      return null;
    }

    // Parse response
    const jsonText = responseText.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/, "$1").trim();
    let planSpec: PlanSpec;
    try {
      planSpec = JSON.parse(jsonText) as PlanSpec;
    } catch {
      ctx.ui.notify(`rad-plan-loop: failed to parse plan JSON: ${jsonText.slice(0, 200)}`, "error");
      return null;
    }

    if (!planSpec.title || !planSpec.tasks || planSpec.tasks.length === 0) {
      ctx.ui.notify("rad-plan-loop: plan missing title or tasks", "error");
      return null;
    }

    // 3. Create Plan COB
    ctx.ui.notify(`Creating plan: "${planSpec.title}" (${planSpec.tasks.length} tasks)`, "info");

    const createResult = await pi.exec(
      "rad-plan",
      ["open", planSpec.title, "--description", planSpec.description],
      { timeout: 10000 },
    );

    if (createResult.code !== 0) {
      ctx.ui.notify(`rad-plan-loop: plan creation failed: ${createResult.stderr}`, "error");
      return null;
    }

    // Extract plan ID
    const planIdMatch = (createResult.stdout + createResult.stderr).match(/([0-9a-f]{40})/);
    if (!planIdMatch) {
      ctx.ui.notify("rad-plan-loop: could not extract plan ID from output", "error");
      return null;
    }
    const planId = planIdMatch[1];

    // 4. Add tasks
    // Build a map of "task-N" references to actual task IDs for blocked_by resolution
    const taskIdMap = new Map<string, string>();

    for (let i = 0; i < planSpec.tasks.length; i++) {
      const task = planSpec.tasks[i];
      const addArgs = [
        "task", "add", planId, task.subject,
        "--description", task.description,
        "--estimate", task.estimate,
      ];

      if (task.affectedFiles && task.affectedFiles.length > 0) {
        addArgs.push("--files", task.affectedFiles.join(","));
      }

      const addResult = await pi.exec("rad-plan", addArgs, { timeout: 10000 });

      if (addResult.code !== 0) {
        ctx.ui.notify(`rad-plan-loop: failed to add task "${task.subject}": ${addResult.stderr}`, "warning");
        continue;
      }

      // Extract task ID
      const taskIdMatch = (addResult.stdout + addResult.stderr).match(/([0-9a-f]{40})/);
      if (taskIdMatch) {
        taskIdMap.set(`task-${i}`, taskIdMatch[1]);
        ctx.ui.notify(`  + Task ${i + 1}: ${task.subject} (${task.estimate})`, "info");
      }
    }

    // 5. Link plan to issue
    await pi.exec("rad-plan", ["link", planId, "--issue", issue.id], { timeout: 10000 });
    ctx.ui.notify(`Linked plan to issue ${shortId(issue.id)}`, "info");

    return planId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`rad-plan-loop: planning failed: ${message}`, "error");
    return null;
  }
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const state: PlanLoopState = {
    reg: {
      isRadicleRepo: false,
      repoId: null,
      tools: new Map(),
    },
    isRunning: false,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    planLabel: DEFAULT_PLAN_LABEL,
    plannedLabel: DEFAULT_PLANNED_LABEL,
    processedCount: 0,
  };

  // Detect capabilities
  pi.on("session_start", async (_event, ctx) => {
    state.reg = await detectTools(pi, [
      { name: "rad-plan" },
    ]);

    if (hasTool(state.reg, "rad-plan")) {
      ctx.ui.setStatus("rad-plan-loop", "ready");
    }
  });

  // /rad-plan-loop command
  pi.registerCommand("rad-plan-loop", {
    description: "Watch for issues with a label and create Plan COBs from them",
    handler: async (args, ctx) => {
      if (!requireTools(state.reg, ctx, ["rad-plan"], {
        "rad-plan": "Install from: rad clone rad:z4L8L9ctRYn2bcPuUT4GRz7sggG1v",
      })) return;

      // Parse arguments
      const argList = args?.trim().split(/\s+/) ?? [];
      const autoApprove = argList.includes("--auto-approve");
      const oneshot = argList.includes("--oneshot");
      const status = argList.includes("--status");
      const stop = argList.includes("--stop");

      // Configurable labels
      const planLabelIdx = argList.indexOf("--plan-label");
      if (planLabelIdx >= 0 && argList[planLabelIdx + 1]) {
        state.planLabel = argList[planLabelIdx + 1];
      }

      const plannedLabelIdx = argList.indexOf("--planned-label");
      if (plannedLabelIdx >= 0 && argList[plannedLabelIdx + 1]) {
        state.plannedLabel = argList[plannedLabelIdx + 1];
      }

      // Max plans per run
      const maxIdx = argList.indexOf("--max-plans");
      const maxPlans = maxIdx >= 0 ? parseInt(argList[maxIdx + 1] ?? "0", 10) : 0;

      if (status) {
        ctx.ui.notify(
          `Plan loop: ${state.isRunning ? "running" : "stopped"}\n` +
          `Plans created: ${state.processedCount}\n` +
          `Watch label: ${state.planLabel}\n` +
          `Auto-approve: ${autoApprove}`,
          "info",
        );
        return;
      }

      if (stop) {
        state.isRunning = false;
        ctx.ui.notify("Plan loop stopped", "info");
        ctx.ui.setStatus("rad-plan-loop", "stopped");
        return;
      }

      // Start the loop
      state.isRunning = true;
      state.processedCount = 0;
      ctx.ui.setStatus("rad-plan-loop", `running (watching '${state.planLabel}')`);
      ctx.ui.notify(
        `Starting plan loop...\n` +
        `  Watch label: ${state.planLabel}\n` +
        `  Planned label: ${state.plannedLabel}\n` +
        `  Auto-approve: ${autoApprove}\n` +
        `  Max plans: ${maxPlans || "unlimited"}`,
        "info",
      );

      let iterationCount = 0;
      while (state.isRunning) {
        iterationCount++;
        ctx.ui.notify(`\n=== Plan Loop Iteration ${iterationCount} ===`, "info");

        // 1. Sync
        ctx.ui.notify("Syncing with network...", "info");
        if (!await syncNetwork(pi)) {
          ctx.ui.notify("Sync failed, retrying...", "warning");
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // 2. Find issues with the plan label
        const issues = await listOpenIssues(pi, [state.planLabel]);

        if (issues.length === 0) {
          ctx.ui.notify(`No issues with '${state.planLabel}' label found.`, "info");
          if (oneshot) break;
          ctx.ui.notify(`Waiting ${state.cooldownMs / 1000}s before next check...`, "info");
          await new Promise(r => setTimeout(r, state.cooldownMs));
          continue;
        }

        ctx.ui.notify(`Found ${issues.length} issue(s) with '${state.planLabel}' label`, "info");

        // 3. Filter: skip issues that already have a linked plan (idempotency)
        const candidates: Issue[] = [];
        for (const issue of issues) {
          const hasLinked = await issueHasLinkedPlan(pi, issue.id);
          if (hasLinked) {
            ctx.ui.notify(`  Skipping ${shortId(issue.id)}: already has a linked plan`, "info");
            // Clean up stale label if issue already has a plan but still has TODO label
            if (issue.labels.includes(state.planLabel)) {
              ctx.ui.notify(`  Cleaning stale '${state.planLabel}' label from ${shortId(issue.id)}`, "info");
              await swapLabels(pi, issue.id, state.plannedLabel, state.planLabel);
            }
          } else {
            candidates.push(issue);
          }
        }

        if (candidates.length === 0) {
          ctx.ui.notify("All labeled issues already have plans.", "info");
          if (oneshot) break;
          ctx.ui.notify(`Waiting ${state.cooldownMs / 1000}s before next check...`, "info");
          await new Promise(r => setTimeout(r, state.cooldownMs));
          continue;
        }

        // 4. Process each candidate
        for (const issue of candidates) {
          if (!state.isRunning) break;
          if (maxPlans > 0 && state.processedCount >= maxPlans) {
            ctx.ui.notify(`Max plans (${maxPlans}) reached, stopping.`, "info");
            state.isRunning = false;
            break;
          }

          ctx.ui.notify(`\n--- Creating plan for ${shortId(issue.id)}: "${issue.title}" ---`, "info");

          // Create the plan
          const planId = await createPlanFromIssue(pi, ctx, issue);

          if (!planId) {
            ctx.ui.notify(`Failed to create plan for ${shortId(issue.id)}`, "error");
            continue;
          }

          // Set plan status
          const planStatus = autoApprove ? "approved" : "draft";
          await pi.exec("rad-plan", ["status", planId, planStatus], { timeout: 10000 });

          // Swap labels: add ready, then remove TODO with delay + verification
          const { removeOk } = await swapLabels(pi, issue.id, state.plannedLabel, state.planLabel);
          if (!removeOk) {
            ctx.ui.notify(
              `Label swap: could not remove '${state.planLabel}' from ${shortId(issue.id)}. ` +
              `Issue has both labels — fix manually: rad issue label ${shortId(issue.id)} --delete ${state.planLabel}`,
              "error",
            );
          }

          // Announce
          await announceNetwork(pi);

          state.processedCount++;

          ctx.ui.notify(
            `Plan created: ${shortId(planId)}\n` +
            `  Status: ${planStatus}\n` +
            `  Issue: ${shortId(issue.id)} (label: '${state.planLabel}' → '${state.plannedLabel}')\n` +
            (autoApprove
              ? `  Auto-approved — ready for /rad-orchestrate --loop`
              : `  Review with: rad-plan show ${shortId(planId)}\n  Approve with: rad-plan status ${shortId(planId)} approved`),
            "info",
          );
        }

        if (oneshot) break;

        ctx.ui.notify(`Waiting ${state.cooldownMs / 1000}s before next check...`, "info");
        await new Promise(r => setTimeout(r, state.cooldownMs));
      }

      state.isRunning = false;
      ctx.ui.setStatus("rad-plan-loop", "ready");
      ctx.ui.notify(
        `Plan loop ended. Created ${state.processedCount} plan(s).`,
        "info",
      );
    },
  });

  // /rad-plan-check — quick check for plannable issues
  pi.registerCommand("rad-plan-check", {
    description: "Check for issues ready for planning",
    handler: async (_args, ctx) => {
      if (!state.reg.isRadicleRepo) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      await syncNetwork(pi);

      const todoIssues = await listOpenIssues(pi, [state.planLabel]);
      const readyIssues = await listOpenIssues(pi, [state.plannedLabel]);

      ctx.ui.notify(`Issues with '${state.planLabel}': ${todoIssues.length}`, "info");
      for (const i of todoIssues) {
        ctx.ui.notify(`  ○ ${shortId(i.id)}: ${i.title}`, "info");
      }

      ctx.ui.notify(`Issues with '${state.plannedLabel}': ${readyIssues.length}`, "info");
      for (const i of readyIssues) {
        ctx.ui.notify(`  ✓ ${shortId(i.id)}: ${i.title}`, "info");
      }

      // Check for approved plans
      if (hasTool(state.reg, "rad-plan")) {
        const planResult = await pi.exec("rad-plan", ["list", "--status", "approved"], { timeout: 10000 });
        if (planResult.code === 0) {
          const approvedPlans = planResult.stdout.trim().split("\n").filter(l => l.trim());
          ctx.ui.notify(`Approved plans (ready for execution): ${approvedPlans.length}`, "info");
          for (const line of approvedPlans.slice(0, 5)) {
            ctx.ui.notify(`  ◉ ${line.trim()}`, "info");
          }
        }
      }
    },
  });
}
