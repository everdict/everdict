import { z } from "zod";
import { TOOL_SEARCH_TOOL_NAME, isDeferredTool } from "./deferred.js";
import type { ToolDefinition } from "./definition.js";
import type { ToolRegistry } from "./registry.js";

// ToolSearch — progressive disclosure for deferred tools (Claude Code parity). The model queries this to load
// the full JSON schema of tools held back from the initial tools[]. The match names are emitted in the tool
// result; the next turn's extractDiscoveredToolNames() lifts them and rebuilds tools[] with their schemas.
//
// Query forms (case-insensitive): "select:foo,bar" (direct), "keyword another" (fuzzy), "+slack send"
// (require "slack", rank by "send"). Scoring: exact name part +10/+12(mcp), prefix +5/+6, searchHint +4, desc +2.

const inputSchema = z
  .object({
    query: z.string().min(1).max(2_000),
    max_results: z.number().int().min(1).max(20).optional(),
  })
  .passthrough();

const DEFAULT_MAX_RESULTS = 5;

function parseToolName(name: string): { parts: string[]; full: string; isMcp: boolean } {
  if (name.startsWith("mcp__")) {
    const noPrefix = name.replace(/^mcp__/, "").toLowerCase();
    const parts = noPrefix.split("__").flatMap((p) => p.split("_"));
    return {
      parts: parts.filter(Boolean),
      full: noPrefix.replace(/__/g, " ").replace(/_/g, " "),
      isMcp: true,
    };
  }
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return { parts, full: parts.join(" "), isMcp: false };
}

function describeForScoring(t: ToolDefinition): string {
  return [t.description, t.searchHint ?? ""].join(" ").toLowerCase();
}

function scoreCandidate(t: ToolDefinition, terms: string[]): number {
  const parsed = parseToolName(t.name);
  const descNorm = describeForScoring(t);
  const hintNorm = (t.searchHint ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (parsed.parts.includes(term)) {
      score += parsed.isMcp ? 12 : 10;
    } else if (parsed.parts.some((p) => p.includes(term))) {
      score += parsed.isMcp ? 6 : 5;
    } else if (parsed.full.includes(term) && score === 0) {
      score += 3;
    }
    if (hintNorm.length > 0 && hintNorm.includes(term)) score += 4;
    if (descNorm.includes(term)) score += 2;
  }
  return score;
}

function searchDeferred(
  query: string,
  registry: ToolRegistry,
  maxResults: number,
): { matches: string[]; totalDeferred: number } {
  const deferred = registry.list().filter(isDeferredTool);
  const totalDeferred = deferred.length;
  const q = query.trim().toLowerCase();

  if (q.startsWith("select:")) {
    const requested = q
      .slice("select:".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const want = new Set(requested);
    const matches = deferred.filter((t) => want.has(t.name.toLowerCase())).map((t) => t.name);
    const matched = new Set(matches.map((m) => m.toLowerCase()));
    for (const r of requested) {
      if (matched.has(r)) continue;
      const all = registry.list().find((t) => t.name.toLowerCase() === r);
      if (all) matches.push(all.name);
    }
    return { matches: matches.slice(0, maxResults), totalDeferred };
  }

  const exact =
    deferred.find((t) => t.name.toLowerCase() === q) ?? registry.list().find((t) => t.name.toLowerCase() === q);
  if (exact) return { matches: [exact.name], totalDeferred };

  const terms = q.split(/\s+/).filter(Boolean);
  const required: string[] = [];
  const optional: string[] = [];
  for (const t of terms) {
    if (t.startsWith("+") && t.length > 1) required.push(t.slice(1));
    else optional.push(t);
  }
  const allTerms = [...required, ...optional];
  if (allTerms.length === 0) return { matches: [], totalDeferred };

  const candidates =
    required.length === 0
      ? deferred
      : deferred.filter((t) => {
          const parsed = parseToolName(t.name);
          const descNorm = describeForScoring(t);
          return required.every(
            (r) => parsed.parts.includes(r) || parsed.parts.some((p) => p.includes(r)) || descNorm.includes(r),
          );
        });

  const scored = candidates
    .map((t) => ({ name: t.name, score: scoreCandidate(t, allTerms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((x) => x.name);
  return { matches: scored, totalDeferred };
}

export function buildToolSearchTool(registry: ToolRegistry): ToolDefinition {
  const description = [
    "Fetches full schema definitions for deferred tools so they can be called.",
    "",
    "Deferred tools appear by name in the <available-deferred-tools> section of the system prompt. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked.",
    "",
    "This tool takes a query, matches it against the deferred tool list, and lists the matched names. Their full JSON schemas become available in tools[] on the NEXT turn — invoke them directly by name then.",
    "",
    "Query forms:",
    "- 'select:foo,bar'   — fetch these exact tool names",
    "- 'notebook jupyter' — keyword search, up to max_results matches",
    "- '+slack send'      — require 'slack' in the candidate, rank by 'send'",
  ].join("\n");

  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description,
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Query to find deferred tools. Use 'select:<name>[,<name>...]' for direct selection, or keywords for fuzzy search.",
        },
        max_results: {
          type: "number",
          default: DEFAULT_MAX_RESULTS,
          description: "Maximum number of results to return (1..20).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    inputSchema,
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const parsed = inputSchema.parse(input);
      const max = parsed.max_results ?? DEFAULT_MAX_RESULTS;
      const { matches, totalDeferred } = searchDeferred(parsed.query, registry, max);
      const output = {
        matches,
        query: parsed.query,
        total_deferred_tools: totalDeferred,
        note:
          matches.length === 0
            ? `No deferred tools matched. Currently deferred: ${totalDeferred}. Try a broader query.`
            : `Loaded ${matches.length} deferred tool(s) of ${totalDeferred}. Their full JSON schemas appear in tools[] from the next turn — invoke them directly by name.`,
      };
      return {
        content: JSON.stringify({ tool_name: TOOL_SEARCH_TOOL_NAME, output }),
        isError: false,
      };
    },
  };
}
