import { type CapabilityRecord, type CapabilityRequirement, FIRST_PARTY_TENANT } from "@everdict/contracts";

// The FIRST-PARTY default toolset — Everdict-authored capabilities every workspace's agent gets WITHOUT adoption
// (subject to the integration gate in @everdict/domain + the workspace's opt-outs). Each is a normal versioned
// `CapabilityRecord` owned by FIRST_PARTY_TENANT and published `public`, so it is ALSO browsable/adoptable in the store
// (the "same tool, two channels: default + marketplace" model). Authored by Everdict → trusted, so the runtime runs it
// on any driver (the resolver sets sandbox:false). Source lives in the repo (git-versioned, CI-linted, auditable) —
// not a DB row. See docs/architecture/capability-store.md ("First-party default toolset").

// The secret name the web-search default declares AND the operator/workspace key that satisfies it. Web search uses
// Tavily — a portable, LLM-oriented search API (provider-agnostic w.r.t. the agent's own LLM; works for Anthropic and
// OpenAI harnesses alike). Resolved from the operator-global value first, else a workspace secret of the same name;
// unresolved → the tool is simply absent (a first-party default is never offered broken).
export const WEBSEARCH_SECRET_NAME = "TAVILY_API_KEY";

// A first-party default: the versioned capability + the integration it depends on (null = unconditional).
export interface FirstPartyDefault {
  record: CapabilityRecord;
  requires: CapabilityRequirement | null;
}

// The web-search tool body. Runs as an ESM module (the runtime writes Node tools to a `.mjs` file — `require` is NOT
// available, so use `import` + top-level await), using the built-in `fetch` (no dependencies). Script-grader contract:
// the input JSON path is argv[2] (node <script> <input>), and the result is the last JSON on stdout ({content,
// isError?}). String.raw keeps the embedded `\n` escapes literal for the runtime; the body avoids backticks / `${}`.
const WEBSEARCH_CODE = String.raw`
import { readFileSync } from "node:fs";
const emit = (content, isError) => process.stdout.write(JSON.stringify({ content, isError: !!isError }));
await (async () => {
  let input = {};
  try { input = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch { input = {}; }
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return emit("web_search: 'query' is required.", true);
  const maxResults = Math.min(Math.max(parseInt(input.max_results, 10) || 5, 1), 10);
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return emit("web_search is not configured: no search API key is set for this workspace.", true);
  let res;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "basic", include_answer: true })
    });
  } catch (e) { return emit("web_search request failed: " + (e && e.message ? e.message : String(e)), true); }
  if (!res.ok) return emit("web_search upstream error " + res.status + ".", true);
  let data;
  try { data = await res.json(); } catch { return emit("web_search: could not parse upstream response.", true); }
  const results = Array.isArray(data.results) ? data.results : [];
  const parts = [];
  if (typeof data.answer === "string" && data.answer) parts.push("Answer: " + data.answer);
  for (let i = 0; i < results.length; i++) {
    const r = results[i] || {};
    parts.push((i + 1) + ". " + (r.title || "(untitled)") + "\n   " + (r.url || "") + "\n   " + (r.content || "").toString().slice(0, 300));
  }
  emit(parts.length ? parts.join("\n\n") : "No results found for: " + query, false);
})();
`.trim();

const WEB_SEARCH: FirstPartyDefault = {
  requires: null,
  record: {
    id: "web-search",
    tenant: FIRST_PARTY_TENANT,
    version: "1.0.0",
    name: "web_search",
    description:
      "Search the web and return ranked results (title, URL, snippet) plus a short answer. Use for current events, external docs, or facts not in the conversation.",
    spec: {
      type: "code",
      language: "node",
      code: WEBSEARCH_CODE,
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          max_results: { type: "number", description: "Maximum number of results (1-10, default 5)." },
        },
        required: ["query"],
      },
      isReadOnly: true,
      requiredSecrets: [
        {
          name: WEBSEARCH_SECRET_NAME,
          description:
            "Tavily API key (https://tavily.com). Set operator-wide (AGENT_WEBSEARCH_API_KEY) or as a workspace secret of this name.",
        },
      ],
      timeoutSec: 30,
    },
    visibility: "public",
    sharedWith: [],
    tags: ["search", "web", "built-in"],
    createdBy: "everdict",
    createdAt: "2026-07-27T00:00:00.000Z",
  },
};

// The first-party default toolset, in the order they are offered. Currently: web search (unconditional, key-gated).
// PDF reading + rich integration adapters (Mattermost / GitHub / image-registry) land as further entries here.
export function firstPartyDefaults(): FirstPartyDefault[] {
  return [WEB_SEARCH];
}
