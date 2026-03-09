import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSessionContext, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";

interface RadContextState {
  isRadicleRepo: boolean;
  radContextInstalled: boolean;
  repoId: string | null;
  contextCreatedThisSession: boolean;
  sessionStartTime: number;
  // Stashed between session_before_compact and session_compact
  stashedConversation: string | null;
  stashedModifiedFiles: string[];
  stashedReadFiles: string[];
}

const EXTRACTION_PROMPT = `You are an observation extractor for coding sessions. Given a serialized conversation from an AI coding session, extract structured observations for a Context COB (a durable record for future sessions and collaborators).

Output ONLY valid JSON matching this schema — no markdown fences, no commentary:

{
  "title": "Brief session identifier (e.g. 'Implement auth middleware')",
  "description": "One-paragraph summary of what happened",
  "approach": "What approaches were considered, what was tried, why the chosen path won, what alternatives were rejected",
  "constraints": ["Forward-looking assumptions — phrase as 'valid as long as X remains true'. Only include constraints that would affect correctness if violated."],
  "learnings": {
    "repo": ["Repository-level patterns and conventions discovered"],
    "code": [{"path": "src/file.rs", "line": 42, "finding": "Non-obvious discovery about this code"}]
  },
  "friction": ["Specific, past-tense problems encountered. 'Type inference failed on nested generics in X' not 'types were tricky'"],
  "openItems": ["Unfinished work, tech debt introduced, known gaps"],
  "filesTouched": ["files/actually/modified.ts"],
  "verification": [{"check": "cargo test", "result": "pass", "note": "all tests passed"}]
}

Rules:
- friction: past-tense, specific, actionable. What went wrong.
- constraints: forward-looking. What could invalidate this work.
- learnings.code: include file paths and line numbers where possible.
- approach: include rejected alternatives and why they were rejected.
- openItems: only things the next session needs to know about.
- verification: if tests, builds, or lints were run, record each as {"check": "<name>", "result": "pass"|"fail"|"skip", "note": "<optional detail>"}. Omit if no checks were run.
- Omit empty arrays. Keep every field concise.`;

