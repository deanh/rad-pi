import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type ToolRegistry,
  type ToolLevel,
  hasTool,
  requireTools,
  getRepoId,
  listPatchIds,
  commentOnIssue,
  setIssueState,
  getCurrentBranch,
  hasWorkingTreeChanges,
  getHeadSha,
  getMergeBase,
  pushPatch,
} from "../lib/rad-shared.ts";

// --- hasTool ---

describe("hasTool", () => {
  function makeReg(tools: Record<string, ToolLevel>, opts?: { isRadicleRepo?: boolean }): ToolRegistry {
    return {
      isRadicleRepo: opts?.isRadicleRepo ?? true,
      repoId: opts?.isRadicleRepo === false ? null : "rad:z123",
      tools: new Map(Object.entries(tools)),
    };
  }

  it("returns true when tool has 'full' level and default minLevel", () => {
    const reg = makeReg({ "rad-plan": "full" });
    assert.equal(hasTool(reg, "rad-plan"), true);
  });

  it("returns false when tool has 'read' level and default minLevel ('full')", () => {
    const reg = makeReg({ "rad-plan": "read" });
    assert.equal(hasTool(reg, "rad-plan"), false);
  });

  it("returns false when tool is not in the registry", () => {
    const reg = makeReg({});
    assert.equal(hasTool(reg, "rad-plan"), false);
  });

  it("returns true when tool has 'read' level and minLevel is 'read'", () => {
    const reg = makeReg({ "rad-plan": "read" });
    assert.equal(hasTool(reg, "rad-plan", "read"), true);
  });

  it("returns true when tool has 'full' level and minLevel is 'read'", () => {
    const reg = makeReg({ "rad-plan": "full" });
    assert.equal(hasTool(reg, "rad-plan", "read"), true);
  });

  it("returns false when tool has 'none' level regardless of minLevel", () => {
    const reg = makeReg({ "rad-plan": "none" });
    assert.equal(hasTool(reg, "rad-plan"), false);
    assert.equal(hasTool(reg, "rad-plan", "read"), false);
    assert.equal(hasTool(reg, "rad-plan", "none"), true);
  });
});

// --- requireTools ---

describe("requireTools", () => {
  it("returns false with 'Not a Radicle repository' when not a radicle repo", () => {
    const reg: ToolRegistry = {
      isRadicleRepo: false,
      repoId: null,
      tools: new Map(),
    };
    const notifications: Array<{ msg: string; level?: string }> = [];
    const ctx = { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => { notifications.push({ msg, level }); } } };

    const result = requireTools(reg, ctx, ["rad-plan"]);
    assert.equal(result, false);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].msg, /Not a Radicle repository/);
    assert.equal(notifications[0].level, "error");
  });

  it("returns false with install hint when tool is missing", () => {
    const reg: ToolRegistry = {
      isRadicleRepo: true,
      repoId: "rad:z123",
      tools: new Map([["rad-plan", "none"]]),
    };
    const notifications: Array<{ msg: string; level?: string }> = [];
    const ctx = { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => { notifications.push({ msg, level }); } } };

    const result = requireTools(reg, ctx, ["rad-plan"], {
      "rad-plan": "Install from: rad clone rad:z123",
    });
    assert.equal(result, false);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].msg, /rad-plan not installed/);
    assert.match(notifications[0].msg, /rad clone rad:z123/);
  });

  it("returns true when all tools are at 'full' level", () => {
    const reg: ToolRegistry = {
      isRadicleRepo: true,
      repoId: "rad:z123",
      tools: new Map([["rad-plan", "full"], ["rad-context", "full"]]),
    };
    const notifications: Array<{ msg: string; level?: string }> = [];
    const ctx = { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => { notifications.push({ msg, level }); } } };

    const result = requireTools(reg, ctx, ["rad-plan", "rad-context"]);
    assert.equal(result, true);
    assert.equal(notifications.length, 0);
  });

  it("returns true when no tools required (empty array)", () => {
    const reg: ToolRegistry = {
      isRadicleRepo: true,
      repoId: "rad:z123",
      tools: new Map(),
    };
    const notifications: Array<{ msg: string; level?: string }> = [];
    const ctx = { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => { notifications.push({ msg, level }); } } };

    const result = requireTools(reg, ctx, []);
    assert.equal(result, true);
    assert.equal(notifications.length, 0);
  });

  it("reports first missing tool only", () => {
    const reg: ToolRegistry = {
      isRadicleRepo: true,
      repoId: "rad:z123",
      tools: new Map(),
    };
    const notifications: Array<{ msg: string; level?: string }> = [];
    const ctx = { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => { notifications.push({ msg, level }); } } };

    const result = requireTools(reg, ctx, ["rad-plan", "rad-context"]);
    assert.equal(result, false);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].msg, /rad-plan not installed/);
  });
});

