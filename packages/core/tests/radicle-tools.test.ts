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
      "rad patch review abc123 --accept --message looks good": { code: 0, stdout: "accepted\n" },
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
      "rad clone rad:zabc --path ./repo": { code: 0, stdout: "cloned\n" },
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
      "rad patch assign --add did:key:zabc abc123": { code: 0, stdout: "assigned\n" },
    });
    const result = await s.tool("rad_patch_assign").execute("1", { patchId: "abc123", did: "did:key:zabc" });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.patchId, "abc123");
    assert.equal(result.details.did, "did:key:zabc");
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
      "rad patch list --state open": { code: 0, stdout: "" },
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
      "rad patch list --state open": { code: 0, stdout: "abc123 some patch\n" },
      "git push --force": { code: 0, stdout: "updated\n" },
    });
    const result = await s.tool("rad_patch_update_revision").execute("1", {});
    assert.equal(result.details.ok, true);
    assert.equal(result.details.branch, "feature/test");
  });
});