export default function (pi: ExtensionAPI) {
  const state: RadContextState = {
    isRadicleRepo: false,
    radContextInstalled: false,
    repoId: null,
    contextCreatedThisSession: false,
    sessionStartTime: Date.now(),
    stashedConversation: null,
    stashedModifiedFiles: [],
    stashedReadFiles: [],
  };

  function isActive(): boolean {
    return state.isRadicleRepo && state.radContextInstalled;
  }

  /**
   * Shared extraction logic: takes a serialized conversation and file list,
   * calls Haiku to extract structured observations, creates the Context COB,
   * links commits, and announces.
   */
  async function extractAndCreateContext(
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
    conversation: string,
    modifiedFiles: string[],
  ): Promise<boolean> {
    const model = ctx.modelRegistry.find("anthropic", "claude-3-5-haiku-latest")
      ?? ctx.modelRegistry.find("anthropic", "claude-haiku-4-5");

    if (!model) {
      ctx.ui.notify("rad-context: no Haiku model found for context extraction", "warning");
      return false;
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      ctx.ui.notify(`rad-context: no API key for ${model.provider}`, "warning");
      return false;
    }

    ctx.ui.notify("Extracting session context...", "info");

    try {
      const fileList = modifiedFiles.length > 0
        ? `\n\nFiles modified during this session:\n${modifiedFiles.join("\n")}`
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

      if (!responseText) {
        ctx.ui.notify("rad-context: extraction returned empty response", "warning");
        return false;
      }

      let contextJson: Record<string, unknown>;
      try {
        contextJson = JSON.parse(responseText);
      } catch {
        ctx.ui.notify("rad-context: extraction returned invalid JSON", "warning");
        return false;
      }

      // Ensure filesTouched includes the mechanical file list
      if (modifiedFiles.length > 0) {
        const existing = Array.isArray(contextJson.filesTouched) ? contextJson.filesTouched as string[] : [];
        const merged = [...new Set([...existing, ...modifiedFiles])];
        contextJson.filesTouched = merged;
      }

      // Create the context COB
      const createResult = await pi.exec(
        "bash",
        ["-c", `echo '${JSON.stringify(contextJson).replace(/'/g, "'\\''")}' | rad-context create --json`],
        { timeout: 15000 },
      );

      if (createResult.code !== 0) {
        ctx.ui.notify(`rad-context: creation failed: ${createResult.stderr}`, "error");
        return false;
      }

      const contextId = createResult.stdout.trim().match(/([0-9a-f]{40})/)?.[1];

      if (contextId) {
        // Link commits from this session
        const logResult = await pi.exec(
          "git",
          ["log", "--format=%H", `--since=${new Date(state.sessionStartTime).toISOString()}`],
          { timeout: 5000 },
        );

        if (logResult.code === 0) {
          const commits = logResult.stdout.trim().split("\n").filter((l: string) => l.length > 0);
          for (const sha of commits) {
            await pi.exec("rad-context", ["link", contextId, "--commit", sha], { timeout: 5000 });
          }
        }

        await pi.exec("rad", ["sync", "--announce"], { timeout: 15000 });

        state.contextCreatedThisSession = true;
        ctx.ui.notify(`Context created: ${contextId.slice(0, 8)}`, "info");
      } else {
        state.contextCreatedThisSession = true;
        ctx.ui.notify("Context created", "info");
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`rad-context: extraction failed: ${message}`, "error");
      return false;
    }
  }

  /**
   * Get files modified since session start via git.
   */
  async function getModifiedFilesSinceStart(): Promise<string[]> {
    const since = new Date(state.sessionStartTime).toISOString();

    // Files modified in commits since session start
    const logResult = await pi.exec(
      "git", ["log", "--format=", "--name-only", `--since=${since}`],
      { timeout: 5000 },
    );
    const committedFiles = logResult.code === 0
      ? logResult.stdout.trim().split("\n").filter((l: string) => l.length > 0)
      : [];

    // Uncommitted modified files (staged + unstaged)
    const diffResult = await pi.exec("git", ["diff", "--name-only", "HEAD"], { timeout: 5000 });
    const uncommittedFiles = diffResult.code === 0
      ? diffResult.stdout.trim().split("\n").filter((l: string) => l.length > 0)
      : [];

    const stagedResult = await pi.exec("git", ["diff", "--name-only", "--cached"], { timeout: 5000 });
    const stagedFiles = stagedResult.code === 0
      ? stagedResult.stdout.trim().split("\n").filter((l: string) => l.length > 0)
      : [];

    return [...new Set([...committedFiles, ...uncommittedFiles, ...stagedFiles])];
  }

  // Detect Radicle repo and rad-context CLI
  pi.on("session_start", async (_event, ctx) => {
    state.sessionStartTime = Date.now();

    const radResult = await pi.exec("rad", ["."], { timeout: 5000 });
    if (radResult.code !== 0) return;

    state.isRadicleRepo = true;
    state.repoId = radResult.stdout.trim();

    const whichResult = await pi.exec("which", ["rad-context"], { timeout: 3000 });
    if (whichResult.code !== 0) return;

    state.radContextInstalled = true;

    const listResult = await pi.exec("rad-context", ["list"], { timeout: 5000 });
    const contextCount = listResult.code === 0
      ? listResult.stdout.trim().split("\n").filter((l: string) => l.length > 0).length
      : 0;

    let msg = `Radicle repo: ${state.repoId}`;
    if (contextCount > 0) {
      msg += ` · ${contextCount} context${contextCount === 1 ? "" : "s"}`;
    }
    ctx.ui.notify(msg, "info");
  });

  // Mid-session: stash conversation data before compaction proceeds
  pi.on("session_before_compact", async (event, _ctx) => {
    if (!isActive()) return;

    const { preparation } = event;
    const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];

    if (allMessages.length === 0) return;

    state.stashedConversation = serializeConversation(convertToLlm(allMessages));
    state.stashedModifiedFiles = preparation.fileOps?.modifiedFiles ?? [];
    state.stashedReadFiles = preparation.fileOps?.readFiles ?? [];
  });

  // Mid-session: after compaction, extract context from the compacted portion
  pi.on("session_compact", async (_event, ctx) => {
    if (!isActive()) return;
    if (!state.stashedConversation) return;

    const conversation = state.stashedConversation;
    const modifiedFiles = state.stashedModifiedFiles;

    state.stashedConversation = null;
    state.stashedModifiedFiles = [];
    state.stashedReadFiles = [];

    await extractAndCreateContext(ctx, conversation, modifiedFiles);
  });

  // End of session: extract context from the full conversation
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isActive()) return;
    if (state.contextCreatedThisSession) return;

    // Build the current conversation from session entries
    const entries = ctx.sessionManager.getEntries();
    if (entries.length === 0) return;

    const sessionContext = buildSessionContext(entries, ctx.sessionManager.getLeafId());
    if (sessionContext.messages.length === 0) return;

    // Skip trivially short sessions (fewer than 2 assistant messages)
    const assistantMessages = sessionContext.messages.filter(m => m.role === "assistant");
    if (assistantMessages.length < 2) return;

    const conversation = serializeConversation(convertToLlm(sessionContext.messages));
    const modifiedFiles = await getModifiedFilesSinceStart();

    await extractAndCreateContext(ctx, conversation, modifiedFiles);
  });

  // Manual /rad-context command
  pi.registerCommand("rad-context", {
    description: "Manage Context COBs (create, list, show)",
    handler: async (args, ctx) => {
      if (!isActive()) {
        ctx.ui.notify("Not a Radicle repo or rad-context not installed", "warning");
        return;
      }

      const subcommand = args?.trim().split(/\s+/)[0];
      const rest = args?.trim().slice(subcommand?.length ?? 0).trim();

      if (subcommand === "list" || !subcommand) {
        const result = await pi.exec("rad-context", ["list"], { timeout: 10000 });
        if (result.code === 0 && result.stdout.trim()) {
          ctx.ui.notify(result.stdout.trim(), "info");
        } else {
          ctx.ui.notify("No contexts found. Use /rad-context create to create one.", "info");
        }
      } else if (subcommand === "show" && rest) {
        const result = await pi.exec("rad-context", ["show", rest], { timeout: 10000 });
        if (result.code === 0) {
          ctx.ui.notify(result.stdout.trim(), "info");
        } else {
          ctx.ui.notify(`Failed to show context: ${result.stderr}`, "error");
        }
      } else if (subcommand === "create") {
        pi.sendUserMessage(
          "Reflect on this session and create a Context COB. Use the rad-contexts skill for the workflow: gather git data, reflect on approach/constraints/friction/learnings/open items, then pipe JSON to `rad-context create --json`. Present the draft for my review before creating.",
          { deliverAs: "followUp" },
        );
      } else {
        ctx.ui.notify("Usage: /rad-context [list | show <id> | create]", "info");
      }
    },
  });
}
