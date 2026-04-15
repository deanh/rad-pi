import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type ToolRegistry,
  type ToolLevel,
  hasTool,
  requireTools,
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
    const notifications: Array<{ msg: string; level: string }> = [];
    const ctx = { ui: { notify: (msg: string, level: string) => { notifications.push({ msg, level }); } } };

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
      tools: new Map([["rad-plan", "read"]]),
    };
    const notifications: Array<{ msg: string; level: string }> = [];
    const ctx = { ui: { notify: (msg: string, level: string) => { notifications.push({ msg, level }); } } };

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
    const notifications: Array<{ msg: string; level: string }> = [];
    const ctx = { ui: { notify: (msg: string, level: string) => { notifications.push({ msg, level }); } } };

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
    const notifications: Array<{ msg: string; level: string }> = [];
    const ctx = { ui: { notify: (msg: string, level: string) => { notifications.push({ msg, level }); } } };

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
    const notifications: Array<{ msg: string; level: string }> = [];
    const ctx = { ui: { notify: (msg: string, level: string) => { notifications.push({ msg, level }); } } };

    const result = requireTools(reg, ctx, ["rad-plan", "rad-context"]);
    assert.equal(result, false);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].msg, /rad-plan not installed/);
  });
});
