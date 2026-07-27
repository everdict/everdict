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

// The pdf_read tool body. Runs as an ESM module, using built-in fetch + zlib (no dependencies — deliberately no PDF
// library, so it runs on any runtime / image, matching web_search). Best-effort text extraction: it inflates
// FlateDecode (or reads uncompressed) content streams and pulls the Tj / TJ string operators — good for text-based
// PDFs (standard fonts), NOT scanned/image-only PDFs or custom CID-font encodings. String.raw keeps the embedded
// escapes literal for the runtime; the body avoids backticks / `${}`.
const PDF_READ_CODE = String.raw`
import { readFileSync } from "node:fs";
import { inflateSync, inflateRawSync } from "node:zlib";
const emit = (content, isError) => process.stdout.write(JSON.stringify({ content: content, isError: !!isError }));
function decodePdfString(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (_m, e) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 255);
    const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
    return map[e] !== undefined ? map[e] : e;
  });
}
function extractOps(content) {
  const out = [];
  const re = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:\\.|[^\][])*\]\s*TJ/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const tok = m[0];
    if (tok.charAt(tok.length - 1) === "j") {
      out.push(decodePdfString(tok.slice(tok.indexOf("(") + 1, tok.lastIndexOf(")"))));
    } else {
      const arr = tok.slice(tok.indexOf("[") + 1, tok.lastIndexOf("]"));
      const sre = /\((?:\\.|[^\\()])*\)/g;
      let sm;
      const pieces = [];
      while ((sm = sre.exec(arr)) !== null) pieces.push(decodePdfString(sm[0].slice(1, -1)));
      out.push(pieces.join(""));
    }
  }
  return out.join(" ");
}
function extractPdfText(buf) {
  const s = buf.toString("latin1");
  const parts = [];
  let idx = 0;
  for (;;) {
    const st = s.indexOf("stream", idx);
    if (st < 0) break;
    if (st >= 3 && s.slice(st - 3, st) === "end") { idx = st + 6; continue; }
    const dictStart = s.lastIndexOf("<<", st);
    const dict = dictStart >= 0 ? s.slice(dictStart, st) : "";
    let ds = st + 6;
    if (s.charAt(ds) === "\r") ds++;
    if (s.charAt(ds) === "\n") ds++;
    const en = s.indexOf("endstream", ds);
    if (en < 0) break;
    idx = en + 9;
    const raw = buf.subarray(ds, en);
    let data = null;
    if (/FlateDecode/.test(dict)) {
      try { data = inflateSync(raw); } catch (e1) { try { data = inflateRawSync(raw); } catch (e2) { data = null; } }
    } else if (/\/Filter/.test(dict)) {
      data = null;
    } else {
      data = raw;
    }
    if (data) parts.push(extractOps(data.toString("latin1")));
  }
  return parts.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
await (async () => {
  let input = {};
  try { input = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch (e) { input = {}; }
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return emit("pdf_read: an http(s) 'url' is required.", true);
  const maxChars = Math.min(Math.max(parseInt(input.max_chars, 10) || 20000, 1000), 200000);
  let buf;
  try {
    const res = await fetch(url);
    if (!res.ok) return emit("pdf_read: could not fetch the PDF (HTTP " + res.status + ").", true);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) { return emit("pdf_read: fetch failed: " + (e && e.message ? e.message : String(e)), true); }
  const text = extractPdfText(buf);
  if (!text) return emit("pdf_read: no extractable text (the PDF may be scanned/image-only or use unsupported fonts).", false);
  emit(text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text, false);
})();
`.trim();

const PDF_READ: FirstPartyDefault = {
  requires: null,
  record: {
    id: "pdf-read",
    tenant: FIRST_PARTY_TENANT,
    version: "1.0.0",
    name: "pdf_read",
    description:
      "Fetch a PDF by URL and extract its text. Use to read a PDF referenced in the conversation (docs, papers, reports). Best-effort for text-based PDFs; scanned/image-only PDFs yield no text.",
    spec: {
      type: "code",
      language: "node",
      code: PDF_READ_CODE,
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The http(s) URL of the PDF to read." },
          max_chars: { type: "number", description: "Max characters to return (1000-200000, default 20000)." },
        },
        required: ["url"],
      },
      // Not marked read-only: it fetches an arbitrary caller-supplied URL, so each call passes the HITL gate (an SSRF
      // guardrail against prompt-injected fetches of internal addresses — unlike web_search, which hits a fixed host).
      isReadOnly: false,
      requiredSecrets: [], // no key — unconditional default (works on any runtime; zlib/fetch are built in)
      timeoutSec: 30,
    },
    visibility: "public",
    sharedWith: [],
    tags: ["pdf", "read", "built-in"],
    createdBy: "everdict",
    createdAt: "2026-07-27T00:00:00.000Z",
  },
};

