import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSessionContext, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { parseExtractionResponse, mergeFilesTouched, extractContextId, parseCommitShas } from "../lib/rad-context-utils.ts";

// --- Types ---

interface Issue {
  id: string;
  title: string;
  status: string;
  labels: string[];
  assignees: string[];
  discussion: {
    comments: Record<string, {
      body: string;
      edits: Array<{ body: string }>;
    }>;
  };
}

interface LoopState {
  isRadicleRepo: boolean;
  radContextInstalled: boolean;
  repoId: string | null;
  processedIssues: Set<string>;
  sessionStartTime: number;
  isRunning: boolean;
  cooldownMs: number;
  labelFilter: string[];
}

interface IssueWorkResult {
  issueId: string;
  success: boolean;
  commitSha: string | null;
  patchId: string | null;
  contextId: string | null;
  error: string | null;
}

// --- Constants ---

const DEFAULT_COOLDOWN_MS = 30000; // 30 seconds between issues
const EXTRACTION_PROMPT = `You are an observation extractor for coding sessions. Given a serialized conversation from an AI coding session, extract structured observations for a Context COB.

Output ONLY valid JSON matching this schema — no markdown fences, no commentary:

{
  "title": "Brief session identifier (e.g. 'Fix: auth middleware bug')",
  "description": "One-paragraph summary of what happened",
  "approach": "What approaches were considered, what was tried, why the chosen path won, what alternatives were rejected",
  "constraints": ["Forward-looking assumptions — phrase as 'valid as long as X remains true'"],
  "learnings": {
    "repo": ["Repository-level patterns and conventions discovered"],
    "code": [{"path": "src/file.rs", "line": 42, "finding": "Non-obvious discovery"}]
  },
  "friction": ["Specific, past-tense problems encountered"],
  "openItems": ["Unfinished work, tech debt introduced, known gaps"],
  "filesTouched": ["files/actually/modified.ts"],
  "verification": [{"check": "cargo test", "result": "pass", "note": "all tests passed"}]
}

Rules:
- friction: past-tense, specific, actionable
- constraints: forward-looking, what could invalidate this work
- Omit empty arrays, keep every field concise`;

// --- Helpers ---

function shortId(id: string): string {
  return id.slice(0, 7);
}

function hasOpenPatchReference(issue: Issue): boolean {
  const bodies: string[] = [];
  for (const comment of Object.values(issue.discussion?.comments ?? {})) {
    const edits = comment.edits;
    if (edits && edits.length > 0) {
      bodies.push(edits[edits.length - 1].body);
    } else {
      bodies.push(comment.body);
    }
  }
  // Check for patch references
  return bodies.some(b => /patch|pull|pr/i.test(b) && /submitted|opened|created/i.test(b));
}

function matchesLabels(issue: Issue, labelFilter: string[]): boolean {
  if (labelFilter.length === 0) return true;
  return issue.labels.some(l => labelFilter.includes(l));
}

// --- Issue Operations ---

async function listOpenIssues(pi: ExtensionAPI): Promise<Issue[]> {
  const result = await pi.exec("rad", ["issue", "list"], { timeout: 10000 });
  if (result.code !== 0) return [];

  // Parse issue list - format is typically one issue per line with ID and title
  const lines = result.stdout.trim().split("\n").filter(l => l.trim());
  const issues: Issue[] = [];

  for (const line of lines) {
    // Try to extract issue ID (hex prefix)
    const match = line.match(/^([0-9a-f]{7,40})/);
    if (match) {
      const issueId = match[1];
      // Get full issue details
      const showResult = await pi.exec("rad", ["issue", "show", issueId], { timeout: 5000 });
      if (showResult.code === 0) {
        // Parse the issue output - this is a simplified parser
        // In production, use --json if available
        const titleMatch = showResult.stdout.match(/title:\s*(.+)/i);
        const statusMatch = showResult.stdout.match(/status:\s*(\w+)/i);
        issues.push({
          id: issueId,
          title: titleMatch?.[1]?.trim() ?? "Untitled",
          status: statusMatch?.[1]?.trim() ?? "open",
          labels: [],
          assignees: [],
          discussion: { comments: {} },
        });
      }
    }
  }

  return issues;
}

