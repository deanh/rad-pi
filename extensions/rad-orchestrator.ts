import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { syncNetwork, announceNetwork, shortId as sharedShortId } from "../lib/rad-shared.ts";

// --- Constants ---

const MAX_CONCURRENCY = 4;

// --- Types ---

interface PlanTask {
  id: string;
  subject: string;
  description: string;
  estimate: string;
  affectedFiles: string[];
  linkedCommit: string | null;
  blocked_by?: string[];
}

interface Plan {
  title: string;
  status: string;
  tasks: PlanTask[];
  relatedIssues: string[];
  relatedPatches: string[];
  thread: {
    comments: Record<string, {
      body: string;
      edits: Array<{ body: string }>;
    }>;
  };
}

interface WorkerDoneTask {
  task: PlanTask;
  commitSha: string;
}

interface PlanState {
  plan: Plan;
  completed: PlanTask[];
  workerDone: WorkerDoneTask[];
  inProgress: PlanTask[];
  ready: PlanTask[];
  blockedDep: PlanTask[];
  blockedFile: PlanTask[];
  allComplete: boolean;
  contextFeedback: ContextFeedback[];
}

interface ContextFeedback {
  contextId: string;
  taskId: string | null;
  constraints: string[];
  friction: string[];
  openItems: string[];
  learnings: { repo: string[]; code: Array<{ path: string; line: number; finding: string }> };
  filesTouched: string[];
}

interface WorkerResult {
  taskId: string;
  taskSubject: string;
  success: boolean;
  exitCode: number;
  stderr: string;
  worktreePath: string;
  turns: number;
  cost: number;
  commitSha: string | null;
}

interface WorkerProgress {
  taskId: string;
  taskSubject: string;
  status: "starting" | "running" | "done" | "failed";
  turns: number;
  cost: number;
  currentTool: string | null;
  lastActivity: string | null;
  startTime: number;
}

interface AgentConfig {
  name: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

// --- State ---

interface OrchestratorState {
  isRadicleRepo: boolean;
  radPlanInstalled: boolean;
  radContextInstalled: boolean;
  repoId: string | null;
}

// --- Helpers ---

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}

function shortId(id: string): string {
  return id.slice(0, 7);
}

function getCommentBodies(plan: Plan): string[] {
  const bodies: string[] = [];
  for (const comment of Object.values(plan.thread?.comments ?? {})) {
    // Use the latest edit body
    const edits = comment.edits;
    if (edits && edits.length > 0) {
      bodies.push(edits[edits.length - 1].body);
    } else {
      bodies.push(comment.body);
    }
  }
  return bodies;
}

function findClaimedTaskIds(plan: Plan): Set<string> {
  const claimed = new Set<string>();
  for (const body of getCommentBodies(plan)) {
    const match = body.match(/^CLAIM task:(\S+)/);
    if (match) claimed.add(match[1]);
  }
  return claimed;
}

function findDoneTaskCommits(plan: Plan): Map<string, string> {
  const done = new Map<string, string>();
  for (const body of getCommentBodies(plan)) {
    const match = body.match(/^DONE task:(\S+) commit:(\S+)/);
    if (match) done.set(match[1], match[2]);
  }
  return done;
}

function findSignalFiles(plan: Plan): Map<string, string[]> {
  const signals = new Map<string, string[]>();
  for (const body of getCommentBodies(plan)) {
    const match = body.match(/^SIGNAL task:(\S+) files-added:(.+)/);
    if (match) {
      const existing = signals.get(match[1]) ?? [];
      existing.push(...match[2].split(",").map(f => f.trim()));
      signals.set(match[1], existing);
    }
  }
  return signals;
}

function getEffectiveFiles(task: PlanTask, signals: Map<string, string[]>): string[] {
  const base = task.affectedFiles ?? [];
  const extra = signals.get(shortId(task.id)) ?? signals.get(task.id) ?? [];
  return [...new Set([...base, ...extra])];
}

function filesOverlap(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  return b.some(f => setA.has(f));
}

// --- Agent Loading ---

