import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripMarkdownFences,
  parseExtractionResponse,
  mergeFilesTouched,
  extractContextId,
  parseCommitShas,
} from "../lib/rad-context-utils.ts";

describe("stripMarkdownFences", () => {
  it("returns plain JSON unchanged", () => {
    const input = '{"title": "test"}';
    assert.equal(stripMarkdownFences(input), '{"title": "test"}');
  });

  it("strips ```json fences", () => {
    const input = '```json\n{"title": "test"}\n```';
    assert.equal(stripMarkdownFences(input), '{"title": "test"}');
  });

  it("strips bare ``` fences", () => {
    const input = '```\n{"title": "test"}\n```';
    assert.equal(stripMarkdownFences(input), '{"title": "test"}');
  });

  it("strips fences with extra whitespace", () => {
    const input = '```json  \n  {"title": "test"}  \n  ```';
    assert.equal(stripMarkdownFences(input), '{"title": "test"}');
  });

  it("handles multiline JSON inside fences", () => {
    const input = '```json\n{\n  "title": "test",\n  "approach": "foo"\n}\n```';
    const result = stripMarkdownFences(input);
    assert.deepEqual(JSON.parse(result), { title: "test", approach: "foo" });
  });

  it("trims surrounding whitespace", () => {
    const input = '  \n  {"title": "test"}  \n  ';
    assert.equal(stripMarkdownFences(input), '{"title": "test"}');
  });

  it("handles fences with leading text (takes first fenced block)", () => {
    const input = 'Here is the JSON:\n```json\n{"title": "test"}\n```';
    assert.equal(stripMarkdownFences(input), '{"title": "test"}');
  });
});

describe("parseExtractionResponse", () => {
  it("parses plain JSON", () => {
    const result = parseExtractionResponse('{"title": "test", "description": "d", "approach": "a"}');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.title, "test");
  });

  it("parses JSON wrapped in markdown fences", () => {
    const result = parseExtractionResponse('```json\n{"title": "test"}\n```');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.title, "test");
  });

  it("returns error for empty response", () => {
    const result = parseExtractionResponse("");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /empty/);
  });

  it("returns error for whitespace-only response", () => {
    const result = parseExtractionResponse("   \n  ");
    assert.equal(result.ok, false);
  });

  it("returns error for invalid JSON", () => {
    const result = parseExtractionResponse("{broken json}");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /invalid JSON/);
  });

  it("returns error for JSON array (not object)", () => {
    const result = parseExtractionResponse('[1, 2, 3]');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /expected a JSON object/);
  });

  it("returns error for JSON primitive", () => {
    const result = parseExtractionResponse('"just a string"');
    assert.equal(result.ok, false);
  });

  it("includes truncated content in error for invalid JSON", () => {
    const longGarbage = "x".repeat(300);
    const result = parseExtractionResponse(longGarbage);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid JSON/);
      // Should be truncated to 200 chars
      assert.ok(result.error.length < 300);
    }
  });

  it("handles JSON with fences and commentary before", () => {
    const input = 'Here is the extracted context:\n\n```json\n{"title": "auth flow"}\n```\n\nLet me know if you need changes.';
    const result = parseExtractionResponse(input);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.title, "auth flow");
  });
});

describe("mergeFilesTouched", () => {
  it("adds files when filesTouched is absent", () => {
    const result = mergeFilesTouched({ title: "test" }, ["src/a.ts"]);
    assert.deepEqual(result.filesTouched, ["src/a.ts"]);
  });

  it("merges with existing filesTouched", () => {
    const result = mergeFilesTouched(
      { title: "test", filesTouched: ["src/a.ts", "src/b.ts"] },
      ["src/b.ts", "src/c.ts"],
    );
    assert.deepEqual(result.filesTouched, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("deduplicates files", () => {
    const result = mergeFilesTouched(
      { title: "test", filesTouched: ["src/a.ts"] },
      ["src/a.ts"],
    );
    assert.deepEqual(result.filesTouched, ["src/a.ts"]);
  });

  it("returns unchanged object when modifiedFiles is empty", () => {
    const input = { title: "test", filesTouched: ["src/a.ts"] };
    const result = mergeFilesTouched(input, []);
    assert.equal(result, input); // same reference
  });

  it("does not mutate the original object", () => {
    const input = { title: "test", filesTouched: ["src/a.ts"] };
    const result = mergeFilesTouched(input, ["src/b.ts"]);
    assert.deepEqual(input.filesTouched, ["src/a.ts"]); // unchanged
    assert.notEqual(result, input);
  });
});

describe("extractContextId", () => {
  it("extracts 40-char hex ID from output", () => {
    const output = "Created context a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n";
    assert.equal(extractContextId(output), "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
  });

  it("returns null when no ID found", () => {
    assert.equal(extractContextId("some error output"), null);
    assert.equal(extractContextId(""), null);
  });

  it("extracts first ID if multiple present", () => {
    const output = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    // Both are 40 chars; should return the first
    assert.equal(extractContextId(output), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("parseCommitShas", () => {
  it("parses one SHA per line", () => {
    const input = "abc123\ndef456\n";
    assert.deepEqual(parseCommitShas(input), ["abc123", "def456"]);
  });

  it("filters empty lines", () => {
    const input = "abc123\n\ndef456\n\n";
    assert.deepEqual(parseCommitShas(input), ["abc123", "def456"]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseCommitShas(""), []);
  });
});