async function getIssueDetails(pi: ExtensionAPI, issueId: string): Promise<Issue | null> {
  const result = await pi.exec("rad", ["issue", "show", issueId], { timeout: 5000 });
  if (result.code !== 0) return null;

  const titleMatch = result.stdout.match(/title:\s*(.+)/i);
  const statusMatch = result.stdout.match(/status:\s*(\w+)/i);

  return {
    id: issueId,
    title: titleMatch?.[1]?.trim() ?? "Untitled",
    status: statusMatch?.[1]?.trim() ?? "open",
    labels: [],
    assignees: [],
    discussion: { comments: {} },
  };
}

async function createFeatureBranch(pi: ExtensionAPI, issueId: string): Promise<boolean> {
  const branch = `issue-${shortId(issueId)}`;
  const result = await pi.exec("git", ["checkout", "-b", branch], { timeout: 10000 });
  return result.code === 0;
}

async function commitChanges(pi: ExtensionAPI, message: string): Promise<string | null> {
  const addResult = await pi.exec("git", ["add", "-A"], { timeout: 5000 });
  if (addResult.code !== 0) return null;

  const commitResult = await pi.exec("git", ["commit", "-m", message], { timeout: 10000 });
  if (commitResult.code !== 0) return null;

  const shaResult = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
  return shaResult.code === 0 ? shaResult.stdout.trim() : null;
}

async function pushPatch(pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("git", ["push", "rad", "HEAD:refs/patches"], { timeout: 30000 });
  if (result.code !== 0) return null;

  // Extract patch ID from output
  const match = (result.stdout + result.stderr).match(/([0-9a-f]{40})/);
  return match ? match[1] : null;
}

async function linkContextToIssue(pi: ExtensionAPI, contextId: string, issueId: string, commitSha?: string): Promise<void> {
  await pi.exec("rad-context", ["link", contextId, "--issue", issueId], { timeout: 5000 });
  if (commitSha) {
    await pi.exec("rad-context", ["link", contextId, "--commit", commitSha], { timeout: 5000 });
  }
}

async function returnToMain(pi: ExtensionAPI): Promise<void> {
  await pi.exec("git", ["checkout", "main"], { timeout: 10000 });
  await pi.exec("git", ["pull"], { timeout: 10000 });
}

async function syncNetwork(pi: ExtensionAPI): Promise<boolean> {
  const fetchResult = await pi.exec("rad", ["sync", "--fetch"], { timeout: 30000 });
  return fetchResult.code === 0;
}

// --- Context Extraction ---

async function getModifiedFilesSince(branchPoint: string): Promise<string[]> {
  const result = await pi.exec("git", ["diff", "--name-only", branchPoint], { timeout: 5000 });
  if (result.code !== 0) return [];
  return result.stdout.trim().split("\n").filter(l => l.length > 0);
}

async function extractAndCreateContext(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  conversation: string,
  modifiedFiles: string[],
  issueId: string,
): Promise<string | null> {
  if (!pi.exec) return null;

  const model = ctx.modelRegistry.find("anthropic", "claude-4-5-haiku-latest")
    ?? ctx.modelRegistry.find("anthropic", "claude-haiku-4-5");

  if (!model) {
    ctx.ui.notify("rad-issue-loop: no Haiku model for context extraction", "warning");
    return null;
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    ctx.ui.notify(`rad-issue-loop: no API key for ${model.provider}`, "warning");
    return null;
  }

  try {
    const fileList = modifiedFiles.length > 0
      ? `\n\nFiles modified:\n${modifiedFiles.join("\n")}`
      : "";

    const response = await complete(
      model,
      {
        messages: [{
          role: "user" as const,
          content: [{
            type: "text" as const,
            text: `${EXTRACTION_PROMPT}\n\n<conversation>\n${conversation}\n</conversation>${fileList}`,
          }],
          timestamp: Date.now(),
        }],
      },
      { apiKey, maxTokens: 4096 },
    );

    const responseText = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (!responseText) return null;

    const parsed = parseExtractionResponse(responseText);
    if (!parsed.ok) {
      ctx.ui.notify(`rad-issue-loop: extraction ${parsed.error}`, "warning");
      return null;
    }

    const contextJson = mergeFilesTouched(parsed.data, modifiedFiles);

    const createResult = await pi.exec(
      "bash",
      ["-c", `echo '${JSON.stringify(contextJson).replace(/'/g, "'\\''")}' | rad-context create --json`],
      { timeout: 15000 },
    );

    if (createResult.code !== 0) {
      ctx.ui.notify(`rad-issue-loop: context creation failed: ${createResult.stderr}`, "error");
      return null;
    }

    return extractContextId(createResult.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`rad-issue-loop: extraction failed: ${message}`, "error");
    return null;
  }
}