function loadAgentConfig(agentPath: string): AgentConfig | null {
  if (!fs.existsSync(agentPath)) return null;
  const content = fs.readFileSync(agentPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
  if (!frontmatter.name) return null;
  const tools = frontmatter.tools?.split(",").map((t: string) => t.trim()).filter(Boolean);
  return {
    name: frontmatter.name,
    model: frontmatter.model,
    tools: tools && tools.length > 0 ? tools : undefined,
    systemPrompt: body,
  };
}

function writePromptToTempFile(name: string, prompt: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pi-orchestrator-"));
  const filePath = path.join(tmpDir, `prompt-${name}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

// --- Plan Analysis ---

async function loadPlan(pi: ExtensionAPI, planId: string): Promise<Plan | null> {
  const result = await pi.exec("rad-plan", ["show", planId, "--json"], { timeout: 10000 });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout.trim()) as Plan;
  } catch {
    return null;
  }
}

async function analyzePlan(pi: ExtensionAPI, planId: string): Promise<PlanState | null> {
  const plan = await loadPlan(pi, planId);
  if (!plan) return null;

  const claimed = findClaimedTaskIds(plan);
  const doneCommits = findDoneTaskCommits(plan);
  const signals = findSignalFiles(plan);

  const completed: PlanTask[] = [];
  const workerDone: WorkerDoneTask[] = [];
  const inProgress: PlanTask[] = [];
  const ready: PlanTask[] = [];
  const blockedDep: PlanTask[] = [];
  const blockedFile: PlanTask[] = [];

  // First pass: categorize by completion and dependency
  const completedIds = new Set<string>();
  for (const task of plan.tasks) {
    if (task.linkedCommit) {
      completed.push(task);
      completedIds.add(task.id);
      completedIds.add(shortId(task.id));
    }
  }

  // Second pass: find worker-done tasks (DONE comment but no linkedCommit)
  const workerDoneIds = new Set<string>();
  for (const task of plan.tasks) {
    if (task.linkedCommit) continue;
    const sha = doneCommits.get(shortId(task.id)) ?? doneCommits.get(task.id);
    if (sha) {
      workerDone.push({ task, commitSha: sha });
      workerDoneIds.add(task.id);
      workerDoneIds.add(shortId(task.id));
      // Treat worker-done as completed for dependency resolution
      completedIds.add(task.id);
      completedIds.add(shortId(task.id));
    }
  }

  for (const task of plan.tasks) {
    if (task.linkedCommit) continue;
    if (workerDoneIds.has(task.id) || workerDoneIds.has(shortId(task.id))) continue;

    // Check if claimed (in progress)
    if (claimed.has(shortId(task.id)) || claimed.has(task.id)) {
      inProgress.push(task);
      continue;
    }

    // Check dependencies
    const deps = task.blocked_by ?? [];
    const depsUnmet = deps.some(dep => !completedIds.has(dep) && !completedIds.has(shortId(dep)));
    if (depsUnmet) {
      blockedDep.push(task);
      continue;
    }

    // Check file conflicts with in-progress tasks
    const candidateFiles = getEffectiveFiles(task, signals);
    const hasConflict = inProgress.some(ip => {
      const ipFiles = getEffectiveFiles(ip, signals);
      return filesOverlap(candidateFiles, ipFiles);
    });

    if (hasConflict) {
      blockedFile.push(task);
    } else {
      ready.push(task);
    }
  }

  // Load context feedback
  const contextFeedback = await loadContextFeedback(pi, planId);

  return {
    plan,
    completed,
    workerDone,
    inProgress,
    ready,
    blockedDep,
    blockedFile,
    allComplete: (completed.length + workerDone.length) === plan.tasks.length,
    contextFeedback,
  };
}

// --- Context Feedback ---

async function loadContextFeedback(pi: ExtensionAPI, planId: string): Promise<ContextFeedback[]> {
  const whichResult = await pi.exec("which", ["rad-context"], { timeout: 3000 });
  if (whichResult.code !== 0) return [];

  const listResult = await pi.exec("rad-context", ["list"], { timeout: 10000 });
  if (listResult.code !== 0) return [];

  const contextIds = listResult.stdout.trim().split("\n")
    .map(line => line.match(/^([0-9a-f]{7,40})/)?.[1])
    .filter((id): id is string => !!id);

  const feedback: ContextFeedback[] = [];
  for (const contextId of contextIds) {
    const showResult = await pi.exec("rad-context", ["show", contextId, "--json"], { timeout: 5000 });
    if (showResult.code !== 0) continue;

    try {
      const ctx = JSON.parse(showResult.stdout.trim());
      const relatedPlans: string[] = ctx.relatedPlans ?? [];
      const isRelevant = relatedPlans.some(p => p.startsWith(planId) || planId.startsWith(p.slice(0, 7)));
      if (!isRelevant) continue;

      feedback.push({
        contextId,
        taskId: ctx.taskId ?? null,
        constraints: ctx.constraints ?? [],
        friction: ctx.friction ?? [],
        openItems: ctx.openItems ?? [],
        learnings: ctx.learnings ?? { repo: [], code: [] },
        filesTouched: ctx.filesTouched ?? [],
      });
    } catch {
      continue;
    }
  }
  return feedback;
}

// --- Failure Logging ---

function writeFailureLog(planId: string, result: WorkerResult): string {
  const dir = path.join(require("node:os").tmpdir(), "rad-orchestrator", shortId(planId));
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${shortId(result.taskId)}.log`);
  const lines = [
    `Task: ${result.taskId}`,
    `Subject: ${result.taskSubject}`,
    `Exit code: ${result.exitCode}`,
    `Turns: ${result.turns}`,
    `Cost: ${result.cost > 0 ? `$${result.cost.toFixed(4)}` : "n/a"}`,
    `Worktree: ${result.worktreePath}`,
    `Timestamp: ${new Date().toISOString()}`,
    "",
    "--- stderr ---",
    result.stderr || "(empty)",
  ];
  fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
  return logPath;
}

// --- Worktree Lifecycle ---

async function createWorktree(pi: ExtensionAPI, cwd: string, taskId: string, slug: string): Promise<string> {
  const name = `worktree-${shortId(taskId)}-${slug}`;
  const worktreePath = path.resolve(cwd, "..", name);
  const branch = `task/${shortId(taskId)}`;
  const result = await pi.exec("git", ["worktree", "add", worktreePath, "-b", branch], { timeout: 15000 });
  if (result.code !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }
  return worktreePath;
}

async function removeWorktree(pi: ExtensionAPI, worktreePath: string): Promise<void> {
  await pi.exec("git", ["worktree", "remove", worktreePath, "--force"], { timeout: 15000 });
}

async function teardownWorktree(pi: ExtensionAPI, taskId: string, worktreePath: string): Promise<void> {
  await removeWorktree(pi, worktreePath);
  const branch = `task/${shortId(taskId)}`;
  await pi.exec("git", ["branch", "-D", branch], { timeout: 10000 });
}

// --- Subagent Spawning ---

function spawnWorker(
  agent: AgentConfig,
  worktreePath: string,
  planId: string,
  task: PlanTask,
  onProgress?: (update: Partial<WorkerProgress>) => void,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (agent.model) args.push("--model", agent.model);
    if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;

    const result: WorkerResult = {
      taskId: task.id,
      taskSubject: task.subject,
      success: false,
      exitCode: 1,
      stderr: "",
      worktreePath,
      turns: 0,
      cost: 0,
      commitSha: null,
    };

    try {
      if (agent.systemPrompt.trim()) {
        const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
        tmpPromptDir = tmp.dir;
        tmpPromptPath = tmp.filePath;
        args.push("--append-system-prompt", tmpPromptPath);
      }

      const taskPrompt = `Execute task ${shortId(task.id)} from plan ${shortId(planId)}. ` +
        `Read the plan with: rad-plan show ${shortId(planId)} --json`;
      args.push(taskPrompt);

      let wasAborted = false;
      const proc = spawn("pi", args, {
        cwd: worktreePath,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }

        // Track tool execution for live progress
        if (event.type === "tool_execution_start") {
          const toolName = event.toolName ?? "unknown";
          const toolArgs = event.args ?? {};
          let activity: string | null = null;

          // Extract meaningful info from tool args
          if (toolName === "bash" && toolArgs.command) {
            const cmd = toolArgs.command.split("\n")[0].slice(0, 60);
            activity = `$ ${cmd}${toolArgs.command.length > 60 ? "…" : ""}`;
          } else if (toolName === "read" && toolArgs.path) {
            activity = `reading ${toolArgs.path}`;
          } else if (toolName === "write" && toolArgs.path) {
            activity = `writing ${toolArgs.path}`;
          } else if (toolName === "edit" && toolArgs.path) {
            activity = `editing ${toolArgs.path}`;
          }

          onProgress?.({ currentTool: toolName, lastActivity: activity });
        }

        if (event.type === "tool_execution_end") {
          onProgress?.({ currentTool: null });
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          result.turns++;
          const usage = event.message.usage;
          if (usage) {
            result.cost += usage.cost?.total || 0;
          }
          onProgress?.({ turns: result.turns, cost: result.cost, status: "running" });
        }

        // Capture thinking/text snippets for activity display
        if (event.type === "message_update" && event.message?.role === "assistant") {
          const content = event.assistantMessageEvent;
          if (content?.type === "thinking" && content.thinking) {
            const snippet = content.thinking.slice(-80).split("\n").pop()?.trim();
            if (snippet) onProgress?.({ lastActivity: `💭 ${snippet.slice(0, 60)}${snippet.length > 60 ? "…" : ""}` });
          } else if (content?.type === "text" && content.text) {
            const snippet = content.text.slice(-80).split("\n").pop()?.trim();
            if (snippet) onProgress?.({ lastActivity: snippet.slice(0, 60) + (snippet.length > 60 ? "…" : "") });
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      proc.on("close", (code: number | null) => {
        if (buffer.trim()) processLine(buffer);
        result.exitCode = code ?? 1;
        result.success = code === 0 && !wasAborted;

        // Cleanup temp files
        if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
        if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }

        resolve(result);
      });

      proc.on("error", () => {
        if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
        if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
        resolve(result);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    } catch (err) {
      if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
      if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
      result.stderr = err instanceof Error ? err.message : String(err);
      resolve(result);
    }
  });
}

// --- Concurrency ---

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Formatting ---

function formatDispatchReport(state: PlanState): string {
  const lines: string[] = [];

  lines.push(`Dispatch: "${state.plan.title}"`);
  lines.push("═".repeat(50));
  const landed = state.completed.length;
  const done = state.workerDone.length;
  lines.push(`Status: ${landed} landed, ${done} awaiting merge | ${state.inProgress.length} in progress | ${state.ready.length} ready | ${state.blockedDep.length + state.blockedFile.length} blocked`);
  lines.push("");

  if (state.completed.length > 0) {
    lines.push("── Landed ──");
    for (const t of state.completed) {
      lines.push(`  ✓ ${shortId(t.id)}: "${t.subject}" — ${shortId(t.linkedCommit!)}`);
    }
    lines.push("");
  }

  if (state.workerDone.length > 0) {
    lines.push("── Worker Done (awaiting cherry-pick) ──");
    for (const wd of state.workerDone) {
      lines.push(`  ◆ ${shortId(wd.task.id)}: "${wd.task.subject}" — ${shortId(wd.commitSha)}`);
    }
    lines.push("");
  }

  if (state.inProgress.length > 0) {
    lines.push("── In Progress ──");
    for (const t of state.inProgress) {
      lines.push(`  ◉ ${shortId(t.id)}: "${t.subject}"`);
      if (t.affectedFiles?.length) lines.push(`    Files: ${t.affectedFiles.join(", ")}`);
    }
    lines.push("");
  }

  if (state.ready.length > 0) {
    lines.push("── Ready for Dispatch ──");
    for (const t of state.ready) {
      lines.push(`  ○ ${shortId(t.id)}: "${t.subject}"`);
      if (t.affectedFiles?.length) lines.push(`    Files: ${t.affectedFiles.join(", ")}`);
    }
    lines.push("");
  }

  if (state.blockedDep.length > 0 || state.blockedFile.length > 0) {
    lines.push("── Blocked ──");
    for (const t of state.blockedDep) {
      const deps = (t.blocked_by ?? []).map(d => shortId(d)).join(", ");
      lines.push(`  ✕ ${shortId(t.id)}: "${t.subject}" — waiting on: ${deps}`);
    }
    for (const t of state.blockedFile) {
      lines.push(`  ✕ ${shortId(t.id)}: "${t.subject}" — file conflict with in-progress task`);
    }
    lines.push("");
  }

  if (state.contextFeedback.length > 0) {
    lines.push("── Context Feedback ──");
    for (const fb of state.contextFeedback) {
      const from = fb.taskId ? `task ${shortId(fb.taskId)}` : shortId(fb.contextId);
      for (const c of fb.constraints) {
        lines.push(`  ⚠ Constraint (${from}): ${c}`);
      }
      for (const f of fb.friction) {
        lines.push(`  ℹ Friction (${from}): ${f}`);
      }
      for (const o of fb.openItems) {
        lines.push(`  ℹ Open item (${from}): ${o}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatWorkerDashboard(
  planTitle: string,
  workers: Map<string, WorkerProgress>,
  completedTasks: PlanTask[],
  totalTasks: number,
): string[] {
  const lines: string[] = [];
  const now = Date.now();

  const doneCount = completedTasks.length + [...workers.values()].filter(w => w.status === "done").length;
  const activeCount = [...workers.values()].filter(w => w.status === "running" || w.status === "starting").length;

  lines.push(`⚙ Orchestrating: "${planTitle}" [${doneCount}/${totalTasks} done, ${activeCount} active]`);
  lines.push("─".repeat(50));

  // Show previously completed tasks (brief)
  for (const t of completedTasks) {
    lines.push(`  ✓ ${shortId(t.id)}: ${t.subject} → ${shortId(t.linkedCommit!)}`);
  }

  // Show active workers
  for (const [, w] of workers) {
    const elapsed = Math.round((now - w.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const time = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;

    if (w.status === "starting") {
      lines.push(`  ⏳ ${shortId(w.taskId)}: "${w.taskSubject}" — starting...`);
    } else if (w.status === "running") {
      const tool = w.currentTool ? ` [${w.currentTool}]` : "";
      const activity = w.lastActivity ? ` ${w.lastActivity}` : "";
      lines.push(`  ◉ ${shortId(w.taskId)}: "${w.taskSubject}" — turn ${w.turns}, ${time}${tool}`);
      if (activity) {
        lines.push(`    └─${activity}`);
      }
    } else if (w.status === "done") {
      const cost = w.cost > 0 ? ` ($${w.cost.toFixed(4)})` : "";
      lines.push(`  ✓ ${shortId(w.taskId)}: "${w.taskSubject}" — ${w.turns} turns, ${time}${cost}`);
    } else if (w.status === "failed") {
      lines.push(`  ✗ ${shortId(w.taskId)}: "${w.taskSubject}" — failed after ${w.turns} turns, ${time}`);
    }
  }

  return lines;
}

function formatWorkerResults(results: WorkerResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const icon = r.success ? "✓" : "✗";
    const cost = r.cost > 0 ? ` ($${r.cost.toFixed(4)})` : "";
    lines.push(`  ${icon} ${shortId(r.taskId)}: "${r.taskSubject}" — ${r.turns} turns${cost}`);
    if (!r.success && r.stderr) {
      const preview = r.stderr.split("\n")[0].slice(0, 100);
      lines.push(`    Error: ${preview}`);
    }
  }
  return lines.join("\n");
}

// --- Completion ---

async function completePlan(
  pi: ExtensionAPI,
  planId: string,
  state: PlanState,
  workerCommits: Map<string, string>,
  baseCommit: string,
  worktreePaths: string[],
): Promise<{ patchId: string }> {
  // Create plan branch from the dispatch-time base commit
  const planBranch = `plan/${shortId(planId)}`;
  await pi.exec("git", ["checkout", "-b", planBranch, baseCommit], { timeout: 10000 });

  // Cherry-pick each worker-done task's commit sequentially
  for (const wd of state.workerDone) {
    // Use orchestrator-collected SHA (primary) or DONE comment SHA (fallback)
    const commitSha = workerCommits.get(wd.task.id) ?? wd.commitSha;
    const pickResult = await pi.exec("git", [
      "cherry-pick", commitSha,
    ], { timeout: 30000 });

    if (pickResult.code !== 0) {
      await pi.exec("git", ["cherry-pick", "--abort"], { timeout: 5000 });
      // Post REJECTED comment so the failure is visible in the plan thread
      const reason = (pickResult.stderr || "unknown error").split("\n")[0].slice(0, 200);
      await pi.exec("rad-plan", [
        "comment", planId,
        `REJECTED task:${shortId(wd.task.id)} reason:${reason}`,
      ], { timeout: 10000 });
      throw new Error(`Cherry-pick failed for task ${shortId(wd.task.id)}: ${reason}`);
    }

    // Link the cherry-picked commit (new SHA, not the worker's original)
    const newShaResult = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
    const newSha = newShaResult.stdout.trim();
    await pi.exec("rad-plan", [
      "task", "link-commit", planId, wd.task.id, "--commit", newSha,
    ], { timeout: 10000 });
  }

  // Push the Radicle patch
  const pushResult = await pi.exec("git", ["push", "rad", "HEAD:refs/patches"], { timeout: 30000 });
  if (pushResult.code !== 0) {
    const preview = (pushResult.stderr || pushResult.stdout).split("\n").slice(0, 3).join("\n");
    throw new Error(`Patch push failed (exit ${pushResult.code}): ${preview}`);
  }
  const pushOutput = (pushResult.stdout + "\n" + pushResult.stderr).trim();
  const patchIdMatch = pushOutput.match(/([0-9a-f]{40})/);
  if (!patchIdMatch) {
    throw new Error(`Patch push succeeded but no patch ID found in output: ${pushOutput.slice(0, 200)}`);
  }
  const patchId = patchIdMatch[1];

  // Verify patch exists
  const verifyResult = await pi.exec("rad", ["patch", "show", patchId], { timeout: 10000 });
  if (verifyResult.code !== 0) {
    throw new Error(`Patch ${shortId(patchId)} pushed but verification failed: ${verifyResult.stderr}`);
  }

  // Link patch to plan
  await pi.exec("rad-plan", ["link", planId, "--patch", patchId], { timeout: 10000 });

  // Close plan — only after verified patch
  await pi.exec("rad-plan", ["status", planId, "completed"], { timeout: 10000 });

  // Close linked issues
  for (const issueId of state.plan.relatedIssues) {
    await pi.exec("rad", ["issue", "state", issueId, "--closed"], { timeout: 10000 });
  }

  // Clean up worktrees
  for (const wt of worktreePaths) {
    await removeWorktree(pi, wt);
  }

  // Announce
  await pi.exec("rad", ["sync", "--announce"], { timeout: 15000 });

  return { patchId };
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const state: OrchestratorState = {
    isRadicleRepo: false,
    radPlanInstalled: false,
    radContextInstalled: false,
    repoId: null,
  };

  // Detect capabilities at session start
  pi.on("session_start", async (_event, ctx) => {
    const radResult = await pi.exec("rad", ["."], { timeout: 5000 });
    if (radResult.code !== 0) return;
    state.isRadicleRepo = true;
    state.repoId = radResult.stdout.trim();

    const planResult = await pi.exec("which", ["rad-plan"], { timeout: 3000 });
    state.radPlanInstalled = planResult.code === 0;

    const ctxResult = await pi.exec("which", ["rad-context"], { timeout: 3000 });
    state.radContextInstalled = ctxResult.code === 0;

    if (state.radPlanInstalled) {
      ctx.ui.setStatus("rad-orchestrator", "rad-plan ✓");
    }
  });

  // Register the /rad-orchestrate command
  pi.registerCommand("rad-orchestrate", {
    description: "Orchestrate multi-agent execution of a Plan COB across worktrees",
    handler: async (args, ctx) => {
      if (!state.isRadicleRepo) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }
      if (!state.radPlanInstalled) {
        ctx.ui.notify("rad-plan not installed. Install from: rad clone rad:z4L8L9ctRYn2bcPuUT4GRz7sggG1v", "error");
        return;
      }

      const planId = args?.trim();
      if (!planId) {
        ctx.ui.notify("Usage: /rad-orchestrate <plan-id>", "error");
        return;
      }

      // Find the worker agent definition
      // Try package-relative path first (when installed as a pi package),
      // then fall back to project-local .pi/agents/
      const packageAgentPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "agents", "rad-worker.md");
      const projectAgentPath = path.resolve(ctx.cwd, ".pi", "agents", "rad-worker.md");
      const workerPath = fs.existsSync(packageAgentPath) ? packageAgentPath : projectAgentPath;
      const workerAgent = loadAgentConfig(workerPath);
      if (!workerAgent) {
        ctx.ui.notify(`Worker agent not found at ${workerPath}`, "error");
        return;
      }

      // Phase 1: Load and validate plan
      const initialState = await analyzePlan(pi, planId);
      if (!initialState) {
        ctx.ui.notify(`Failed to load plan ${planId}`, "error");
        return;
      }

      if (initialState.plan.status !== "approved" && initialState.plan.status !== "in-progress") {
        const proceed = await ctx.ui.confirm(
          "Plan not approved",
          `Plan "${initialState.plan.title}" has status "${initialState.plan.status}". Approve and proceed?`,
        );
        if (!proceed) return;
        await pi.exec("rad-plan", ["status", planId, "approved"], { timeout: 10000 });
      }

      // Track all worktree paths for cleanup
      const allWorktreePaths: string[] = [];
      // Collect worker commit SHAs (taskId -> commitSha)
      const workerCommits = new Map<string, string>();
      // Record HEAD at dispatch time so completePlan branches from the same base
      let baseCommit: string | null = null;

      // Live progress tracking
      const workerProgress = new Map<string, WorkerProgress>();
      let dashboardInterval: ReturnType<typeof setInterval> | null = null;

      const updateDashboard = (planState: PlanState) => {
        const lines = formatWorkerDashboard(
          planState.plan.title,
          workerProgress,
          planState.completed,
          planState.plan.tasks.length,
        );
        ctx.ui.setWidget("rad-orchestrator", lines);

        // Also update footer status
        const active = [...workerProgress.values()].filter(w => w.status === "running" || w.status === "starting").length;
        const done = planState.completed.length + planState.workerDone.length + [...workerProgress.values()].filter(w => w.status === "done").length;
        const total = planState.plan.tasks.length;
        ctx.ui.setStatus("rad-orchestrator", `⚙ ${done}/${total} tasks [${active} active]`);
      };

      const cleanupDashboard = () => {
        if (dashboardInterval) {
          clearInterval(dashboardInterval);
          dashboardInterval = null;
        }
        ctx.ui.setWidget("rad-orchestrator", undefined);
        ctx.ui.setStatus("rad-orchestrator", undefined);
      };

      // Phase 2: Dispatch loop
      let currentPlanState = initialState;
      while (true) {
        const planState = await analyzePlan(pi, planId);
        if (!planState) {
          ctx.ui.notify("Failed to reload plan state", "error");
          break;
        }
        currentPlanState = planState;

        // Show dispatch report as widget
        updateDashboard(planState);
        ctx.ui.notify(formatDispatchReport(planState), "info");

        if (planState.allComplete) {
          // Phase 3: Completion
          cleanupDashboard();
          const taskCount = planState.workerDone.length + planState.completed.length;
          const proceed = await ctx.ui.confirm(
            "All tasks complete",
            `Cherry-pick ${planState.workerDone.length} worker commit(s), create patch, and close the plan?`,
          );
          if (!proceed) break;

          ctx.ui.setStatus("rad-orchestrator", "⚙ cherry-picking and creating patch…");
          try {
            const { patchId } = await completePlan(
              pi, planId, planState, workerCommits, baseCommit!, allWorktreePaths,
            );
            ctx.ui.setStatus("rad-orchestrator", undefined);
            ctx.ui.notify(`✓ Patch created: ${shortId(patchId)}`, "info");
            ctx.ui.notify(`✓ Plan completed: ${taskCount} tasks landed and announced`, "info");
          } catch (err) {
            ctx.ui.setStatus("rad-orchestrator", undefined);
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Completion failed: ${msg}`, "error");
            ctx.ui.notify(
              `Plan left open. Worktrees preserved. Fix the issue and re-run /rad-orchestrate ${shortId(planId)}`,
              "warning",
            );
            // Return to previous branch so repo isn't left on plan/<id>
            await pi.exec("git", ["checkout", "-"], { timeout: 10000 });
          }
          break;
        }

        if (planState.ready.length === 0 && planState.inProgress.length === 0) {
          cleanupDashboard();
          ctx.ui.notify("No tasks ready and none in progress. Plan may be stuck.", "warning");
          break;
        }

        if (planState.ready.length === 0) {
          cleanupDashboard();
          ctx.ui.notify(`Waiting for ${planState.inProgress.length} in-progress task(s) to complete...`, "info");
          ctx.ui.notify("Re-run /rad-orchestrate after in-progress tasks complete.", "info");
          break;
        }

        // Dispatch prompt
        const options = [
          `Dispatch all (${planState.ready.length})`,
          "Dispatch one",
          "Stop orchestration",
        ];
        const choice = await ctx.ui.select(
          `${planState.ready.length} task(s) ready for dispatch`,
          options,
        );

        if (!choice || choice === "Stop orchestration") {
          cleanupDashboard();
          break;
        }

        const tasksToDispatch = choice === "Dispatch one"
          ? [planState.ready[0]]
          : planState.ready;

        // Record base commit before creating worktrees (first batch only)
        if (!baseCommit) {
          const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
          baseCommit = headResult.stdout.trim();
        }

        // Create worktrees and spawn workers
        ctx.ui.notify(`Creating ${tasksToDispatch.length} worktree(s)...`, "info");

        const workerTasks: Array<{ task: PlanTask; worktreePath: string }> = [];
        for (const task of tasksToDispatch) {
          try {
            const wt = await createWorktree(pi, ctx.cwd, task.id, slugify(task.subject));
            workerTasks.push({ task, worktreePath: wt });
            allWorktreePaths.push(wt);

            // Initialize progress tracking
            workerProgress.set(task.id, {
              taskId: task.id,
              taskSubject: task.subject,
              status: "starting",
              turns: 0,
              cost: 0,
              currentTool: null,
              lastActivity: null,
              startTime: Date.now(),
            });

            ctx.ui.notify(`  ✓ ${shortId(task.id)}: ${path.basename(wt)}`, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`  ✗ ${shortId(task.id)}: ${msg}`, "error");
          }
        }

        if (workerTasks.length === 0) {
          cleanupDashboard();
          ctx.ui.notify("No worktrees created. Stopping.", "error");
          break;
        }

        // Start periodic dashboard refresh (elapsed time updates)
        updateDashboard(planState);
        dashboardInterval = setInterval(() => updateDashboard(currentPlanState), 1000);

        // Spawn workers in parallel with live progress
        ctx.ui.notify(`Dispatching ${workerTasks.length} worker(s)…`, "info");

        const results = await mapWithConcurrency(
          workerTasks,
          MAX_CONCURRENCY,
          async ({ task, worktreePath }) => {
            const progress = workerProgress.get(task.id)!;
            progress.status = "running";
            updateDashboard(currentPlanState);

            const result = await spawnWorker(
              workerAgent,
              worktreePath,
              planId,
              task,
              (update) => {
                Object.assign(progress, update);
                updateDashboard(currentPlanState);
              },
            );

            // Collect commit SHA from worker's worktree
            if (result.success) {
              try {
                const shaResult = await pi.exec("git", [
                  "-C", worktreePath, "rev-parse", "HEAD",
                ], { timeout: 5000 });
                if (shaResult.code === 0) {
                  result.commitSha = shaResult.stdout.trim();
                }
              } catch { /* worktree may already be gone */ }
            }

            // Update final progress state
            progress.status = result.success ? "done" : "failed";
            progress.turns = result.turns;
            progress.cost = result.cost;
            progress.currentTool = null;
            progress.lastActivity = result.success ? "completed" : `exit code ${result.exitCode}`;
            updateDashboard(currentPlanState);

            return result;
          },
        );

        // Stop periodic refresh
        if (dashboardInterval) {
          clearInterval(dashboardInterval);
          dashboardInterval = null;
        }

        // Report results
        const succeeded = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        // Collect commit SHAs from successful workers
        for (const r of succeeded) {
          if (r.commitSha) {
            workerCommits.set(r.taskId, r.commitSha);
          }
        }

        ctx.ui.notify(`\nBatch complete: ${succeeded.length} succeeded, ${failed.length} failed`, "info");
        if (failed.length > 0) {
          // Write failure logs and show results
          for (const f of failed) {
            const logPath = writeFailureLog(planId, f);
            ctx.ui.notify(`  ✗ ${shortId(f.taskId)}: "${f.taskSubject}" — log: ${logPath}`, "error");
            if (f.stderr) {
              const preview = f.stderr.split("\n").filter(l => l.trim()).slice(0, 3).join("\n    ");
              ctx.ui.notify(`    ${preview}`, "error");
            }
          }

          const retryTasks: WorkerResult[] = [];
          for (const f of failed) {
            const action = await ctx.ui.select(
              `Task ${shortId(f.taskId)} failed (exit ${f.exitCode}). Action?`,
              ["Retry", "Skip (continue with next batch)", "Stop orchestration"],
            );
            if (action === "Stop orchestration") {
              cleanupDashboard();
              ctx.ui.notify("Orchestration stopped by user.", "info");
              return;
            }
            if (action === "Retry") {
              retryTasks.push(f);
            }
          }

          // Tear down failed worktrees and re-dispatch retries
          if (retryTasks.length > 0) {
            for (const f of retryTasks) {
              try {
                await teardownWorktree(pi, f.taskId, f.worktreePath);
                // Remove from allWorktreePaths
                const idx = allWorktreePaths.indexOf(f.worktreePath);
                if (idx >= 0) allWorktreePaths.splice(idx, 1);
              } catch {
                ctx.ui.notify(`  ⚠ Could not clean up worktree for ${shortId(f.taskId)}`, "warning");
              }
            }

            // Find the original task objects for retry
            const retryTaskIds = new Set(retryTasks.map(r => r.taskId));
            const planState = await analyzePlan(pi, planId);
            if (planState) {
              const tasksToRetry = planState.plan.tasks.filter(t => retryTaskIds.has(t.id));
              ctx.ui.notify(`Retrying ${tasksToRetry.length} task(s)…`, "info");

              for (const task of tasksToRetry) {
                try {
                  const wt = await createWorktree(pi, ctx.cwd, task.id, slugify(task.subject));
                  allWorktreePaths.push(wt);

                  workerProgress.set(task.id, {
                    taskId: task.id,
                    taskSubject: task.subject,
                    status: "starting",
                    turns: 0,
                    cost: 0,
                    currentTool: null,
                    lastActivity: null,
                    startTime: Date.now(),
                  });

                  updateDashboard(planState);

                  const progress = workerProgress.get(task.id)!;
                  progress.status = "running";

                  const retryResult = await spawnWorker(
                    workerAgent,
                    wt,
                    planId,
                    task,
                    (update) => {
                      Object.assign(progress, update);
                      updateDashboard(currentPlanState);
                    },
                  );

                  progress.status = retryResult.success ? "done" : "failed";
                  progress.turns = retryResult.turns;
                  progress.cost = retryResult.cost;
                  progress.currentTool = null;
                  progress.lastActivity = retryResult.success ? "completed" : `exit code ${retryResult.exitCode}`;
                  updateDashboard(currentPlanState);

                  if (retryResult.success) {
                    ctx.ui.notify(`  ✓ ${shortId(task.id)}: retry succeeded`, "info");
                  } else {
                    const retryLogPath = writeFailureLog(planId, retryResult);
                    ctx.ui.notify(`  ✗ ${shortId(task.id)}: retry failed — log: ${retryLogPath}`, "error");
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  ctx.ui.notify(`  ✗ ${shortId(task.id)}: retry setup failed: ${msg}`, "error");
                }

                workerProgress.delete(task.id);
              }
            }
          }
        }

        // Clear finished workers from progress (they'll show as completed in next plan analysis)
        for (const r of results) {
          workerProgress.delete(r.taskId);
        }

        // Evaluate context feedback
        if (state.radContextInstalled && succeeded.length > 0) {
          const freshState = await analyzePlan(pi, planId);
          if (freshState) {
            currentPlanState = freshState;
            if (freshState.contextFeedback.length > 0) {
              const remaining = [...freshState.ready, ...freshState.blockedDep, ...freshState.blockedFile];
              for (const fb of freshState.contextFeedback) {
                for (const constraint of fb.constraints) {
                  const conflicting = remaining.filter(t =>
                    t.description?.toLowerCase().includes(constraint.toLowerCase().split(" ").slice(0, 3).join(" ")),
                  );
                  if (conflicting.length > 0) {
                    ctx.ui.notify(
                      `⚠ Constraint from ${fb.taskId ? "task " + shortId(fb.taskId) : shortId(fb.contextId)}: "${constraint}"` +
                      `\n  May affect: ${conflicting.map(t => shortId(t.id)).join(", ")}`,
                      "warning",
                    );
                  }
                }

                for (const item of fb.openItems) {
                  ctx.ui.notify(
                    `ℹ Open item (${fb.taskId ? shortId(fb.taskId) : shortId(fb.contextId)}): ${item}`,
                    "info",
                  );
                }
              }
            }
          }
        }

        // Loop continues — next iteration will re-analyze and show updated state
      }

      cleanupDashboard();
    },
  });

  // /rad-orchestrate-loop command — poll for approved plans and execute them
  pi.registerCommand("rad-orchestrate-loop", {
    description: "Poll for approved plans and orchestrate their execution",
    handler: async (args, ctx) => {
      if (!state.isRadicleRepo) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }
      if (!state.radPlanInstalled) {
        ctx.ui.notify("rad-plan not installed. Install from: rad clone rad:z4L8L9ctRYn2bcPuUT4GRz7sggG1v", "error");
        return;
      }

      const argList = args?.trim().split(/\s+/) ?? [];
      const statusFlag = argList.includes("--status");
      const stopFlag = argList.includes("--stop");
      const oneshot = argList.includes("--oneshot");
      const cooldownIdx = argList.indexOf("--cooldown");
      const cooldownMs = cooldownIdx >= 0 ? parseInt(argList[cooldownIdx + 1] ?? "30000", 10) : 30000;

      // Track loop state on the orchestrator state object
      if (statusFlag) {
        ctx.ui.notify(
          `Orchestrate loop: ${(state as any)._loopRunning ? "running" : "stopped"}\n` +
          `Plans executed: ${(state as any)._loopExecuted ?? 0}`,
          "info",
        );
        return;
      }

      if (stopFlag) {
        (state as any)._loopRunning = false;
        ctx.ui.notify("Orchestrate loop stopped", "info");
        ctx.ui.setStatus("rad-orchestrator", "loop stopped");
        return;
      }

      (state as any)._loopRunning = true;
      (state as any)._loopExecuted = 0;
      ctx.ui.setStatus("rad-orchestrator", "loop: watching for approved plans");
      ctx.ui.notify(
        `Starting orchestrate loop...\n` +
        `  Cooldown: ${cooldownMs / 1000}s\n` +
        `  Oneshot: ${oneshot}`,
        "info",
      );

      while ((state as any)._loopRunning) {
        // 1. Sync
        ctx.ui.notify("\n=== Orchestrate Loop: syncing... ===", "info");
        await syncNetwork(pi);

        // 2. Find approved plans
        const listResult = await pi.exec("rad-plan", ["list", "--status", "approved"], { timeout: 10000 });
        if (listResult.code !== 0) {
          ctx.ui.notify("Failed to list plans", "warning");
          if (oneshot) break;
          await new Promise(r => setTimeout(r, cooldownMs));
          continue;
        }

        const planIds = listResult.stdout.trim().split("\n")
          .map(line => line.match(/^([0-9a-f]{7,40})/)?.[1])
          .filter((id): id is string => !!id);

        if (planIds.length === 0) {
          ctx.ui.notify("No approved plans found.", "info");
          if (oneshot) break;
          ctx.ui.notify(`Waiting ${cooldownMs / 1000}s before next check...`, "info");
          await new Promise(r => setTimeout(r, cooldownMs));
          continue;
        }

        ctx.ui.notify(`Found ${planIds.length} approved plan(s)`, "info");
        for (const pid of planIds) {
          ctx.ui.notify(`  ◉ ${shortId(pid)}`, "info");
        }

        // 3. Execute the first approved plan
        // Delegate to the existing /rad-orchestrate command
        const targetPlanId = planIds[0];
        ctx.ui.notify(`\nExecuting plan ${shortId(targetPlanId)}...`, "info");

        // Set status to in-progress before executing
        await pi.exec("rad-plan", ["status", targetPlanId, "in-progress"], { timeout: 10000 });

        // Invoke the orchestrate command handler by sending it as a user message
        // This reuses all the existing orchestration logic
        pi.sendUserMessage(
          `/rad-orchestrate ${targetPlanId}`,
          { deliverAs: "command" },
        );

        (state as any)._loopExecuted++;

        // After invoking, we need to yield control for the orchestration to run.
        // In interactive mode, the orchestration will handle the rest.
        // We'll break and let the user re-invoke the loop after plan completion.
        ctx.ui.notify(
          `Plan ${shortId(targetPlanId)} dispatched to /rad-orchestrate.\n` +
          `Re-run /rad-orchestrate-loop after it completes to process the next plan.`,
          "info",
        );

        if (oneshot) break;

        // In a true auto mode, we'd need to wait for the orchestration to complete.
        // For now, break and let the user re-run.
        break;
      }

      (state as any)._loopRunning = false;
      ctx.ui.setStatus("rad-orchestrator", "rad-plan ✓");
      ctx.ui.notify("Orchestrate loop ended.", "info");
    },
  });
}
