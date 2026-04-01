import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSessionContext, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { parseExtractionResponse, mergeFilesTouched, extractContextId, parseCommitShas } from "../lib/rad-context-utils.ts";
import {
  type Issue,
  type RadicleCapabilities,
  shortId,
  syncNetwork,
  announceNetwork,
  detectCapabilities,
  listOpenIssues,
  returnToMain,
  createFeatureBranch,
  commitChanges,
  pushPatch,
  getModifiedFilesSince,
} from "../lib/rad-shared.ts";

// --- Types ---

interface LoopState {
  caps: RadicleCapabilities;
  processedIssues: Set<string>;
  sessionStartTime: number;
  isRunning: boolean;
  cooldownMs: number;
}

// --- Constants ---

const DEFAULT_COOLDOWN_MS = 30000;
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

// --- Context Extraction ---

async function extractAndCreateContext(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  conversation: string,
  modifiedFiles: string[],
  issueId: string,
): Promise<string | null> {
  if (!pi.exec) return null;

  let model = ctx.modelRegistry.find("anthropic", "claude-4-5-haiku-latest")
    ?? ctx.modelRegistry.find("anthropic", "claude-haiku-4-5");

  if (!model) {
    model = ctx.model;
    if (model) {
      ctx.ui.notify(`rad-issue-loop: using session model (${model.id}) for extraction`, "info");
    }
  }

  if (!model) {
    ctx.ui.notify("rad-issue-loop: no model available for context extraction", "warning");
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
      ctx.ui.notify(`rad-issue-loop: extraction ${(parsed as { error: string }).error}`, "warning");
      return null;
    }

    const contextJson = mergeFilesTouched((parsed as { data: Record<string, unknown> }).data, modifiedFiles);

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

// --- Helpers ---

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
  return bodies.some(b => /patch|pull|pr/i.test(b) && /submitted|opened|created/i.test(b));
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const state: LoopState = {
    caps: {
      isRadicleRepo: false,
      radPlanInstalled: false,
      radContextInstalled: false,
      repoId: null,
    },
    processedIssues: new Set(),
    sessionStartTime: Date.now(),
    isRunning: false,
    cooldownMs: DEFAULT_COOLDOWN_MS,
  };

  // Detect Radicle repo and capabilities
  pi.on("session_start", async (_event, ctx) => {
    state.sessionStartTime = Date.now();
    state.caps = await detectCapabilities(pi);

    if (state.caps.isRadicleRepo) {
      ctx.ui.setStatus("rad-issue-loop", "ready");
    }
  });

  // /rad-issue-loop command — direct work on issues (no plan creation)
  pi.registerCommand("rad-issue-loop", {
    description: "Run autonomous issue processing loop (direct implementation, no plan creation)",
    handler: async (args, ctx) => {
      if (!state.caps.isRadicleRepo) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      const argList = args?.trim().split(/\s+/) ?? [];
      const auto = argList.includes("--auto");
      const oneshot = argList.includes("--oneshot");
      const status = argList.includes("--status");
      const stop = argList.includes("--stop");

      // Label filter: skip issues with the plan label (those belong to rad-plan-loop)
      const labelsIdx = argList.indexOf("--labels");
      const labelFilter = labelsIdx >= 0 ? (argList[labelsIdx + 1]?.split(",") ?? []) : [];

      // Exclude label: issues with this label are handled by rad-plan-loop
      const excludeIdx = argList.indexOf("--exclude-label");
      const excludeLabel = excludeIdx >= 0 ? argList[excludeIdx + 1] : "toplan";

      if (status) {
        ctx.ui.notify(
          `Issue loop: ${state.isRunning ? "running" : "stopped"}\n` +
          `Processed: ${state.processedIssues.size} issues\n` +
          `Excluding label: ${excludeLabel}`,
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

      state.isRunning = true;
      ctx.ui.setStatus("rad-issue-loop", "running");
      ctx.ui.notify("Starting issue loop (direct work mode)...", "info");

      let iterationCount = 0;
      while (state.isRunning) {
        iterationCount++;
        ctx.ui.notify(`\n=== Iteration ${iterationCount} ===`, "info");

        // 1. Sync
        ctx.ui.notify("Syncing with network...", "info");
        if (!await syncNetwork(pi)) {
          ctx.ui.notify("Sync failed, retrying...", "warning");
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // 2. List open issues (with optional label filter)
        ctx.ui.notify("Checking for open issues...", "info");
        const allIssues = await listOpenIssues(pi, labelFilter.length > 0 ? labelFilter : undefined);

        // 3. Filter: exclude processed, patch-referenced, and plan-label issues
        const candidates = allIssues.filter(i =>
          !state.processedIssues.has(i.id) &&
          !hasOpenPatchReference(i) &&
          !i.labels.includes(excludeLabel),
        );

        ctx.ui.notify(`Found ${allIssues.length} issues, ${candidates.length} candidates (excluding '${excludeLabel}')`, "info");

        if (candidates.length === 0) {
          if (oneshot) break;
          ctx.ui.notify(`Waiting ${state.cooldownMs / 1000}s before next check...`, "info");
          await new Promise(r => setTimeout(r, state.cooldownMs));
          continue;
        }

        // 4. Select issue
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

        if (!selectedIssue) continue;

        // 5. Work the issue directly
        ctx.ui.notify(`\n--- Working on issue ${shortId(selectedIssue.id)}: "${selectedIssue.title}" ---`, "info");
        state.processedIssues.add(selectedIssue.id);

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

        if (!auto) {
          ctx.ui.notify(
            "Issue work injected. Complete the work, then run /rad-issue-work to commit, create context, and push patch.",
            "info",
          );
          break;
        }

        await returnToMain(pi);

        if (oneshot) break;

        ctx.ui.notify(`Waiting ${state.cooldownMs / 1000}s...`, "info");
        await new Promise(r => setTimeout(r, state.cooldownMs));
      }

      state.isRunning = false;
      ctx.ui.setStatus("rad-issue-loop", "ready");
      ctx.ui.notify("Issue loop ended.", "info");
    },
  });

  // /rad-issue-work command — complete current issue: commit, context, patch
  pi.registerCommand("rad-issue-work", {
    description: "Complete current issue work: commit, create context, push patch",
    handler: async (args, ctx) => {
      if (!state.caps.isRadicleRepo) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      let issueId = args?.trim();
      if (!issueId) {
        const branchResult = await pi.exec("git", ["branch", "--show-current"], { timeout: 5000 });
        const match = branchResult.stdout.match(/issue-([0-9a-f]+)/);
        if (match) issueId ??= match[1];
      }

      if (!issueId) {
        ctx.ui.notify("Usage: /rad-issue-work <issue-id> (or run from issue-* branch)", "error");
        return;
      }

      ctx.ui.notify(`Completing work on issue ${shortId(issueId)}...`, "info");

      // 1. Commit
      const statusResult = await pi.exec("git", ["status", "--porcelain"], { timeout: 5000 });
      const hasChanges = statusResult.stdout.trim().length > 0;

      let commitSha: string | null = null;
      if (hasChanges) {
        const message = await ctx.ui.input("Commit message:", `Fix: resolve issue ${shortId(issueId)}`);
        commitSha = await commitChanges(pi, message ?? `Fix: resolve issue ${shortId(issueId)}`);
        if (!commitSha) {
          ctx.ui.notify("Failed to commit changes", "error");
          return;
        }
        ctx.ui.notify(`Committed: ${shortId(commitSha)}`, "info");
      } else {
        const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
        commitSha = headResult.code === 0 ? headResult.stdout.trim() : null;
      }

      // 2. Context COB
      if (state.caps.radContextInstalled && commitSha) {
        ctx.ui.notify("Creating context COB...", "info");

        const entries = ctx.sessionManager.getEntries();
        const sessionContext = buildSessionContext(entries, ctx.sessionManager.getLeafId());
        const conversation = serializeConversation(convertToLlm(sessionContext.messages));

        const branchPointResult = await pi.exec("git", ["merge-base", "main", "HEAD"], { timeout: 5000 });
        const branchPoint = branchPointResult.code === 0 ? branchPointResult.stdout.trim() : "HEAD~1";
        const modifiedFiles = await getModifiedFilesSince(pi, branchPoint);

        const contextId = await extractAndCreateContext(pi, ctx, conversation, modifiedFiles, issueId);

        if (contextId) {
          await pi.exec("rad-context", ["link", contextId, "--issue", issueId], { timeout: 5000 });
          await pi.exec("rad-context", ["link", contextId, "--commit", commitSha], { timeout: 5000 });
          ctx.ui.notify(`Context created: ${shortId(contextId)}`, "info");
        }
      }

      // 3. Push patch
      ctx.ui.notify("Pushing patch...", "info");
      const patchId = await pushPatch(pi);

      if (patchId) {
        ctx.ui.notify(`Patch pushed: ${shortId(patchId)}`, "info");
        await pi.exec("rad", ["issue", "comment", issueId, "--message", `Patch submitted: ${patchId}`], { timeout: 10000 });
        await announceNetwork(pi);
      } else {
        ctx.ui.notify("Failed to push patch", "error");
        return;
      }

      // 4. Return to main
      await returnToMain(pi);

      ctx.ui.notify(`Issue ${shortId(issueId)} complete!`, "info");
      ctx.ui.notify(`Commit: ${shortId(commitSha!)} | Patch: ${shortId(patchId!)}`, "info");

      state.processedIssues.delete(issueId);
    },
  });

  // /rad-issue-skip — skip current issue, return to main
  pi.registerCommand("rad-issue-skip", {
    description: "Skip current issue work and return to main branch",
    handler: async (_args, ctx) => {
      if (!state.caps.isRadicleRepo) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      await returnToMain(pi);
      ctx.ui.notify("Returned to main branch. Issue skipped.", "info");
    },
  });

  // /rad-issue-check — check for new COBs
  pi.registerCommand("rad-issue-check", {
    description: "Check for new issues, patches, and contexts",
    handler: async (_args, ctx) => {
      if (!state.caps.isRadicleRepo) {
        ctx.ui.notify("Not a Radicle repository", "error");
        return;
      }

      ctx.ui.notify("Checking for new COBs...", "info");
      await syncNetwork(pi);

      const issues = await listOpenIssues(pi);
      ctx.ui.notify(`Issues: ${issues.length} open`, "info");
      for (const issue of issues.slice(0, 5)) {
        ctx.ui.notify(`  - ${shortId(issue.id)}: ${issue.title} [${issue.labels.join(", ") || "no labels"}]`, "info");
      }

      const repoId = (await pi.exec("rad", ["."], { timeout: 5000 })).stdout.trim();
      if (repoId) {
        const patchResult = await pi.exec("rad", ["cob", "list", "--repo", repoId, "--type", "xyz.radicle.patch"], { timeout: 10000 });
        if (patchResult.code === 0) {
          const patches = patchResult.stdout.trim().split("\n").filter(l => l.trim());
          ctx.ui.notify(`Patches: ${patches.length} total`, "info");
        }
      }

      if (state.caps.radContextInstalled) {
        const ctxResult = await pi.exec("rad-context", ["list"], { timeout: 10000 });
        if (ctxResult.code === 0) {
          const contexts = ctxResult.stdout.trim().split("\n").filter(l => l.trim());
          ctx.ui.notify(`Contexts: ${contexts.length} total`, "info");
        }
      }
    },
  });
}