// --- Main Loop ---

async function workIssue(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  state: LoopState,
  issue: Issue,
): Promise<IssueWorkResult> {
  const result: IssueWorkResult = {
    issueId: issue.id,
    success: false,
    commitSha: null,
    patchId: null,
    contextId: null,
    error: null,
  };

  try {
    ctx.ui.notify(`Working on issue ${shortId(issue.id)}: "${issue.title}"`, "info");

    // Create feature branch
    if (!await createFeatureBranch(pi, issue.id)) {
      result.error = "Failed to create feature branch";
      return result;
    }

    // Record the branch point for later diff
    const branchPointResult = await pi.exec("git", ["rev-parse", "main"], { timeout: 5000 });
    const branchPoint = branchPointResult.code === 0 ? branchPointResult.stdout.trim() : "HEAD~1";

    // Inject the issue into the agent's context via a steering message
    // This tells the agent what to work on
    pi.sendUserMessage(
      `Work on issue ${shortId(issue.id)}: "${issue.title}"\n\n` +
      `Read the issue details with: rad issue show ${issue.id}\n` +
      `Then implement the necessary changes, commit them, and report back.\n` +
      `Do NOT push a patch - just commit your changes and report.`,
      { deliverAs: "steer" },
    );

    // The agent will work on this and we'll catch the result on the next turn
    // For now, we return a pending state - the actual work happens in the agent loop
    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const state: LoopState = {
    isRadicleRepo: false,
    radContextInstalled: false,
    repoId: null,
    processedIssues: new Set(),
    sessionStartTime: Date.now(),
    isRunning: false,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    labelFilter: [],
  };

  function isActive(): boolean {
    return state.isRadicleRepo;
  }

  function hasContextSupport(): boolean {
    return state.radContextInstalled;
  }

  // Detect Radicle repo and capabilities
  pi.on("session_start", async (_event, ctx) => {
    state.sessionStartTime = Date.now();

    const radResult = await pi.exec("rad", ["."], { timeout: 5000 });
    if (radResult.code !== 0) return;

    state.isRadicleRepo = true;
    state.repoId = radResult.stdout.trim();

    const ctxResult = await pi.exec("which", ["rad-context"], { timeout: 3000 });
    state.radContextInstalled = ctxResult.code === 0;

    if (state.isRadicleRepo) {
      ctx.ui.setStatus("rad-issue-loop", "ready");
    }
  });

  // /rad-issue-loop command
  pi.registerCommand("rad-issue-loop", {
    description: "Run autonomous issue processing loop",
    handler: async (args, ctx) => {
      if (!isActive()) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      // Parse arguments
      const argList = args?.trim().split(/\s+/) ?? [];
      const auto = argList.includes("--auto");
      const oneshot = argList.includes("--oneshot");
      const status = argList.includes("--status");
      const stop = argList.includes("--stop");
      const labelsIdx = argList.indexOf("--labels");
      const labelFilter = labelsIdx >= 0 ? (argList[labelsIdx + 1]?.split(",") ?? []) : [];

      if (status) {
        ctx.ui.notify(
          `Issue loop: ${state.isRunning ? "running" : "stopped"}\n` +
          `Processed: ${state.processedIssues.size} issues\n` +
          `Label filter: ${state.labelFilter.join(", ") || "none"}`,
          "info",
        );
        return;
      }

      if (stop) {
        state.isRunning = false;
        ctx.ui.notify("Issue loop stopped", "info");
        ctx.ui.setStatus("rad-issue-loop", "stopped");
        return;
      }

      // Start the loop
      state.isRunning = true;
      state.labelFilter = labelFilter;
      ctx.ui.setStatus("rad-issue-loop", "running");

      ctx.ui.notify("Starting issue loop...", "info");

      let iterationCount = 0;
      while (state.isRunning) {
        iterationCount++;

        ctx.ui.notify(`\n=== Iteration ${iterationCount} ===`, "info");

        // 1. Sync with network
        ctx.ui.notify("Syncing with network...", "info");
        if (!await syncNetwork(pi)) {
          ctx.ui.notify("Sync failed, retrying...", "warning");
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // 2. Check for open issues
        ctx.ui.notify("Checking for open issues...", "info");
        const issues = await listOpenIssues(pi);

        if (issues.length === 0) {
          ctx.ui.notify("No open issues found.", "info");
          if (oneshot) break;
          ctx.ui.notify(`Waiting ${state.cooldownMs / 1000}s before next check...`, "info");
          await new Promise(r => setTimeout(r, state.cooldownMs));
          continue;
        }

        // 3. Filter issues
        const candidates = issues.filter(i =>
          i.status === "open" &&
          !state.processedIssues.has(i.id) &&
          !hasOpenPatchReference(i) &&
          matchesLabels(i, state.labelFilter),
        );

        ctx.ui.notify(`Found ${issues.length} issues, ${candidates.length} candidates`, "info");

        if (candidates.length === 0) {
          ctx.ui.notify("No eligible issues to work on.", "info");
          if (oneshot) break;
          ctx.ui.notify(`Waiting ${state.cooldownMs / 1000}s before next check...`, "info");
          await new Promise(r => setTimeout(r, state.cooldownMs));
          continue;
        }

        // 4. Select an issue (first candidate, or prompt if interactive)
        let selectedIssue: Issue | null = null;

        if (auto) {
          selectedIssue = candidates[0];
        } else {
          const options = [
            ...candidates.slice(0, 5).map(i => `${shortId(i.id)}: ${i.title}`),
            "Skip this batch",
            "Stop loop",
          ];
          const choice = await ctx.ui.select(
            `${candidates.length} eligible issue(s). Select one to work:`,
            options,
          );

          if (!choice || choice === "Stop loop") {
            state.isRunning = false;
            break;
          }
          if (choice === "Skip this batch") {
            if (oneshot) break;
            continue;
          }

          const selectedId = choice.split(":")[0];
          selectedIssue = candidates.find(i => shortId(i.id) === selectedId) ?? null;
        }

        if (!selectedIssue) {
          continue;
        }

        // 5. Work the issue
        ctx.ui.notify(`\n--- Working on issue ${shortId(selectedIssue.id)} ---`, "info");

        // Mark as processed immediately to avoid re-selection
        state.processedIssues.add(selectedIssue.id);

        // Inject work prompt into the agent
        pi.sendUserMessage(
          `You are working on Radicle issue ${shortId(selectedIssue.id)}: "${selectedIssue.title}"\n\n` +
          `Steps:\n` +
          `1. Read issue details: rad issue show ${selectedIssue.id}\n` +
          `2. Create a feature branch: git checkout -b issue-${shortId(selectedIssue.id)}\n` +
          `3. Implement the necessary changes\n` +
          `4. Run any tests/builds to verify\n` +
          `5. Commit your changes with a descriptive message\n` +
          `6. Report what you did\n\n` +
          `Do NOT push a patch yet - just commit and report.`,
          { deliverAs: "steer" },
        );

        // Wait for agent to finish (in interactive mode, this happens naturally)
        // In auto mode, we'd need to spawn a subagent - for now, require interaction
        if (!auto) {
          ctx.ui.notify(
            "Issue work injected into conversation. Complete the work, then run /rad-issue-loop --status to continue.",
            "info",
          );
          break;
        }

        // 6. After work is done (would need to detect this), create context
        // This would be handled by detecting commit creation

        // 7. Push patch (after context)
        // This would be done after confirming the work

        // 8. Clear context and return to main
        await returnToMain(pi);

        if (oneshot) {
          ctx.ui.notify("Oneshot mode: stopping after one issue.", "info");
          break;
        }

        // 9. Cooldown before next issue
        ctx.ui.notify(`Issue processed. Waiting ${state.cooldownMs / 1000}s...`, "info");
        await new Promise(r => setTimeout(r, state.cooldownMs));
      }

      state.isRunning = false;
      ctx.ui.setStatus("rad-issue-loop", "ready");
      ctx.ui.notify("Issue loop ended.", "info");
    },
  });

  // /rad-issue-work command - complete the current issue work
  pi.registerCommand("rad-issue-work", {
    description: "Complete the current issue work: commit, create context, push patch",
    handler: async (args, ctx) => {
      if (!isActive()) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      const issueId = args?.trim();
      if (!issueId) {
        // Try to detect from branch name
        const branchResult = await pi.exec("git", ["branch", "--show-current"], { timeout: 5000 });
        const match = branchResult.stdout.match(/issue-([0-9a-f]+)/);
        if (match) {
          issueId ??= match[1];
        }
      }

      if (!issueId) {
        ctx.ui.notify("Usage: /rad-issue-work <issue-id> (or run from issue-* branch)", "error");
        return;
      }

      ctx.ui.notify(`Completing work on issue ${shortId(issueId)}...`, "info");

      // 1. Commit changes (if any)
      const statusResult = await pi.exec("git", ["status", "--porcelain"], { timeout: 5000 });
      const hasChanges = statusResult.stdout.trim().length > 0;

      let commitSha: string | null = null;
      if (hasChanges) {
        ctx.ui.notify("Committing changes...", "info");
        const message = await ctx.ui.input("Commit message:", `Fix: resolve issue ${shortId(issueId)}`);
        commitSha = await commitChanges(pi, message ?? `Fix: resolve issue ${shortId(issueId)}`);
        if (!commitSha) {
          ctx.ui.notify("Failed to commit changes", "error");
          return;
        }
        ctx.ui.notify(`Committed: ${shortId(commitSha)}`, "info");
      } else {
        // Get current HEAD
        const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
        commitSha = headResult.code === 0 ? headResult.stdout.trim() : null;
      }

      // 2. Create context COB
      if (hasContextSupport() && commitSha) {
        ctx.ui.notify("Creating context COB...", "info");

        const entries = ctx.sessionManager.getEntries();
        const sessionContext = buildSessionContext(entries, ctx.sessionManager.getLeafId());
        const conversation = serializeConversation(convertToLlm(sessionContext.messages));

        const branchPointResult = await pi.exec("git", ["merge-base", "main", "HEAD"], { timeout: 5000 });
        const branchPoint = branchPointResult.code === 0 ? branchPointResult.stdout.trim() : "HEAD~1";
        const modifiedFiles = await getModifiedFilesSince(branchPoint);

        const contextId = await extractAndCreateContext(pi, ctx, conversation, modifiedFiles, issueId);

        if (contextId) {
          await linkContextToIssue(pi, contextId, issueId, commitSha);
          ctx.ui.notify(`Context created: ${shortId(contextId)}`, "info");
        }
      }

      // 3. Push patch
      ctx.ui.notify("Pushing patch...", "info");
      const patchId = await pushPatch(pi);

      if (patchId) {
        ctx.ui.notify(`Patch pushed: ${shortId(patchId)}`, "info");

        // Comment on issue
        await pi.exec("rad", ["issue", "comment", issueId, "--message", `Patch submitted: ${patchId}`], { timeout: 10000 });

        // Announce
        await pi.exec("rad", ["sync", "--announce"], { timeout: 15000 });
      } else {
        ctx.ui.notify("Failed to push patch", "error");
        return;
      }

      // 4. Return to main
      await returnToMain(pi);

      ctx.ui.notify(`Issue ${shortId(issueId)} complete!`, "success");
      ctx.ui.notify(`Commit: ${shortId(commitSha!)} | Patch: ${shortId(patchId!)}`, "info");

      // 5. Clear processed set and prompt for next issue
      state.processedIssues.delete(issueId);
    },
  });

  // /rad-issue-skip command - skip current issue work
  pi.registerCommand("rad-issue-skip", {
    description: "Skip current issue work and return to main branch",
    handler: async (_args, ctx) => {
      if (!isActive()) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      await returnToMain(pi);
      ctx.ui.notify("Returned to main branch. Issue skipped.", "info");
    },
  });

  // /rad-issue-check command - check for new COBs
  pi.registerCommand("rad-issue-check", {
    description: "Check for new issues, patches, and contexts",
    handler: async (_args, ctx) => {
      if (!isActive()) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      ctx.ui.notify("Checking for new COBs...", "info");

      // Sync first
      await syncNetwork(pi);

      // Check issues
      const issues = await listOpenIssues(pi);
      ctx.ui.notify(`Issues: ${issues.length} open`, "info");
      for (const issue of issues.slice(0, 5)) {
        ctx.ui.notify(`  - ${shortId(issue.id)}: ${issue.title}`, "info");
      }

      // Check patches
      const patchResult = await pi.exec("rad", ["patch", "list"], { timeout: 10000 });
      if (patchResult.code === 0) {
        const patches = patchResult.stdout.trim().split("\n").filter(l => l.trim());
        ctx.ui.notify(`Patches: ${patches.length} total`, "info");
      }

      // Check contexts
      if (hasContextSupport()) {
        const ctxResult = await pi.exec("rad-context", ["list"], { timeout: 10000 });
        if (ctxResult.code === 0) {
          const contexts = ctxResult.stdout.trim().split("\n").filter(l => l.trim());
          ctx.ui.notify(`Contexts: ${contexts.length} total`, "info");
        }
      }
    },
  });
}
