/**
 * Pure utility functions for rad-context extraction.
 * Extracted for testability — no side effects, no dependencies on pi or git.
 */

/**
 * Extract JSON text from an LLM response that may be wrapped in markdown fences.
 * Returns the cleaned text ready for JSON.parse().
 */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Parse an LLM response as JSON, stripping markdown fences if present.
 * Returns the parsed object or an error message.
 */
export function parseExtractionResponse(responseText: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const jsonText = stripMarkdownFences(responseText);

  if (!jsonText) {
    return { ok: false, error: "empty response" };
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "expected a JSON object" };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: `invalid JSON: ${jsonText.slice(0, 200)}` };
  }
}

/**
 * Merge mechanically-detected modified files into the filesTouched field
 * of extracted context JSON. Deduplicates.
 */
export function mergeFilesTouched(
  contextJson: Record<string, unknown>,
  modifiedFiles: string[],
): Record<string, unknown> {
  if (modifiedFiles.length === 0) return contextJson;

  const existing = Array.isArray(contextJson.filesTouched) ? contextJson.filesTouched as string[] : [];
  const merged = [...new Set([...existing, ...modifiedFiles])];
  return { ...contextJson, filesTouched: merged };
}

/**
 * Extract a 40-character hex context ID from rad-context create output.
 */
export function extractContextId(stdout: string): string | null {
  const match = stdout.trim().match(/([0-9a-f]{40})/);
  return match ? match[1] : null;
}

/**
 * Parse commit SHAs from git log output (one per line).
 */
export function parseCommitShas(gitLogOutput: string): string[] {
  return gitLogOutput.trim().split("\n").filter(l => l.length > 0);
}
