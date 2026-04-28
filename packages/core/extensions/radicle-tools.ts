import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  detectTools,
  listOpenIssues,
  getIssueDetails,
  pushPatch,
  getCurrentBranch,
  type ToolRegistry,
} from "../lib/rad-shared.ts";

function parsePatchIds(text: string): string[] {
  return [...text.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]);
}

function joinOutput(stdout: string, stderr: string): string {
  return stdout.trim() || stderr.trim() || "(no output)";
}

export default function (pi: ExtensionAPI) {
  let reg: ToolRegistry = {
    isRadicleRepo: false,
    repoId: null,
    tools: new Map(),
  };

  pi.on("session_start", async () => {
    reg = await detectTools(pi, [
      { name: "rad-plan" },
      { name: "rad-context" },
    ]);
  });

  pi.registerTool({
    name: "rad_repo_probe",
    label: "Rad Repo Probe",
    description: "Inspect the current repository for Radicle status, current branch, node status, and optional tool availability.",
    promptSnippet: "Probe the current repository's Radicle capabilities and status in one call",
    promptGuidelines: [
      "Use rad_repo_probe at the start of Radicle work when you need to know whether the cwd is a Radicle repo, what branch you are on, whether the node is running, and which optional Radicle CLIs are available.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const branch = await getCurrentBranch(pi).catch(() => null);
      const nodeResult = await pi.exec("rad", ["node", "status"], { timeout: 5000 }).catch(() => null);

      const details = {
        isRadicleRepo: reg.isRadicleRepo,
        repoId: reg.repoId,
        branch,
        nodeRunning: nodeResult?.code === 0,
        optionalTools: Object.fromEntries(reg.tools.entries()),
        nodeStatus: nodeResult?.stdout?.trim() || nodeResult?.stderr?.trim() || "",
      };

      return {
        content: [{
          type: "text",
          text: reg.isRadicleRepo
            ? `Radicle repo ${reg.repoId ?? "(unknown)"} on branch ${details.branch ?? "(unknown)"}`
            : "Current directory is not a Radicle repository",
        }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "rad_self_show",
    label: "Rad Self",
    description: "Show the current Radicle identity, including DID, node ID, alias, and home directory.",
    promptSnippet: "Show the current Radicle identity deterministically",
    promptGuidelines: [
      "Use rad_self_show when the user asks who they are in Radicle, asks for their DID or node ID, or when identity context is needed before another Radicle action.",
    ],
    parameters: Type.Object({
      didOnly: Type.Optional(Type.Boolean({ description: "Return only the DID" })),
      nidOnly: Type.Optional(Type.Boolean({ description: "Return only the node ID" })),
      homeOnly: Type.Optional(Type.Boolean({ description: "Return only the Radicle home directory" })),
    }),
    async execute(_toolCallId, params) {
      const args = ["self"];
      if (params.didOnly) args.push("--did");
      else if (params.nidOnly) args.push("--nid");
      else if (params.homeOnly) args.push("--home");

      const result = await pi.exec("rad", args, { timeout: 5000 });
      return {
        content: [{ type: "text", text: result.stdout.trim() || result.stderr.trim() || "(no output)" }],
        details: {
          ok: result.code === 0,
          args,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_node_status",
    label: "Rad Node Status",
    description: "Show whether the Radicle node is running and return the raw node status output.",
    promptSnippet: "Check whether the Radicle node is running before network actions",
    promptGuidelines: [
      "Use rad_node_status before sync, clone, seeding, or patch operations when network availability is uncertain.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await pi.exec("rad", ["node", "status"], { timeout: 5000 });
      return {
        content: [{ type: "text", text: result.stdout.trim() || result.stderr.trim() || "(no output)" }],
        details: {
          ok: result.code === 0,
          running: result.code === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_sync",
    label: "Rad Sync",
    description: "Synchronize the current repository with the Radicle network using sync, fetch-only, or announce-only mode.",
    promptSnippet: "Synchronize the current Radicle repository deterministically",
    promptGuidelines: [
      "Use rad_sync instead of shelling out to rad sync directly when syncing, fetching, or announcing is the user's main intent.",
    ],
    parameters: Type.Object({
      fetchOnly: Type.Optional(Type.Boolean({ description: "Only fetch; do not announce" })),
      announceOnly: Type.Optional(Type.Boolean({ description: "Only announce; do not fetch" })),
    }),
    async execute(_toolCallId, params) {
      const args = ["sync"];
      if (params.fetchOnly) args.push("--fetch");
      if (params.announceOnly) args.push("--announce");

      const result = await pi.exec("rad", args, { timeout: 30000 });
      return {
        content: [{ type: "text", text: result.stdout.trim() || result.stderr.trim() || "(no output)" }],
        details: {
          ok: result.code === 0,
          mode: params.fetchOnly ? "fetch" : params.announceOnly ? "announce" : "sync",
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_issue_list",
    label: "Rad Issue List",
    description: "List issues in the current Radicle repository with optional state and label filtering.",
    promptSnippet: "List Radicle issues as structured data instead of relying on shell parsing",
    promptGuidelines: [
      "Use rad_issue_list when the user asks to list, inspect, or choose issues in the current Radicle repository.",
    ],
    parameters: Type.Object({
      state: Type.Optional(Type.Union([
        Type.Literal("open"),
        Type.Literal("closed"),
      ], { description: "Issue state filter" })),
      labels: Type.Optional(Type.Array(Type.String(), { description: "Filter issues by labels" })),
    }),
    async execute(_toolCallId, params) {
      if (!reg.isRadicleRepo) {
        return {
          content: [{ type: "text", text: "Current directory is not a Radicle repository" }],
          details: { ok: false, issues: [] },
        };
      }

      if (params.state === "closed") {
        const result = await pi.exec("rad", ["issue", "list", "--state", "closed"], { timeout: 10000 });
        return {
          content: [{ type: "text", text: result.stdout.trim() || result.stderr.trim() || "(no output)" }],
          details: {
            ok: result.code === 0,
            state: "closed",
            raw: result.stdout.trim(),
          },
        };
      }

      const issues = await listOpenIssues(pi, params.labels);
      return {
        content: [{ type: "text", text: issues.length === 0 ? "No matching open issues" : `Found ${issues.length} open issue(s)` }],
        details: {
          ok: true,
          state: "open",
          issues,
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_issue_show",
    label: "Rad Issue Show",
    description: "Show one issue from the current Radicle repository as structured data.",
    promptSnippet: "Load a Radicle issue as structured data",
    promptGuidelines: [
      "Use rad_issue_show when you need the actual title, description, labels, assignees, or discussion of a specific issue before taking another action.",
    ],
    parameters: Type.Object({
      issueId: Type.String({ description: "Issue ID, short or full" }),
    }),
    async execute(_toolCallId, params) {
      const issue = await getIssueDetails(pi, params.issueId);
      return {
        content: [{ type: "text", text: issue ? `${issue.id.slice(0, 7)}: ${issue.title}` : `Issue not found: ${params.issueId}` }],
        details: {
          ok: !!issue,
          issue,
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_patch_list",
    label: "Rad Patch List",
    description: "List patches in the current Radicle repository, optionally filtering by state.",
    promptSnippet: "List Radicle patches deterministically",
    promptGuidelines: [
      "Use rad_patch_list when the user asks to list or inspect patches in the current repository.",
    ],
    parameters: Type.Object({
      state: Type.Optional(Type.Union([
        Type.Literal("open"),
        Type.Literal("draft"),
        Type.Literal("merged"),
        Type.Literal("archived"),
      ], { description: "Patch state filter" })),
    }),
    async execute(_toolCallId, params) {
      const state = params.state ?? "open";
      const result = await pi.exec("rad", ["patch", "list", "--state", state], { timeout: 10000 });
      return {
        content: [{ type: "text", text: result.stdout.trim() || result.stderr.trim() || "(no output)" }],
        details: {
          ok: result.code === 0,
          state,
          patchIds: parsePatchIds(result.stdout),
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_patch_show",
    label: "Rad Patch Show",
    description: "Show one patch from the current Radicle repository.",
    promptSnippet: "Show a Radicle patch deterministically",
    promptGuidelines: [
      "Use rad_patch_show when you need the details of a specific patch before reviewing, checking out, or discussing it.",
    ],
    parameters: Type.Object({
      patchId: Type.String({ description: "Patch ID, short or full" }),
    }),
    async execute(_toolCallId, params) {
      const result = await pi.exec("rad", ["patch", "show", params.patchId], { timeout: 10000 });
      return {
        content: [{ type: "text", text: result.stdout.trim() || result.stderr.trim() || "(no output)" }],
        details: {
          ok: result.code === 0,
          patchId: params.patchId,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_issue_comment",
    label: "Rad Issue Comment",
    description: "Comment on a Radicle issue using a non-interactive message.",
    promptSnippet: "Comment on a Radicle issue without relying on shell syntax",
    promptGuidelines: [
      "Use rad_issue_comment when the user wants to comment on an issue and the message text is already known.",
    ],
    parameters: Type.Object({
      issueId: Type.String({ description: "Issue ID, short or full" }),
      message: Type.String({ description: "Exact comment message" }),
    }),
    async execute(_toolCallId, params) {
      const result = await pi.exec("rad", ["issue", "comment", params.issueId, "--message", params.message], { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          issueId: params.issueId,
          message: params.message,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_issue_update_state",
    label: "Rad Issue Update State",
    description: "Close or reopen a Radicle issue.",
    promptSnippet: "Change a Radicle issue state deterministically",
    promptGuidelines: [
      "Use rad_issue_update_state when the user explicitly wants an issue opened or closed.",
    ],
    parameters: Type.Object({
      issueId: Type.String({ description: "Issue ID, short or full" }),
      state: Type.Union([
        Type.Literal("open"),
        Type.Literal("closed"),
      ], { description: "Target issue state" }),
    }),
    async execute(_toolCallId, params) {
      const flag = params.state === "closed" ? "--closed" : "--open";
      const result = await pi.exec("rad", ["issue", "state", params.issueId, flag], { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          issueId: params.issueId,
          state: params.state,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_issue_update_labels",
    label: "Rad Issue Update Labels",
    description: "Add and/or remove labels from a Radicle issue.",
    promptSnippet: "Update issue labels deterministically",
    promptGuidelines: [
      "Use rad_issue_update_labels when the user wants labels added or removed from an issue.",
    ],
    parameters: Type.Object({
      issueId: Type.String({ description: "Issue ID, short or full" }),
      add: Type.Optional(Type.Array(Type.String(), { description: "Labels to add" })),
      remove: Type.Optional(Type.Array(Type.String(), { description: "Labels to remove" })),
    }),
    async execute(_toolCallId, params) {
      const add = params.add ?? [];
      const remove = params.remove ?? [];
      const actions: Array<{ action: string; label: string; ok: boolean; stdout: string; stderr: string }> = [];

      for (const label of add) {
        const result = await pi.exec("rad", ["issue", "label", params.issueId, "--add", label], { timeout: 10000 });
        actions.push({ action: "add", label, ok: result.code === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
      }
      for (const label of remove) {
        const result = await pi.exec("rad", ["issue", "label", params.issueId, "--delete", label], { timeout: 10000 });
        actions.push({ action: "remove", label, ok: result.code === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
      }

      const ok = actions.every((a) => a.ok);
      return {
        content: [{ type: "text", text: ok ? `Updated labels on issue ${params.issueId}` : `Some label updates failed for issue ${params.issueId}` }],
        details: {
          ok,
          issueId: params.issueId,
          actions,
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_sync_status",
    label: "Rad Sync Status",
    description: "Show sync status for the current Radicle repository.",
    promptSnippet: "Inspect Radicle sync status without using raw shell parsing",
    promptGuidelines: [
      "Use rad_sync_status when the user asks whether the repository is synced, fetched, or announced to peers.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await pi.exec("rad", ["sync", "status"], { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_patch_checkout",
    label: "Rad Patch Checkout",
    description: "Checkout a patch branch locally.",
    promptSnippet: "Checkout a Radicle patch deterministically",
    promptGuidelines: [
      "Use rad_patch_checkout when the user wants to test, inspect, or work on an existing patch locally.",
    ],
    parameters: Type.Object({
      patchId: Type.String({ description: "Patch ID, short or full" }),
    }),
    async execute(_toolCallId, params) {
      const result = await pi.exec("rad", ["patch", "checkout", params.patchId], { timeout: 20000 });
      const branch = await getCurrentBranch(pi).catch(() => null);
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          patchId: params.patchId,
          branch,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_patch_update_revision",
    label: "Rad Patch Update Revision",
    description: "Update the current patch revision by force-pushing the current branch.",
    promptSnippet: "Update an existing Radicle patch revision deterministically",
    promptGuidelines: [
      "Use rad_patch_update_revision when the user asks to update, refresh, or push new commits to an already-open patch.",
    ],
    parameters: Type.Object({}),
    async execute() {
      // Guard: refuse if on main/master — patch updates must come from a feature branch
      const branch = await getCurrentBranch(pi);
      if (!branch || branch === "main" || branch === "master") {
        return {
          content: [{ type: "text", text: `Not on a feature branch (currently: ${branch ?? "detached"}) — will not force-push from main/master` }],
          details: { ok: false, branch, reason: "not_a_feature_branch" },
        };
      }

      // Guard: verify at least one open patch exists (confirms we're in a patch workflow)
      const patchListResult = await pi.exec("rad", ["patch", "list", "--state", "open"], { timeout: 10000 });
      if (patchListResult.code !== 0 || !patchListResult.stdout.trim()) {
        return {
          content: [{ type: "text", text: "No open patches found — nothing to update. Use rad_patch_submit to create a patch first." }],
          details: { ok: false, branch, reason: "no_open_patches" },
        };
      }

      const result = await pi.exec("git", ["push", "--force"], { timeout: 30000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          branch,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_patch_review",
    label: "Rad Patch Review",
    description: "Review a Radicle patch by accepting or rejecting it with an optional message.",
    promptSnippet: "Review a Radicle patch deterministically",
    promptGuidelines: [
      "Use rad_patch_review when the user wants to accept or reject a patch review and the review decision is explicit.",
    ],
    parameters: Type.Object({
      patchId: Type.String({ description: "Patch ID, short or full" }),
      decision: Type.Union([
        Type.Literal("accept"),
        Type.Literal("reject"),
      ], { description: "Review decision" }),
      message: Type.Optional(Type.String({ description: "Optional review message" })),
    }),
    async execute(_toolCallId, params) {
      const args = ["patch", "review", params.patchId, params.decision === "accept" ? "--accept" : "--reject"];
      if (params.message) args.push("--message", params.message);
      const result = await pi.exec("rad", args, { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          patchId: params.patchId,
          decision: params.decision,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_clone",
    label: "Rad Clone",
    description: "Clone a Radicle repository by RID, with an optional destination path.",
    promptSnippet: "Clone a Radicle repository deterministically",
    promptGuidelines: [
      "Use rad_clone when the user asks to clone a repository by RID or Radicle URL.",
    ],
    parameters: Type.Object({
      rid: Type.String({ description: "Repository ID like rad:z..." }),
      path: Type.Optional(Type.String({ description: "Optional destination path" })),
    }),
    async execute(_toolCallId, params) {
      const args = ["clone", params.rid];
      if (params.path) args.push("--path", params.path);
      const result = await pi.exec("rad", args, { timeout: 60000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          rid: params.rid,
          path: params.path ?? null,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_remote_list",
    label: "Rad Remote List",
    description: "List stored remotes for the current Radicle repository.",
    promptSnippet: "List Radicle remotes deterministically",
    promptGuidelines: [
      "Use rad_remote_list when the user asks what Radicle remotes or peers are tracked in the current repository.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await pi.exec("rad", ["remote", "list"], { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_remote_add",
    label: "Rad Remote Add",
    description: "Add a Radicle peer as a remote, with an optional local name.",
    promptSnippet: "Add a Radicle remote deterministically",
    promptGuidelines: [
      "Use rad_remote_add when the user wants to track a Radicle peer by node ID.",
    ],
    parameters: Type.Object({
      nid: Type.String({ description: "Peer node ID" }),
      name: Type.Optional(Type.String({ description: "Optional local remote name" })),
    }),
    async execute(_toolCallId, params) {
      const args = ["remote", "add", params.nid];
      if (params.name) args.push("--name", params.name);
      const result = await pi.exec("rad", args, { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          nid: params.nid,
          name: params.name ?? null,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_inspect",
    label: "Rad Inspect",
    description: "Inspect the current Radicle repository or its delegates.",
    promptSnippet: "Inspect Radicle repository metadata deterministically",
    promptGuidelines: [
      "Use rad_inspect when the user wants repository metadata such as delegates or general repository inspection.",
    ],
    parameters: Type.Object({
      delegatesOnly: Type.Optional(Type.Boolean({ description: "Show only delegates" })),
    }),
    async execute(_toolCallId, params) {
      const args = params.delegatesOnly ? ["inspect", "--delegates"] : ["inspect"];
      const result = await pi.exec("rad", args, { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          delegatesOnly: !!params.delegatesOnly,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_patch_assign",
    label: "Rad Patch Assign",
    description: "Assign a Radicle patch to a DID.",
    promptSnippet: "Assign a Radicle patch deterministically",
    promptGuidelines: [
      "Use rad_patch_assign when the user wants to assign a patch to a specific DID.",
    ],
    parameters: Type.Object({
      patchId: Type.String({ description: "Patch ID, short or full" }),
      did: Type.String({ description: "Assignee DID" }),
    }),
    async execute(_toolCallId, params) {
      const result = await pi.exec("rad", ["patch", "assign", "--add", params.did, params.patchId], { timeout: 10000 });
      return {
        content: [{ type: "text", text: joinOutput(result.stdout, result.stderr) }],
        details: {
          ok: result.code === 0,
          patchId: params.patchId,
          did: params.did,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      };
    },
  });

  pi.registerTool({
    name: "rad_patch_submit",
    label: "Rad Patch Submit",
    description: "Create a new patch from the current HEAD by pushing to refs/patches and return the created patch ID when available.",
    promptSnippet: "Create a Radicle patch from the current branch deterministically",
    promptGuidelines: [
      "Use rad_patch_submit when the user asks to create, open, or submit a patch from the current branch.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const patchId = await pushPatch(pi);
      return {
        content: [{ type: "text", text: patchId ? `Patch created: ${patchId}` : "Failed to create patch" }],
        details: {
          ok: !!patchId,
          patchId,
        },
      };
    },
  });
}