// The scorecard-fix-PR skill body (SKILL.md-style instructions the agent loads on demand via use_skill). A SKILL —
// not code: it orchestrates tools the agent already has (scorecard reads + the GitHub App tools), so the procedure
// and its guardrails ARE the capability. Escaped backticks keep the markdown code spans literal inside the template.
const SCORECARD_FIX_PR_INSTRUCTIONS = `
# Scorecard root-cause fix PR

Turn a failing scorecard into a reviewable code fix: establish WHAT failed from the eval evidence, WHERE in the
harness's source repository it goes wrong, then open a GitHub pull request whose body carries the full experiment
context — a reviewer must be able to judge the fix without re-running anything.

## 1. Collect the evidence
- Load the scorecard: \`get_scorecard\` (and \`get_scorecard_analysis\` when available). If the member did not name
  one, find it with \`list_scorecards\` and confirm which they mean.
- Identify the failing cases: verdicts, per-case scores, and every judge's score rationale (\`judge:<id>\` entries).
- For the most informative failing cases (start with 3-5): \`get_run\` + \`get_run_logs\` — extract the concrete
  failure signature (assertion text, stack trace, error line, wrong output vs the expected value).
- Group cases by symptom: a shared signature usually means one root cause. Note counts (N of M cases).

## 2. Locate the code under test
- Find the source repository for the harness under evaluation: check \`list_ci_links\` (repo ↔ harness links) first,
  then \`list_github_app_repos\` + the harness spec (\`get_harness_instance\` — image/command names hint at the repo).
  If it stays ambiguous, ask the member — never guess a repository for a write.
- Follow the failure signatures into the source: \`get_github_file\` on each implicated file (and its tests), walking
  imports as needed, until you can name the file, the line, and the mechanism.

## 3. Diagnose at code level
- State the root cause in the form: case X fails because <file:line> does <wrong thing> when <condition>.
- Every claim must be backed by evidence you actually collected (a log line, a trace event, a judge rationale) tied
  to code you actually read. If you cannot connect the failure to code, do NOT force a PR — file the findings as an
  issue instead (\`create_github_issue\`) and say what is missing.
- Distinguish target-code bugs from eval-setup problems (a wrong dataset expectation, judge misconfiguration, a
  flaky environment). If the eval setup is at fault, report that and stop — never "fix" the target repository to
  satisfy a broken expectation.

## 4. Open the fix PR
- Keep the change minimal and targeted; prepare the FULL new content of every changed file (update the adjacent
  test when the repo has one).
- Load \`references/pr-body.md\` (via \`read_skill_file\`) — it carries the MANDATORY PR-body structure (the
  experiment context a reviewer needs) — then call \`open_github_pr\` with:
  - branch: \`everdict/scorecard-<scorecard-id>\` — near-idempotent: re-running updates the same branch/PR.
  - title: an imperative one-line summary of the fix.
  - changes: the full new file contents.
  - body: composed per \`references/pr-body.md\`.
- Summarize the intended diff to the member before the call — the PR write is approved inline (HITL).

## Constraints
- Never include secrets, API keys, or raw full logs in the PR body — quote only the minimal excerpts.
- One PR per scorecard; never target the default branch directly.
`.trim();

// The mandatory PR-body structure — a supporting file (loaded via read_skill_file only when the agent reaches the
// PR step), keeping the skill body itself lean.
const SCORECARD_FIX_PR_BODY_TEMPLATE = `
# Fix-PR body structure (mandatory)

The PR body must let a reviewer judge the fix without re-running anything. Structure it as:

- **What failed** — scorecard <id> (<harness>@<version> × <dataset>@<version>): N of M cases failed, with the
  scorecard link.
- **Failing cases** — per case: case id, verdict, judge scores with a one-line rationale each.
- **Root cause** — the code-level mechanism, quoting the minimal evidence excerpts (log/trace lines) that prove it.
- **The fix** — what changed and why it resolves each failing case.
- **Verification** — how to confirm (re-run the scorecard / the failing cases after merge).

Never include secrets, API keys, or raw full logs — quote only the minimal excerpts that prove the diagnosis.
`.trim();

const SCORECARD_FIX_PR: FirstPartyDefault = {
  requires: "github", // needs the workspace GitHub App (read the repo + open the PR) — off until it is installed
  record: {
    id: "scorecard-fix-pr",
    tenant: FIRST_PARTY_TENANT,
    version: "1.0.0",
    name: "scorecard_fix_pr",
    description:
      "Diagnose a scorecard's failing cases down to the harness's source code and open a GitHub pull request with " +
      "the fix, carrying the experiment context (failing cases, judge verdicts, evidence) in the PR body. Use when " +
      "a member asks why an eval failed and wants a fix proposed on the repository.",
    spec: {
      type: "skill",
      instructions: SCORECARD_FIX_PR_INSTRUCTIONS,
      files: [{ path: "references/pr-body.md", content: SCORECARD_FIX_PR_BODY_TEMPLATE }],
    },
    visibility: "public",
    sharedWith: [],
    tags: ["scorecard", "github", "analysis", "built-in"],
    createdBy: "everdict",
    createdAt: "2026-07-27T00:00:00.000Z",
  },
};

// The first-party default toolset, in the order they are offered: web search (unconditional, key-gated) + PDF read
// (unconditional, no key, HITL-gated) + the scorecard-fix-PR skill (github-gated — the first skill-kind default).
// Rich integration adapters (Mattermost / GitHub / image-registry) are shipped as control-plane MCP tools, not
// first-party capabilities (their credentials live server-side); a SKILL default orchestrates those tools instead.
export function firstPartyDefaults(): FirstPartyDefault[] {
  return [WEB_SEARCH, PDF_READ, SCORECARD_FIX_PR];
}
