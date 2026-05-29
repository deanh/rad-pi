import { describe, it } from "node:test";
import assert from "node:assert/strict";
import registerCoreRadicleTools from "../extensions/radicle-tools.ts";

type ToolDef = {
  name: string;
  execute: (...args: any[]) => Promise<any>;
};

function setup(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
  const tools: ToolDef[] = [];
  const pi = {
    on: async (event: string, handler: () => Promise<void>) => {
      if (event === "session_start") await handler();
    },
    exec: async (cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(" ");
      const response = responses[key] ?? { code: 1, stdout: "", stderr: `missing mock: ${key}` };
      return {
        code: response.code,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    },
    registerTool: (tool: ToolDef) => {
      tools.push(tool);
    },
  } as any;

  registerCoreRadicleTools(pi);
  return {
    tool(name: string) {
      const found = tools.find((t) => t.name === name);
      assert.ok(found, `tool not registered: ${name}`);
      return found;
    },
  };
}

describe("core radicle tools", () => {
  it("rad_patch_review accepts a patch with a message", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad patch review abc123 --accept -m looks good": { code: 0, stdout: "accepted\n" },
    });
    const result = await s.tool("rad_patch_review").execute("1", { patchId: "abc123", decision: "accept", message: "looks good" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.patchId, "abc123");
    assert.equal(result.details.decision, "accept");
  });

  it("rad_clone passes optional path through to rad clone", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad clone rad:zabc ./repo": { code: 0, stdout: "cloned\n" },
    });
    const result = await s.tool("rad_clone").execute("1", { rid: "rad:zabc", path: "./repo" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.rid, "rad:zabc");
    assert.equal(result.details.path, "./repo");
  });

  it("rad_remote_add includes optional name", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad remote add z6Mknode --name alice": { code: 0, stdout: "ok\n" },
    });
    const result = await s.tool("rad_remote_add").execute("1", { nid: "z6Mknode", name: "alice" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.nid, "z6Mknode");
    assert.equal(result.details.name, "alice");
  });

  it("rad_inspect uses delegates flag when requested", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad inspect --delegates": { code: 0, stdout: "delegate list\n" },
    });
    const result = await s.tool("rad_inspect").execute("1", { delegatesOnly: true });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.delegatesOnly, true);
  });

  it("rad_patch_assign adds the DID assignee", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad patch assign abc123 --add did:key:zabc": { code: 0, stdout: "assigned\n" },
    });
    const result = await s.tool("rad_patch_assign").execute("1", { patchId: "abc123", did: "did:key:zabc" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.patchId, "abc123");
    assert.equal(result.details.did, "did:key:zabc");
  });

  it("rad_patch_show includes --patch when diff is requested", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad patch show abc123 --patch": { code: 0, stdout: "patch details with diff\n" },
    });
    const result = await s.tool("rad_patch_show").execute("1", { patchId: "abc123", includeDiff: true });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.patchId, "abc123");
    assert.equal(result.details.includeDiff, true);
  });

  it("rad_patch_update_revision refuses when on main", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "git branch --show-current": { code: 0, stdout: "main\n" },
    });
    const result = await s.tool("rad_patch_update_revision").execute("1", {});
    assert.equal(result.details.ok, false);
    assert.equal(result.details.reason, "not_a_feature_branch");
    assert.match(result.content[0].text, /Not on a feature branch/);
  });

  it("rad_patch_update_revision refuses when no open patches", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "git branch --show-current": { code: 0, stdout: "feature/test\n" },
      "rad patch list": { code: 0, stdout: "" },
    });
    const result = await s.tool("rad_patch_update_revision").execute("1", {});
    assert.equal(result.details.ok, false);
    assert.equal(result.details.reason, "no_open_patches");
    assert.match(result.content[0].text, /No open patches/);
  });

  it("rad_patch_update_revision force-pushes when on feature branch with open patches", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "git branch --show-current": { code: 0, stdout: "feature/test\n" },
      "rad patch list": { code: 0, stdout: "abc123 some patch\n" },
      "git push --force": { code: 0, stdout: "updated\n" },
    });
    const result = await s.tool("rad_patch_update_revision").execute("1", {});
    assert.equal(result.details.ok, true);
    assert.equal(result.details.branch, "feature/test");
  });

  it("rad_patch_submit passes patch.base when a non-default base is requested", async () => {
    const sha = "1234567890abcdef1234567890abcdef12345678";
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "git push rad -o patch.base=deadbeef HEAD:refs/patches": { code: 0, stderr: `created patch ${sha}\n` },
    });
    const result = await s.tool("rad_patch_submit").execute("1", { base: "deadbeef" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.patchId, sha);
    assert.equal(result.details.base, "deadbeef");
  });

  it("rad_repo_probe surfaces repo, branch, node status, and tool registry", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 0 },
      "which rad-context": { code: 1 },
      "git branch --show-current": { code: 0, stdout: "feature/test\n" },
      "rad node status": { code: 0, stdout: "running\n" },
    });
    const result = await s.tool("rad_repo_probe").execute("1", {});
    assert.equal(result.details.isRadicleRepo, true);
    assert.equal(result.details.repoId, "rad:z123");
    assert.equal(result.details.branch, "feature/test");
    assert.equal(result.details.nodeRunning, true);
    assert.equal(result.details.optionalTools["rad-plan"], "full");
    assert.equal(result.details.optionalTools["rad-context"], "none");
  });

  it("rad_self_show passes --did when didOnly is set", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad self --did": { code: 0, stdout: "did:key:z6Mk\n" },
    });
    const result = await s.tool("rad_self_show").execute("1", { didOnly: true });
    assert.equal(result.details.ok, true);
    assert.deepEqual(result.details.args, ["self", "--did"]);
  });

  it("rad_self_show uses rad node status --only nid when nidOnly is set", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad node status --only nid": { code: 0, stdout: "z6MkfuXg\n" },
    });
    const result = await s.tool("rad_self_show").execute("1", { nidOnly: true });
    assert.equal(result.details.ok, true);
    assert.deepEqual(result.details.args, ["node", "status", "--only", "nid"]);
  });

  it("rad_node_status reports running when the node responds", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad node status": { code: 0, stdout: "running\n" },
    });
    const result = await s.tool("rad_node_status").execute("1", {});
    assert.equal(result.details.ok, true);
    assert.equal(result.details.running, true);
  });

  it("rad_sync uses --fetch when fetchOnly is set", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad sync --fetch": { code: 0, stdout: "ok\n" },
    });
    const result = await s.tool("rad_sync").execute("1", { fetchOnly: true });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.mode, "fetch");
  });

  it("rad_sync uses --announce when announceOnly is set", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad sync --announce": { code: 0, stdout: "ok\n" },
    });
    const result = await s.tool("rad_sync").execute("1", { announceOnly: true });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.mode, "announce");
  });

  it("rad_patch_list defaults to open state and parses patch ids from output", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad patch list": { code: 0, stdout: "abc1234 some patch\ndef5678 another\n" },
    });
    const result = await s.tool("rad_patch_list").execute("1", {});
    assert.equal(result.details.ok, true);
    assert.equal(result.details.state, "open");
    assert.deepEqual(result.details.patchIds, ["abc1234", "def5678"]);
  });

  it("rad_issue_comment posts a message via rad issue comment", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad issue comment abc123 --message hello there": { code: 0, stdout: "commented\n" },
    });
    const result = await s.tool("rad_issue_comment").execute("1", { issueId: "abc123", message: "hello there" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.issueId, "abc123");
    assert.equal(result.details.message, "hello there");
  });

  it("rad_issue_update_state uses --closed when closing", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad issue state abc123 --closed": { code: 0, stdout: "closed\n" },
    });
    const result = await s.tool("rad_issue_update_state").execute("1", { issueId: "abc123", state: "closed" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.state, "closed");
  });

  it("rad_issue_update_labels adds and removes labels in sequence", async () => {
    const s = setup({
      "rad .": { code: 0, stdout: "rad:z123\n" },
      "which rad-plan": { code: 1 },
      "which rad-context": { code: 1 },
      "rad issue label abc123 --add bug": { code: 0, stdout: "ok\n" },
      "rad issue label abc123 --delete wontfix": { code: 0, stdout: "ok\n" },
    });
    const result = await s.tool("rad_issue_update_labels").execute("1", { issueId: "abc123", add: ["bug"], remove: ["wontfix"] });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.actions.length, 2);
    assert.equal(result.details.actions[0].action, "add");
    assert.equal(result.details.actions[0].label, "bug");
    assert.equal(result.details.actions[1].action, "remove");
    assert.equal(result.details.actions[1].label, "wontfix");
  });
});