// --- command helpers ---

describe("command helpers", () => {
  function makePi(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    return {
      exec: async (cmd: string, args: string[]) => {
        const key = [cmd, ...args].join(" ");
        const response = responses[key] ?? { code: 1, stdout: "", stderr: "missing mock" };
        return {
          code: response.code,
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
        };
      },
    } as any;
  }

  it("getRepoId returns current RID when rad dot succeeds", async () => {
    const pi = makePi({
      "rad .": { code: 0, stdout: "rad:z123\n" },
    });
    assert.equal(await getRepoId(pi), "rad:z123");
  });

  it("listPatchIds returns patch ids from cob list output", async () => {
    const pi = makePi({
      "rad cob list --repo rad:z123 --type xyz.radicle.patch": { code: 0, stdout: "abc123\ndef456\n" },
    });
    assert.deepEqual(await listPatchIds(pi, "rad:z123"), ["abc123", "def456"]);
  });

  it("pushPatch supports patch.base and other push options", async () => {
    const sha = "1234567890abcdef1234567890abcdef12345678";
    const pi = makePi({
      "git push rad -o patch.draft -o patch.base=deadbeef -o patch.branch=feature/test -o no-sync HEAD:refs/patches": {
        code: 0,
        stderr: `created patch ${sha}\n`,
      },
    });
    assert.equal(await pushPatch(pi, { base: "deadbeef", draft: true, branch: "feature/test", noSync: true }), sha);
  });

  it("commentOnIssue returns true when rad issue comment succeeds", async () => {
    const pi = makePi({
      "rad issue comment abc123 --message hello": { code: 0, stdout: "ok\n" },
    });
    assert.equal(await commentOnIssue(pi, "abc123", "hello"), true);
  });

  it("setIssueState uses --closed for closed state", async () => {
    const pi = makePi({
      "rad issue state abc123 --closed": { code: 0, stdout: "ok\n" },
    });
    assert.equal(await setIssueState(pi, "abc123", "closed"), true);
  });

  it("setIssueState uses --open for open state", async () => {
    const pi = makePi({
      "rad issue state abc123 --open": { code: 0, stdout: "ok\n" },
    });
    assert.equal(await setIssueState(pi, "abc123", "open"), true);
  });

  it("getCurrentBranch returns the current branch", async () => {
    const pi = makePi({
      "git branch --show-current": { code: 0, stdout: "feature/test\n" },
    });
    assert.equal(await getCurrentBranch(pi), "feature/test");
  });

  it("hasWorkingTreeChanges returns true when porcelain output is non-empty", async () => {
    const pi = makePi({
      "git status --porcelain": { code: 0, stdout: " M file.ts\n" },
    });
    assert.equal(await hasWorkingTreeChanges(pi), true);
  });

  it("getHeadSha returns HEAD sha", async () => {
    const pi = makePi({
      "git rev-parse HEAD": { code: 0, stdout: "deadbeef\n" },
    });
    assert.equal(await getHeadSha(pi), "deadbeef");
  });

  it("getMergeBase returns the merge base", async () => {
    const pi = makePi({
      "git merge-base main HEAD": { code: 0, stdout: "cafebabe\n" },
    });
    assert.equal(await getMergeBase(pi, "main", "HEAD"), "cafebabe");
  });
});
