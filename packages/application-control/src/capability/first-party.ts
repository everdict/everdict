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
      examples: [
        {
          name: "basic search",
          input: { query: "MLflow 3 trace API changes", max_results: 3 },
          note: "Top-3 ranked results (title, URL, snippet) plus a short synthesized answer.",
        },
      ],
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
      examples: [
        {
          name: "read a paper",
          input: { url: "https://arxiv.org/pdf/2210.03629", max_chars: 8000 },
          note: "Extracts the text of a text-based PDF (scanned/image-only PDFs yield no text).",
        },
      ],
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

// The fetch_url tool body. Runs as an ESM module, using ONLY the built-in fetch (no dependencies — no HTML parser),
// so it runs on any runtime / image (same portability contract as web_search / pdf_read). Best-effort readability:
// it strips <script>/<style>/comments, turns block-close/<br>/<li> into line breaks, removes remaining tags, and
// decodes common HTML entities — good enough to read an article/doc page as plain text. String.raw keeps the embedded
// escapes literal for the runtime; the body avoids backticks / `${}`.
const FETCH_URL_CODE = String.raw`
import { readFileSync } from "node:fs";
const emit = (content, isError) => process.stdout.write(JSON.stringify({ content: content, isError: !!isError }));
function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e.charAt(0) === "#") {
      const code = (e.charAt(1) === "x" || e.charAt(1) === "X") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : m;
    }
    const key = e.toLowerCase();
    return named[key] !== undefined ? named[key] : m;
  });
}
function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|section|article|header|footer|h[1-6]|tr|ul|ol|table|blockquote|pre)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
await (async () => {
  let input = {};
  try { input = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch (e) { input = {}; }
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return emit("fetch_url: an http(s) 'url' is required.", true);
  const maxChars = Math.min(Math.max(parseInt(input.max_chars, 10) || 20000, 1000), 200000);
  let res;
  try {
    res = await fetch(url, { headers: { "user-agent": "everdict-agent/1.0 (+fetch_url)", accept: "text/html,text/plain,*/*" } });
  } catch (e) { return emit("fetch_url: fetch failed: " + (e && e.message ? e.message : String(e)), true); }
  if (!res.ok) return emit("fetch_url: could not fetch the URL (HTTP " + res.status + ").", true);
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  let body;
  try { body = await res.text(); } catch (e) { return emit("fetch_url: could not read the response body.", true); }
  const looksHtml = ctype.indexOf("html") >= 0 || /^\s*<(!doctype|html)/i.test(body);
  const out = looksHtml ? htmlToText(body) : body.trim();
  if (!out) return emit("fetch_url: the page had no extractable text.", false);
  emit(out.length > maxChars ? out.slice(0, maxChars) + "\n...[truncated]" : out, false);
})();
`.trim();

const FETCH_URL: FirstPartyDefault = {
  requires: null,
  record: {
    id: "fetch-url",
    tenant: FIRST_PARTY_TENANT,
    version: "1.0.0",
    name: "fetch_url",
    description:
      "Fetch a web page by URL and return its readable text (HTML stripped to plain text). Use to READ a specific page " +
      "the conversation references — the reading companion to web_search (which FINDS pages) and pdf_read (which reads PDFs).",
    spec: {
      type: "code",
      language: "node",
      code: FETCH_URL_CODE,
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The http(s) URL of the page to read." },
          max_chars: { type: "number", description: "Max characters to return (1000-200000, default 20000)." },
        },
        required: ["url"],
      },
      examples: [
        {
          name: "read a page",
          input: { url: "https://mlflow.org/releases", max_chars: 6000 },
          note: "Plain-text extraction of the page body (HTML stripped).",
        },
      ],
      // Not read-only: it fetches an arbitrary caller-supplied URL, so each call passes the HITL gate (an SSRF
      // guardrail against prompt-injected fetches of internal addresses — same discipline as pdf_read).
      isReadOnly: false,
      requiredSecrets: [], // no key — unconditional default (works on any runtime; fetch is built in)
      timeoutSec: 30,
    },
    visibility: "public",
    sharedWith: [],
    tags: ["fetch", "web", "read", "built-in"],
    createdBy: "everdict",
    createdAt: "2026-07-28T00:00:00.000Z",
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
- Follow the failure signatures into the source: \`list_github_repo_files\` to find the paths (narrow with \`prefix\`;
  a \`truncated\` listing is NOT the whole repository), then \`get_github_file\` on each implicated file (and its
  tests), walking imports as needed, until you can name the file, the line, and the mechanism.

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
- Re-running against the same scorecard? Read what the existing PR already proposes first
  (\`get_github_pull_request_changes\`) so the second pass extends the fix instead of reverting it.

## Constraints
- Never include secrets, API keys, or raw full logs in the PR body — quote only the minimal excerpts.
- One PR per scorecard; never target the default branch directly. This skill PROPOSES — use \`open_github_pr\`,
  never \`commit_github_files\`, however small the fix looks: a fix derived from failing evidence is exactly the
  kind of change a human should read before it lands.
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

// An Everdict-authored EXAMPLE skill. It is a store entry, not a tier of the product: a workspace takes a copy into
// its own library and owns it from then on (edit it, stamp versions on it). Nothing here is auto-attached to anyone's
// agent — see firstPartySkillExamples() below for why.
const SCORECARD_FIX_PR: CapabilityRecord = {
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
  tags: ["scorecard", "github", "analysis", "example"],
  createdBy: "everdict",
  createdAt: "2026-07-27T00:00:00.000Z",
};

// The trace-analysis skill body (SKILL.md-style instructions the agent loads on demand via use_skill). A SKILL — not
// code: it orchestrates the trace-source reads the agent already has (inspect_trace / list_trace_source_traces) plus,
// for Everdict-produced traces, the run/scorecard reads. The procedure + its grounding discipline ARE the capability.
// This is the skill the "analyze in chat" button (Settings › Observability) hands a trace to. Escaped backticks keep
// the markdown code spans literal inside the template.
const TRACE_ANALYSIS_INSTRUCTIONS = `
# Trace analysis

Analyze one observability trace — a single agent run captured on a workspace trace platform (MLflow / Langfuse /
LangSmith / Phoenix / OTel) — and give the member a grounded read: what the agent did, where it failed, what it cost,
and what to do next. Every claim MUST be backed by something in the trace; never infer beyond the evidence.

## 1. Get the trace
- If the member attached a trace ("analyze in chat"), its normalized events are ALREADY in your context — start there.
- Otherwise locate it with \`list_trace_source_traces\` (a registered source; optional scope + time window), then pull
  the full detail with \`inspect_trace\` (source name + trace id): the normalized events, the span waterfall
  (\`detail.spans\` — offsets/durations/tokens/cost), and \`provenance\` when the trace is Everdict-produced.

## 2. Reconstruct what happened
- The goal: the first user message (or the run's input).
- The path: the ordered tool_call → tool_result pairs and llm_call events — what the agent tried, in order.
- The outcome: the final assistant message / final answer, and the trace status (ok / error).

## 3. Surface failures
- Errors: \`error\` events, tool_results with ok=false, and any error status on a span.
- The failure signature: the concrete assertion / stack / error text — the thing any fix must address.
- Attribute it: an agent mistake (wrong tool, wrong argument, gave up early) vs an environment/tool fault (a 5xx, a timeout).

## 4. Cost & latency hotspots
- From the waterfall + llm_call events: the longest-running spans and the most expensive llm_calls (tokens / cost).
- Report the trace totals (duration, tokens in→out, cost) and the top 2-3 contributors — that is where tuning pays off.

## 5. Connect to the eval (when Everdict-produced)
- If the trace carries \`provenance\` {runId, scorecardId, dataset, harness, caseId}, pull that context with
  \`get_run\` / \`get_scorecard\` so the analysis ties the trace to its case verdict + judge rationale, not just raw
  spans. For a FAILING eval case whose harness has a source repo, hand off to the \`scorecard_fix_pr\` skill to propose
  a code fix — do not duplicate that procedure here.

## 6. Report
- Load \`references/report.md\` (via \`read_skill_file\`) for the structure, then give a concise, evidence-grounded
  analysis: lead with the verdict (what happened + why), then the supporting detail.

## Constraints
- Ground every claim in a trace event/span you actually read; if the trace is thin, say what is MISSING rather than guessing.
- Quote only minimal excerpts — never dump the whole trace back.
`.trim();

// The trace-analysis report structure — a supporting file (loaded via read_skill_file only when the agent reaches the
// report step), keeping the skill body itself lean (progressive disclosure).
const TRACE_ANALYSIS_REPORT = `
# Trace analysis report structure

Give the member a scannable read, verdict first:

- **Verdict** — one or two lines: what the run did, whether it succeeded, and the single most important finding.
- **What happened** — the goal, then the ordered path (tool / LLM steps) to the outcome.
- **Failures** — each failure with its concrete signature (error text / failed tool result) and whether it is an
  agent mistake or an environment/tool fault.
- **Cost & latency** — trace totals (duration, tokens, cost) + the top 2-3 hotspots (longest spans / priciest calls).
- **Origin** — when Everdict-produced: the run / scorecard / dataset / harness / case the trace came from (with links),
  and the case verdict + judge rationale.
- **Next steps** — concrete, evidence-backed recommendations (a config change, a fix, or a scorecard_fix_pr handoff).

Quote only minimal excerpts that prove each point — never paste the whole trace.
`.trim();

// The second Everdict-authored example skill — the "analyze in chat" companion to Settings › Observability. Same deal:
// a store example a workspace copies and then owns.
const TRACE_ANALYSIS: CapabilityRecord = {
  id: "trace-analysis",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "analyze_trace",
  description:
    "Analyze one observability trace pulled from a workspace trace source — summarize what the agent did, surface " +
    "failures, flag cost/latency hotspots, and (for Everdict-produced traces) tie it back to the run/scorecard it " +
    'came from. Use when a member attaches a trace ("analyze in chat") or asks about a trace in Settings › Observability.',
  spec: {
    type: "skill",
    instructions: TRACE_ANALYSIS_INSTRUCTIONS,
    files: [{ path: "references/report.md", content: TRACE_ANALYSIS_REPORT }],
  },
  visibility: "public",
  sharedWith: [],
  tags: ["trace", "observability", "analysis", "example"],
  createdBy: "everdict",
  createdAt: "2026-07-28T00:00:00.000Z",
};

// The memory-consolidation skill body — the "dream" pass over the workspace's agent memory (memory/ on the
// workspace filesystem), reinterpreting Claude Code's nightly consolidation as a SKILL a workspace imports and
// schedules (a crafted agent triggered on schedule.fired). A procedure, not code: it orchestrates the fs tools the
// agent already has (get_file / search_files / write_file / delete_file) plus the knowledge tools for facts that
// belong there instead. Consolidation reorganizes what is WRITTEN — it never invents.
const MEMORY_CONSOLIDATION_INSTRUCTIONS = `
# Memory consolidation

Consolidate the workspace's agent memory — \`memory/\` on the workspace filesystem — so it stays small, current, and
trustworthy. You are editing the SHARED memory whose index every agent in this workspace reads at every turn: each
line you keep costs every future conversation context, and each stale claim misleads one. Run this periodically (a
scheduled agent) or when the index has grown noisy.

## 1. Orient
- \`get_file\` \`memory/MEMORY.md\` (the index) and \`list_files\` \`memory\`. No memory yet → report "nothing to
  consolidate" and stop.
- Files missing from the index, and index lines whose file is gone, are both defects — fix them in step 4.
- Memory has TWO scopes and each has its own index. \`memory/\` is the workspace's. \`memory/members/<them>/\` is one
  member's own — \`list_files\` \`memory/members\` shows you exactly the areas you are allowed to see (another
  member's simply is not there), and each has its own \`MEMORY.md\`. Consolidate each scope AGAINST ITSELF: never
  merge a personal memory into the shared index, because that publishes one person's habits to the whole
  workspace. A shared memory that is really about one person moves the other way — into their area, if you can
  see it — and is otherwise reported, not moved.

## 2. Gather
- Read every memory body (\`get_file\`); for a large set, \`search_files\` (path: memory) to group by topic first.
- Look for: OVERLAPS (two files carrying one fact), CONTRADICTIONS (a newer fact an older file denies), relative
  dates gone stale ("last week"), transient task state that never belonged, facts the workspace already records
  elsewhere (a knowledge entry, a skill, a spec — memory only holds what is NOT derivable from workspace state),
  and credential-shaped strings (the write path refuses them today; one that slipped through an old write must be
  REMOVED and called out in your report).

## 3. Consolidate — update, don't duplicate
- Merge overlapping files into the strongest one (update its body, then \`delete_file\` the other), keeping the
  frontmatter honest (name/description/type) and the Why:/How to apply: lines intact for feedback/project types.
- Convert relative dates to absolute. Delete a wrong fact at the SOURCE file, not just its index line.
- A durable fact ABOUT a workspace entity belongs in the knowledge layer: record it there
  (\`create_knowledge_entry\`, refs pinned at the observed version) and remove it from memory.
- Unsure about a memory? It stays as-is — consolidation is reorganization, never invention.

## 4. Prune the index
- Rewrite EACH scope's index to exactly that scope's surviving files — one line each (\`- [Title](file.md) —
  one-line hook\`), most load-bearing first, well under ~200 lines and ~12,000 characters (both caps are enforced
  at recall time: past either, entries stop being visible at all).
- Pass \`base_revision\` on every write: members and other agents edit these files too, and a lost race must
  surface as a merge, not an overwrite.

## 5. Report
- End with: files merged / deleted / kept, index lines before → after, and everything you removed as wrong or
  misplaced — every change is an attributed revision, so a member can restore anything you misjudged.
`.trim();

const MEMORY_CONSOLIDATION: CapabilityRecord = {
  id: "memory-consolidation",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "memory_consolidation",
  description:
    "Consolidate the workspace's agent memory (memory/ on the workspace filesystem): merge overlapping memories, " +
    "fix contradictions and stale dates, move entity facts to the knowledge layer, and prune the index every " +
    "conversation pays for. Import it, then schedule a crafted agent on schedule.fired to run it periodically — " +
    "or use it on demand when the memory index has grown noisy.",
  spec: {
    type: "skill",
    instructions: MEMORY_CONSOLIDATION_INSTRUCTIONS,
    files: [], // the whole pass fits one body — no progressive-disclosure references needed
  },
  visibility: "public",
  sharedWith: [],
  tags: ["memory", "maintenance", "example"],
  createdBy: "everdict",
  createdAt: "2026-08-06T00:00:00.000Z",
};

// --- First-party CATALOG (public + adoptable, but NOT auto-enabled defaults) ---
// A curated store entry a member ADOPTS (it needs per-user config, so it isn't a default). The first containerized
// stdio MCP capability: the official Grafana MCP server (grafana/mcp-grafana, Apache-2.0), run as
// `docker run --rm -i --env GRAFANA_URL --env GRAFANA_SERVICE_ACCOUNT_TOKEN grafana/mcp-grafana -t stdio` (the image
// defaults to SSE, so `-t stdio` selects stdio). The adopter binds the two env vars to their own secrets. Active only
// when the operator has enabled stdio MCP (AGENT_MCP_ALLOW_STDIO) AND the adopter has bound both secrets.
const GRAFANA_MCP: CapabilityRecord = {
  id: "grafana",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "grafana",
  description:
    "Query a Grafana instance — search dashboards, run Prometheus/Loki queries, list alert rules and incidents. " +
    "Add it to your workspace, bind your Grafana URL + a service-account token, and the agent runs the official " +
    "grafana/mcp-grafana server in a container. Read-only.",
  spec: {
    type: "mcp",
    image: "grafana/mcp-grafana",
    args: ["-t", "stdio"], // the image defaults to SSE mode; -t stdio selects the stdio transport
    provides: ["search_dashboards", "query_prometheus", "query_loki_logs", "list_alert_rules", "list_incidents"],
    requiredSecrets: [
      {
        name: "GRAFANA_URL",
        description:
          "Your Grafana base URL, e.g. https://myorg.grafana.net (bind to a workspace secret holding the URL).",
      },
      {
        name: "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        description: "A Grafana service-account token (Grafana → Administration → Service accounts → Add token).",
      },
    ],
    write: false,
  },
  visibility: "public",
  sharedWith: [],
  tags: ["observability", "grafana", "mcp", "built-in"],
  createdBy: "everdict",
  createdAt: "2026-07-28T00:00:00.000Z",
};

// The Playwright MCP server (microsoft/playwright-mcp, Apache-2.0) as a containerized stdio capability — browser
// automation over accessibility snapshots. No secrets (it drives an ephemeral headless chromium inside the container);
// stdio is the image's default transport, so no args. write=true because its tools (navigate/click/type) are actions,
// not read-prefixed — the adopter opts in via enableWrite; each call is still HITL-gated by the session's permission mode.
const PLAYWRIGHT_MCP: CapabilityRecord = {
  id: "playwright",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "playwright",
  description:
    "Drive a real browser — navigate, click, type, and read pages via Playwright's accessibility snapshots (token-" +
    "efficient, no screenshots). Runs the official microsoft/playwright-mcp server (headless chromium) in a container. " +
    "Enable write when you add it to allow the navigation/interaction tools.",
  spec: {
    type: "mcp",
    image: "mcr.microsoft.com/playwright/mcp",
    args: [],
    provides: ["browser_navigate", "browser_click", "browser_type", "browser_snapshot", "browser_take_screenshot"],
    requiredSecrets: [],
    write: true,
  },
  visibility: "public",
  sharedWith: [],
  tags: ["browser", "playwright", "mcp", "built-in"],
  createdBy: "everdict",
  createdAt: "2026-07-28T00:00:00.000Z",
};

// Postgres MCP Pro (crystaldba/postgres-mcp, MIT) as a containerized stdio capability — query + inspect a Postgres
// database. Pinned to `--access-mode=restricted` (read-only transactions + resource caps) so an adopted DB is never
// mutated. The adopter binds DATABASE_URI to their own connection-string secret. write=true so its query/inspect tools
// (not read-prefixed) bridge on enableWrite — the DB stays read-only via the restricted access mode regardless.
const POSTGRES_MCP: CapabilityRecord = {
  id: "postgres",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "postgres",
  description:
    "Query and inspect a Postgres database (schemas, indexes, query plans, health) in READ-ONLY restricted mode. " +
    "Runs the official crystaldba/postgres-mcp server in a container; bind your DATABASE_URI connection string.",
  spec: {
    type: "mcp",
    image: "crystaldba/postgres-mcp",
    args: ["--access-mode=restricted"], // read-only transactions + resource caps — never mutates the DB
    provides: ["list_schemas", "list_objects", "execute_sql", "explain_query", "analyze_db_health"],
    requiredSecrets: [
      {
        name: "DATABASE_URI",
        description:
          "Postgres connection string, e.g. postgresql://user:pass@host:5432/db (bind to a workspace secret).",
      },
    ],
    write: true,
  },
  visibility: "public",
  sharedWith: [],
  tags: ["database", "postgres", "sql", "mcp", "built-in"],
  createdBy: "everdict",
  createdAt: "2026-07-28T00:00:00.000Z",
};

// Everdict's SKILL examples — store entries only. A skill is a procedure a workspace owns and edits, so shipping one
// as a silent default would put a document in every workspace's agent that nobody there wrote, can edit, or can
// version. Instead they sit in the store as worked examples of what a good skill looks like; taking one COPIES it into
// the workspace's library (SkillService.importFromStore) where it becomes an ordinary workspace skill — editable in
// conversation, stamped with its own versions. That is also why the GitHub gate that used to guard scorecard_fix_pr is
// gone: nothing is auto-attached, so there is nothing to gate. The copy tells the agent to use the GitHub tools, and
// those are gated on their own.
// The self-evolution campaign (docs/architecture/agent-automation.md B5 closed into a procedure). A SKILL — not
// code: every step is a tool the agent already has (try_agent + ingest_scorecard + diff_scorecards + the campaign
// doors + save_agent), so what this adds is the DISCIPLINE — the trust harness as the oracle, a measured noise
// floor before any delta is read, one hypothesis per round, and adoption only over a statistically significant
// diff. The target may be the running agent itself: "self-evolving" is this skill pointed at its own configuration.
//
// ── THE SKILL AND THE SETTLEMENT SHIPPED TEN DAYS APART AND WERE NEVER JOINED ────────────────────────
//
// This procedure was drilled live (2026-08-16) against raw scorecards and a tracker issue; the campaign
// RECORD landed after it (2026-08-26, evolution-lineage Track D). The copy was then given three of the six
// campaign doors — open, settle, adopt — and never the two that make a campaign move: `log_campaign_round`
// and `campaign_decision`. So the procedure as written opened a campaign, logged nothing into it, and called
// settle, which the gate refuses because an empty round trace answers `continue`. Every campaign this skill
// opened would have stayed open forever.
//
// It is the "one lane only" shape with no method to grep: six tool NAMES in prose, of which four were taught.
// The repair is that the record is now the spine of the procedure rather than a paragraph in its step 4 — the
// gate is ASKED (`campaign_decision`) instead of restated, which also retires a re-derived adoption predicate
// that had already diverged from it (the prose counted whole-round improvements; the gate reads held-out).
//
// The trial floor moved 3 → 5 in the same pass, from the drill's own arithmetic: at N=3 a total flip is
// Fisher p = 0.10, so every round the old default authored was unable to produce a significant result.
const AGENT_EVOLVE_INSTRUCTIONS = `
# Evolve an agent configuration (self-evolution campaign)

Improve an agent configuration — including your own — with the trust harness as the oracle: a candidate is
adopted only when a statistically significant scorecard diff proves it better on held-out scenarios. You never
adopt on impression, and you never touch the oracle to make a candidate pass.

Everdict's tools load on demand. Before anything else:
\`ToolSearch\` with \`select:get_agent,try_agent,ingest_scorecard,get_scorecard,diff_scorecards,save_agent,create_issue,update_issue,open_campaign,log_campaign_round,campaign_decision,settle_campaign,campaign_adoption,adopt_campaign_candidate\`.

## 0. Frame the campaign — and freeze it
- Name the target (\`get_agent\`), the goal (which judge scores define "better"), and the scenario set: 5-10
  representative platform events — REPLAYED real events over invented ones — plus the trial count N per
  scenario.
- **N is at least 5, and it is chosen together with the round budget.** A total flip is the strongest per-case
  result there is and its p-value is fixed by N alone: 0/3 → 3/3 is Fisher p = 0.10 (never significant, so a
  round at N=3 spends real budget it cannot convert into evidence), 0/5 → 5/5 is 0.0079, 0/6 → 6/6 is 0.0022.
  The round is judged at \`fdrAlpha / heldOutFamilySize\` (below), so N=5 carries a walk of up to ~6 rounds and
  a longer one needs N=6+. A twenty-round campaign at N=5 cannot adopt anything and will spend its whole
  budget finding that out.
- Hold out at least 2 scenarios you will never quote or paraphrase while writing candidates — a candidate
  tuned to the eval verbatim is memorization, and the held-out rows are what catch it.
- Open a campaign issue (\`create_issue\`): the narrative journal. Then \`open_campaign\` { issueId, frame } —
  the RECORD, and the frame is FROZEN at that call and referenced by digest forever after. Put in it exactly
  what the decision will read: \`scenarios\` (each with \`heldOut\`), \`judges\`, \`trialsPerCase\`,
  \`budget.maxRounds\`, \`stopAfterRejectedRounds\`, and \`significance\`. There is no edit; a frame you want
  to change is a new campaign.
- \`significance\` needs BOTH \`fdrAlpha\` (the level, e.g. 0.05 — corrected across the cases of one round)
  and \`heldOutFamilySize\` (how many times this campaign may consult the held-out set). You test the same
  frozen held-out rows once per ROUND and any round can end the walk, so without a pre-registered family a
  long campaign adopts noise: three held-out cases at 0.05 over ten rounds is roughly a coin flip. Set the
  family to \`budget.maxRounds\` — larger only if a follow-up campaign will reuse the same held-out rows,
  because then the family spans the chain.
- \`heldOut: true\` is a FLAG THE GATE READS, and it reads only those rows. A private promise not to look at
  a scenario is not a held-out set — mark them, or the walk proves nothing about generalization.
- The frame's \`scenarios\` are the exam: every round's two batches must run EXACTLY that set. A batch that
  ran a different slice makes the round incomparable, with no error at submit time to warn you.
- State the budget cap up front (rounds x scenarios x N tries, \`try_agent\` spends real LLM budget). The
  frame's \`budget.maxRounds\` is the hard one: the RECORD refuses a round past it, and a round after the
  rejected streak has fired, with CONFLICT — you do not have to count, and you cannot overrun it.
- **Two waivers, declared at open, because this loop scores INGESTED traces.** An ingested scorecard seals no
  manifest, so every identity axis reads unverified on every round; and it names no registry document, so an
  adoption over it can name only a version LABEL. The gate refuses both by default, so the frame carries
  \`allowUnverifiedIdentity: true\` AND \`allowLabelOnlyAdoption: true\`. Without them the first WINNING
  round halts \`identity_unverified\` and the campaign can neither adopt nor settle. That is the honest price
  of shadow tries; \`harness_evolve\` runs real batches and needs neither.

## 1. Baseline — and its noise floor
- For each scenario run \`try_agent\` { agentId } N times; collect each result's \`trace\`.
- Ingest ONE scorecard (\`ingest_scorecard\`): \`harness: { id: "agent:<agentId>", version: <its version> }\`,
  one \`traces[]\` entry PER TRY with \`caseId\` = the scenario id (repeated caseIds ARE the trials), and the
  goal judges in \`judges\`. The frame's \`judges\` are checked against the judges that SCORED each side (the
  scoring ledger), so the same set goes into every ingest on both sides.
- Read the batch's trial summary (\`get_scorecard\`): the per-case variance and flake rate are the NOISE FLOOR.
  A delta smaller than this floor is not information. If the baseline itself is wildly flaky (flake rate
  above ~0.4), stop and fix scenario determinism first — evolution on a noisy oracle adopts noise.

## 2. Mutate — one hypothesis per round
- Prefer STRUCTURE over wording: tool/skill selection, stop conditions, escalation rules, model choice move
  outcomes; prompt micro-edits measure as noise (the ExitGuard campaign's lesson).
- A candidate that only changes instructions rides \`try_agent\`'s \`draft.instructions\` overlay — evaluated
  WITHOUT saving a version. A candidate that changes tools/skills/model must be saved first (\`save_agent\`
  auto-bumps an immutable version); evaluate that saved id.
- ⚠️ A REJECTED ROUND IS NOT ALWAYS A DEAD END, and the difference is in its verdict. A round rejected with
  \`heldOut.regressions > 0\` is worse — abandon that direction. A round rejected while COMPARABLE with zero
  improvements and zero regressions is NEUTRAL, and neutral is a foundation: keep that version and author the
  next candidate ON TOP of it. Every round compares against the frame's frozen baseline, never against the
  previous round, so two neutral steps that only pay off together are measured as one cumulative delta and
  the walk can reach them. Delete the versions that were WORSE; keep the neutral ones until the campaign
  closes, then delete what did not ship.
- This matters more here than elsewhere because the family correction makes neutral rounds MORE common: the
  round is judged at \`fdrAlpha / heldOutFamilySize\`, so a real but small effect will often not clear it. An
  honest detection floor produces steps that are genuinely useful and individually unprovable, and throwing
  them away is throwing away what the honesty cost.
- One variable per round, and write the hypothesis to the campaign issue BEFORE running it.
- FIRST read what the walk already knows: \`get_campaign\` returns every round's \`learned\`, the rounds that
  LOST included. A rejected round is the one most likely to know why, and reading nineteen of them is how
  round twenty stops repeating them. Name which finding you are acting on.
- Open the FAILING cases' traces before hypothesising, not after the surprise — the trace reads take a page,
  so a long run costs a window rather than the whole thing. A hypothesis formed from scores alone is a guess
  about a mechanism nobody looked at.
- ⚠️ THE CANDIDATE NEVER RECEIVES THE FINDINGS. They are input to YOUR proposal, never to the agent being
  measured; do not paste them into the candidate's instructions. A subject told what its evaluators concluded
  stops producing traces that show how the configuration actually behaves, and the next round loses its
  evidence. Measured, not theoretical: WikiSkill (arXiv 2608.27454) gave that knowledge to the proposer for
  +15.0 points, then also to the executing agent and lost 2.8. Same law as never touching the oracle
  mid-campaign — the thing under measurement may not read the measurement's notes.

## 3. Evaluate the candidate
- Same scenarios, same N, same judges → a second ingested scorecard (candidate version label in \`harness\`).
- \`diff_scorecards\` { baseline, candidate } is for YOUR reading — what moved, and where to aim the next
  hypothesis. Read \`comparability\` FIRST — 'none' means the comparison does not hold, which is a different
  fact from "no difference". The trials diff carries per-case Fisher/z significance with the FDR correction
  and the practical minDelta floor already applied.
- Then RECORD the round: \`log_campaign_round\` { hypothesis, learned, candidateVersion,
  baselineScorecardId, candidateScorecardId }. **You do not send a verdict.**
- \`learned\` is required, and it is the half that survives: the verdict is derived and the budget is spent,
  but what the round TAUGHT is the only thing round N+1 can use. Write the MECHANISM, not the outcome — "the
  tool budget was the binding constraint, not the prompt" is a finding; "it did not improve" is the verdict
  restated. A round the platform could not compare has no verdict at all and still has a finding. The platform derives it from that same diff, so the
  loop cannot write its own report card — and a round you never logged is a round the campaign cannot count.
- A round the platform records as not-comparable still spends a round and counts toward the rejected streak.
  Read its reason before spending another one: the usual causes are a batch that ran a slice the frame does
  not name, thinner trials than \`trialsPerCase\`, a judge set that differs from the frame's, or a confound —
  an axis the diff proved actually different between the two sides, which no waiver forgives.
- The record REFUSES (CONFLICT) a round once the frame's own ending has fired — the budget is spent, or the
  rejected streak was reached. That is not an error to work around: ask \`campaign_decision\` and settle.

## 4. Decide — ask the gate, never re-derive it
- \`campaign_decision\` answers \`continue\` · \`adopt\` · \`halt\`, reading the frozen frame and the whole
  round trace. Ask it; do not re-implement it. The arithmetic is the frame's, and it reads the HELD-OUT
  counts — improving where you have been pushing is evidence about your search, not about the agent.
- \`continue\` → back to step 2. \`halt\` → \`settle_campaign\` and report the reason (\`no_improvement\` after
  the rejected streak · \`budget_exhausted\` · \`identity_unverified\`, which is asking which bytes you
  measured rather than ending the walk).
- \`adopt\` → adoption is not a save you perform, it is an authorization you spend. \`settle_campaign\` writes
  it, \`campaign_adoption\` reads it back, and \`adopt_campaign_candidate\` presents it with the spec being
  registered: the platform compares every coordinate against the stored proof and refuses a candidate
  substituted between the evaluation and the registration. Spendable ONCE, and re-drivable after a crash.
  Bare \`save_agent\` still works for campaign-less work; it carries no proof, so it claims nothing about
  having been measured.
- Only the LATEST round is adoptable. If round 4 won and round 5 regressed, re-run round 4's candidate to
  adopt it — the gate does no archaeology over the trace.
- ⚠️ An INGESTED scorecard seals no manifest and names no registry document, so a round over one carries every
  identity axis as unverified and no candidate spec digest. The gate refuses that by default, twice: record
  \`allowUnverifiedIdentity: true\` AND \`allowLabelOnlyAdoption: true\` on the frame at open when the loop
  runs on ingested traces, or run the candidate through a batch that seals a manifest. Either refusal reads
  \`identity_unverified\` and keeps the campaign open — it is asking which bytes you measured, in which world,
  not ending the walk — and its detail names the frame field that would have waived it. A frame missing one
  cannot be repaired in place: open a new campaign with both.
- Present the diff and ask the member BEFORE adopting when working interactively; in headless automation park
  it behind an approval — never silently swap a live configuration.
- Rejection changes nothing about the agent: the round is already recorded, so write the hypothesis and what
  the diff said into the issue and move on.
- Close the ISSUE (\`update_issue\`) naming the adopted version and the scorecard that proved it, or the
  reason the gate halted with the strongest rejected hypothesis named. The record already holds the
  arithmetic; the issue is where a reader learns what you were thinking.
- ⚠️ A campaign with no logged rounds cannot be settled — the gate answers \`continue\` on an empty trace and
  \`settle_campaign\` refuses that. If you opened one, either walk it or say in the issue why it was abandoned.
- To KEEP GOING after an adoption, open the next campaign with \`continues: <this campaign's id>\` and its
  baseline set to the adopted version. That is not a convenience: a successor over the same held-out rows
  spends more tests against them, so the chain shares ONE \`significance\` block and the family covers every
  round in the chain. The open refuses when it would not — shorten the next budget, or start a fresh campaign
  on rows nobody has asked yet.

## Constraints
- NEVER weaken judges, verdict policy, or scenarios mid-campaign to make a candidate pass — changing the
  oracle to manufacture a win is the exact failure this procedure exists to prevent. If the oracle is wrong,
  fix it first, then restart with a fresh baseline under the fixed oracle.
- \`try_agent\` is shadow (reads run for real, writes are captured and denied) — it can never leave side
  effects, but it spends the workspace's real budget; respect the frame's cap.
- Evolving YOURSELF changes nothing mid-conversation: the adopted version applies to future sessions, so say
  that in the closing report instead of implying the current conversation improved.
- Load \`references/campaign-log.md\` (via \`read_skill_file\`) for the campaign issue's mandatory structure.
`.trim();

// The campaign issue's structure — a supporting file (progressive disclosure), so the audit trail is uniform
// across campaigns whoever (or whatever) ran them.
const AGENT_EVOLVE_CAMPAIGN_LOG = `
# Campaign log structure (mandatory)

The campaign issue must let a reader judge the walk without this conversation:

- **Frame** — the campaign RECORD id (from \`open_campaign\`) first, then target agent@version, goal judges,
  scenario ids with the held-out rows marked, N trials, budget cap. The record holds the frozen frame; this
  line is so a reader can reach it.
- **Noise floor** — baseline scorecard id, flake rate, per-case variance. This is what tells you whether a
  delta is readable at all; it is NOT the adoption rule — the gate is.
- **Rounds** — one row per round: hypothesis (the ONE variable) · candidate (draft or saved version) ·
  baseline/candidate scorecard ids · what the diff showed and why it pointed at the next hypothesis. The
  round's own verdict lives in the record, derived — do not restate it here as if you had decided it.
- **Close** — the gate's answer and what was done with it: the adopted version + the proving scorecard id,
  or the halt reason with the strongest rejected hypothesis named. Never close without one of the two.
`.trim();

const AGENT_EVOLVE: CapabilityRecord = {
  id: "agent-evolve",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "agent_evolve",
  description:
    "Run a self-evolution campaign on an agent configuration (your own included): baseline it with repeated " +
    "shadow tries scored as trials, measure the noise floor, mutate ONE variable per round, and adopt a new " +
    "version only over a statistically significant scorecard diff on held-out scenarios. Use when a member asks " +
    "to improve an agent — or when the agent's own regressions warrant a measured walk.",
  spec: {
    type: "skill",
    instructions: AGENT_EVOLVE_INSTRUCTIONS,
    files: [{ path: "references/campaign-log.md", content: AGENT_EVOLVE_CAMPAIGN_LOG }],
  },
  visibility: "public",
  sharedWith: [],
  tags: ["agent", "evolution", "scorecard", "example"],
  createdBy: "everdict",
  createdAt: "2026-08-16T00:00:00.000Z",
};

// ── THE OTHER SUBJECT, WHICH WAS THE ORIGINAL ONE ───────────────────────────────────────────────────
//
// `CampaignSubject.type` is `agent | harness`, and until now only one of the two had a procedure. That is
// backwards relative to what this product is: everdict evaluates HARNESSES, and the agent loop is the
// reference owner runtime pointed at its own configuration.
//
// It is also the loop with the stronger evidence, which is the thing worth teaching. `agent_evolve` scores
// INGESTED traces, so its rounds name no registry document and its frames end up carrying
// `allowLabelOnlyAdoption`. A harness round is a real batch: submit seals `harness.specDigest`, and every case
// records the image bytes it actually ran from. Identity is `exact`, the world axis reads `held`, and neither
// waiver has any business on the frame — so "needs no waivers" is this skill's headline rather than a footnote.
//
// The asymmetry that makes the levers safe is worth stating too, because it reads like a trap and is not: the
// campaign's two sides are two VERSIONS of one harness, so the harness is the treatment. `harness_model`
// abstains when the treatment moved (the delta IS the treatment), and `execution_world` compares what each
// CASE ran from — `imageProvenance` is the driver's resolution of `evalCase.image`, the task container, which
// no harness pin touches. Changing a model or an image pin is therefore a hypothesis, not a confound.
const HARNESS_EVOLVE_INSTRUCTIONS = `
# Evolve a harness (optimization campaign on the scaffold)

Improve a HARNESS — the scaffold the agent under test runs inside — with the trust harness as the oracle: a
candidate is adopted only when a statistically significant scorecard diff proves it better on held-out
scenarios. \`agent_evolve\`'s subject is an agent configuration; this one's subject is the thing being
evaluated, which is what everdict is for.

Everdict's tools load on demand. Before anything else:
\`ToolSearch\` with \`select:list_harnesses,get_harness_instance,diff_harness_versions,register_harness,pin_harness_images,run_scorecard,get_scorecard,estimate_scorecard,diff_scorecards,create_issue,update_issue,open_campaign,log_campaign_round,campaign_decision,settle_campaign,campaign_adoption,adopt_campaign_candidate\`.

## Why this loop needs no waivers — and what that obliges
Every round here is a REAL batch, which buys two things the ingested-trace loop cannot have:

- submit seals \`harness.specDigest\`, so an adoption names the BYTES it measured. Identity is \`exact\` and
  \`allowLabelOnlyAdoption\` has no business on this frame.
- each case records the image bytes it actually ran from, so the world axis reads held rather than unverified.
  \`allowUnverifiedIdentity\` has no business here either.

If you find yourself wanting either waiver, the BATCH is wrong, not the frame. Fix the batch.

## 0. Frame the campaign — and freeze it
- \`subject: { type: "harness", id, baselineVersion }\` — one harness family, one fixed baseline version.
- \`scenarios\` — the dataset case ids this campaign runs, each with \`heldOut\`. At least two held out, and
  those rows are the only ones the gate reads: improving where you have been pushing is evidence about your
  search, not about the scaffold.
- \`trialsPerCase\` N and \`budget.maxRounds\`, chosen TOGETHER. A total flip is the strongest per-case result
  there is and its p-value is fixed by N alone: 0/3 → 3/3 is Fisher p = 0.10 (never significant), 0/5 → 5/5 is
  0.0079, 0/6 → 6/6 is 0.0022. Rounds are judged at \`fdrAlpha / heldOutFamilySize\`, so N=5 carries about six
  rounds and a longer walk needs N=6+.
- \`significance: { fdrAlpha, heldOutFamilySize }\` — both required. The held-out rows are tested once per
  ROUND and any round can end the walk, so the family is pre-registered: set it to \`budget.maxRounds\`, larger
  only if a follow-up campaign will reuse the same held-out rows.
- \`judges\` when the goal is a judge score. The frame pins them and both sides must match exactly.
- \`create_issue\` for the narrative journal, then \`open_campaign { issueId, frame }\` for the RECORD. Frozen
  at that call; a frame you want to change is a new campaign.
- Price the walk BEFORE opening it (\`estimate_scorecard\`): a round is cases x N executions, and unlike a
  shadow try that is compute as well as tokens. The baseline is run once and reused, so steady state is one
  batch per round.

## 1. Baseline — and its noise floor
- \`run_scorecard { dataset, harness: <id>@<baselineVersion>, trials: N }\`, then \`get_scorecard\`: the
  per-case variance and flake rate are the NOISE FLOOR. A delta smaller than this floor is not information,
  and a baseline flaking above ~0.4 means you are about to evolve on a noisy oracle — fix scenario determinism
  first.
- The baseline is reused every round, and a reused baseline AGES. If the dataset's task image is a moving tag,
  an old baseline and a fresh candidate record different image bytes and every round comes back confounded on
  \`execution_world\`. Re-run the baseline; never waive it, because a delta measured across two worlds says
  nothing about the scaffold.

## 2. Mutate — one lever per round
A candidate is an INSTANCE: \`{ template: {id, version}, id, version, pins, overrides? }\`. The template is the
structure and the instance fills its slots, so the levers are ordered by how much structure they move:
\`pins.model\` · \`overrides\` (env/params the template exposes: retries, tool budgets, timeouts) ·
\`pins.image\` (the scaffold's own bytes) · \`template.version\` (a different structure — the biggest lever,
and the one that most deserves a fresh baseline). Load \`references/levers.md\` for what each one costs.

- \`register_harness\` with the instance JSON mints an immutable new version; \`pin_harness_images\` does the
  image-only case headlessly.
- ONE lever per round, and write the hypothesis to the issue BEFORE running it — after reading what the walk
  already knows (\`get_campaign\` carries every round's \`learned\`, the losing ones included) and after
  opening the failing cases' traces, which read a page at a time so a long run costs a window.
- ⚠️ THE CANDIDATE NEVER RECEIVES THE FINDINGS. They shape YOUR next lever; they do not go into the harness's
  prompt, env or pins. A scaffold told what its evaluators concluded stops producing traces that show how it
  behaves — measured at −2.8 points in WikiSkill (arXiv 2608.27454) against +15.0 for giving the same
  knowledge to the proposer alone. The oracle rule and this rule are the same rule.
- \`diff_harness_versions\` between baseline and candidate is how you CHECK you moved one thing. Read it before
  the batch, not after the surprise.
- ⚠️ Keep a rejected instance until you know WHY it was rejected. Regressions on held-out mean the lever was
  wrong — abandon it and \`delete_harness\` the version. But a comparable round with zero improvements and
  zero regressions is NEUTRAL, and a neutral instance is a base to build the next lever on: the comparison is
  always against the frame's frozen baseline, so a second lever stacked on it is measured as the cumulative
  delta and a two-step win is reachable. The family correction (\`fdrAlpha / heldOutFamilySize\`) makes these
  common — a real but small effect often will not clear the round's level — so discarding them wastes exactly
  what the correction cost. Sweep the registry when the campaign closes, not while it is walking.

## 3. Evaluate the candidate, and record the round
- The same dataset, the same N, the same judges → a second batch on the candidate version.
- \`diff_scorecards\` is for YOUR reading — what moved, and where to aim next. Read \`comparability\` FIRST:
  'none' means the comparison does not hold, which is a different fact from "no difference".
- Then \`log_campaign_round { hypothesis, learned, candidateVersion, baselineScorecardId,
  candidateScorecardId }\`. \`learned\` is required — the mechanism this round established, not its outcome;
  it is what the next round reads and the only thing a REJECTED round leaves behind. You
  do NOT send a verdict — the platform derives it from that same diff, so the loop cannot write its own report
  card, and a round you never logged is a round the campaign cannot count.
- A round recorded as not-comparable still spends a round and counts toward the rejected streak. Read its
  reason first: a slice the frame does not name, trials below \`trialsPerCase\`, a judge set that differs, or a
  confound.

## 4. Decide — ask the gate, never re-derive it
- \`campaign_decision\` answers \`continue\` · \`adopt\` · \`halt\` over the frozen frame and the whole round
  trace. Ask it; do not re-implement it.
- \`continue\` → back to step 2. \`halt\` → \`settle_campaign\` and report the reason. The record refuses
  (CONFLICT) a round past the budget or after the rejected streak — a campaign that has ended by its own rule
  is settled, not extended.
- \`adopt\` → \`settle_campaign\` writes the authorization, \`campaign_adoption\` reads it back, and
  \`adopt_campaign_candidate\` spends it. Hand it the INSTANCE spec you registered in step 2 — not the resolved
  document: the platform resolves, registers, reads back and compares against what the campaign measured.
- Only the LATEST round is adoptable. If round 4 won and round 5 regressed, re-run round 4's candidate.
- To keep going, open the next campaign with \`continues: <this campaign's id>\` and its baseline set to the
  adopted version. The chain shares one \`significance\` block and one family across every round in it, so the
  open refuses a successor that would overspend what the walk pre-registered — shorten its budget, or start
  fresh on held-out rows nobody has asked yet.

## Constraints
- NEVER weaken the dataset, the judges or the verdict policy mid-campaign — changing the oracle to manufacture
  a win is the exact failure this procedure prevents. Fix the oracle, then restart with a fresh baseline.
- Moving the SCAFFOLD is never a confound: the model-closure axis abstains when the harness itself moved, and
  the world axis reads the TASK container, which your pins do not touch. What IS a confound is the task
  container moving under you.
- Adopting changes what every future batch on that harness runs. Present the diff and ask before adopting when
  working interactively; park it behind an approval in headless automation.
`.trim();

// The levers, as a supporting file: which knobs a harness instance actually exposes, and — the half that reads
// like a trap — why moving them is a hypothesis rather than a confound.
const HARNESS_EVOLVE_LEVERS = `
# The levers, and what each one is

A harness instance is \`{ template: {id, version}, id, version, pins, overrides? }\`. The TEMPLATE is the
structure — which commands run, which slots exist — and the instance fills the slots. So the levers below are
ordered by how much structure they move, which is also roughly the order of how much they move outcomes.

**\`pins.model\`** — which model the scaffold drives. Usually the largest single-variable effect available, and
the cheapest to author: one pin, one new instance version.

**\`overrides\`** — structure-invariant behaviour the template exposes (env, params, body): retry counts, tool
budgets, timeouts, the parameters a template deliberately left open. Prefer these over prompt micro-edits;
wording changes measure as noise, stop conditions and budgets do not.

**\`pins.image\`** — the scaffold's own bytes. \`pin_harness_images\` mints an image-only successor headlessly,
which is the same door CI re-pins through, so a campaign candidate and a merge re-pin produce the same shape.

**\`template.version\`** — a different STRUCTURE. The biggest lever and the least comparable one: a new template
changes what runs, so give it a fresh baseline rather than diffing it against a scaffold it no longer resembles.

## Why none of these is a confound
A campaign's two sides are two VERSIONS of one harness, so the harness IS the treatment, and the identity axes
are built for exactly that:

- \`harness_model\` applies only under a held treatment — same harness id@version on both sides. In a campaign
  the version always differs, so the axis claims nothing: the delta is the treatment.
- \`execution_world\` compares what each CASE ran from. The recorded provenance is the driver's resolution of
  the eval case's own image — the task container — which no harness pin touches.

## What IS a confound
- **The task container moving under you.** A mutable dataset image tag means an old baseline and a fresh
  candidate ran different bytes; the axis says so and the round is not comparable. Re-run the baseline.
- **Judges differing between the sides.** The frame pins them; the batches must match it exactly.
- **Resources, network, lane or isolation differing.** Two enforcement mechanisms are two worlds, whether or
  not the numbers agree.

A confound is never waivable, and that is deliberate: \`allowUnverifiedIdentity\` records that an axis could not
be VERIFIED, which is a different claim from one the platform verified as different.
`.trim();

const HARNESS_EVOLVE: CapabilityRecord = {
  id: "harness-evolve",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "harness_evolve",
  description:
    "Run an optimization campaign on a HARNESS — the scaffold under test: baseline it with repeated trials, " +
    "measure the noise floor, move ONE lever per round (model pin, overrides, image, template), and adopt a new " +
    "instance version only over a statistically significant diff on held-out scenarios. Real batches, so the " +
    "adoption names the bytes it measured and needs no identity waiver. Use when a member asks to improve a " +
    "harness, or when a scorecard trend says the scaffold is the ceiling.",
  spec: {
    type: "skill",
    instructions: HARNESS_EVOLVE_INSTRUCTIONS,
    files: [{ path: "references/levers.md", content: HARNESS_EVOLVE_LEVERS }],
  },
  visibility: "public",
  sharedWith: [],
  tags: ["harness", "evolution", "scorecard", "example"],
  createdBy: "everdict",
  createdAt: "2026-09-01T00:00:00.000Z",
};

// ── THE THIRD SUBJECT IS A REPOSITORY (docs/architecture/code-evolution-loop.md) ────────────────────
//
// `harness_evolve` moves a LEVER — a pin, an override, a template version — and leaves the author of that lever
// to the driver. The loop the maintainer actually wants changes the harness's CODE: a coding agent, in an
// isolated sandbox with the repository checked out, proposes the change; the repository's own CI builds the
// image; the campaign decides. Every part of that existed as a separate skill or door (`delegate_work`, the
// GitHub Actions trigger, `pin_harness_images`, the campaign) and nothing composed them, so this is the
// composition — a SKILL, not code, for the same reason the other two are: each step is a tool the agent has.
//
// Two facts shape the procedure and are stated in it rather than hidden. Only a CONVERSATIONAL harness can be a
// delegation profile (`ClaudeCodeHarness` carries the marker; a `CommandHarness` carries it when its template
// declares a `conversation` contract — docs/command-harness.md); a command harness without one rides the
// playground's `harness` boot mode one prompt at a time. And the CI-fired PR evaluation (the alternative path) runs
// against the BASE version with an ephemeral pin override, so its record names the base version and cannot be
// a round's candidate as-is: the driver pins that CI-built digest into a REAL instance version (on the CI alternative path) and runs the
// round's batch on that — which is also what keeps the adoption's identity exact.
const CODE_EVOLVE_INSTRUCTIONS = `
# Evolve a harness by changing its code (delegated, sandboxed, built by Everdict)

Improve a HARNESS by changing the code in its repository — not a pin, the code — with the trust harness as the
oracle. A coding agent you DELEGATE to makes the change in an isolated sandbox; Everdict builds the image into
its own managed store and mints the candidate version; you run the round, and let the campaign gate decide. You never
write the harness's code yourself, you never touch the oracle, and you never merge on your own authority.

Everdict's tools load on demand. Before anything else:
\`ToolSearch\` with \`select:list_public_capabilities,list_capabilities,create_sandbox,submit_sandbox_task,read_sandbox_task_trace,sandbox_exec,sandbox_git_push,close_sandbox,get_harness_instance,resolve_harness_delegate,diff_harness_versions,build_campaign_candidate,get_campaign_builds,pin_harness_images,run_scorecard,get_scorecard,list_scorecards,diff_scorecards,create_issue,update_issue,add_issue_link,open_campaign,get_campaign,get_campaign_round_evidence,log_campaign_round,campaign_decision,settle_campaign,campaign_adoption,adopt_campaign_candidate,merge_campaign_candidate\`.

## 0. Frame the campaign — the exam, the repository, the delegate, the oracle's paths
- Everything \`harness_evolve\` freezes, frozen the same way: \`subject: { type: "harness", id, baselineVersion }\`,
  \`scenarios\` with at least two held out, \`trialsPerCase\` and \`budget.maxRounds\` chosen together,
  \`significance: { fdrAlpha, heldOutFamilySize }\`, \`judges\`. Real batches: no identity waiver belongs on this frame.
- **The repository and build recipe, on the harness template.** The slot's \`source { git, repo }\` and
  \`build { steps, workDir, capture }\` say where the code lives and how Everdict builds its image. A harness
  whose template has no recipe cannot run this loop — add it (a new template version) before opening the
  campaign. Everdict builds into its own managed store; you do not need an outside CI or a registry of your own.
- **The delegate — WHO, read off the template, never asked.** \`resolve_harness_delegate { id, slot? }\` answers
  the delegation profile the slot's \`source.maintainer\` names: the coding agent built for THAT repository (its
  instructions file, its conventions, its model). Use exactly that profile. \`unmapped\` means the slot has code
  and no maintainer — register a template version that declares one, then continue; \`ambiguous\` means several
  slots carry code — name the slot the evidence points at. Do not pick an agent yourself and do not ask the
  member which one: the template is the owner of that fact. A profile's harness is a CONVERSATIONAL coding
  agent: Claude Code (built in), or any CLI registered as a \`command\` harness with a \`conversation\` block
  (how it resumes, how its next token is read) — Codex, claude-code-router. A CLI registered without that
  block is one-shot and can only be driven through \`create_sandbox { harness }\` one prompt at a time. The profile also decides the delegate's BOX: its \`network\` (\`allowlist\` with the
  repository host and the model endpoint), and \`create_sandbox { runtime }\` places the session on a workspace
  runtime that can enforce it rather than the control plane's docker. The agent runs in ITS image with ITS model
  binding, and it never sees your tools or the workspace.
- **Memory first.** Before the FIRST hypothesis, read \`get_harness_lineage { id }\` (how each version got here —
  its predecessor, what moved, what it ships with, which campaign proved it) and
  \`list_campaigns { subject_type: "harness", subject_id }\`:
  every campaign ever opened on this harness, each round's verdict and \`learned\`, what was adopted and what
  halted. A hypothesis that already lost is not spent again; a neutral candidate that was abandoned may be the
  foundation to build on.
- **The previous round's evidence, not your notes.** Before proposing round N+1, read
  \`get_campaign_round_evidence { id, seq: N }\`: per compared case — held-out / target flags, both sides' pass
  rates and trials, the per-case verdict (improved · regressed · unchanged · unclear), and the run ids whose
  traces show the mechanism. The platform derived it and sealed it by digest; your \`learned\` is advice about it.
  Brief the delegate with the failing TARGET ids and the slot the evidence points at — never with judge rationale
  or trace excerpts (the candidate must not receive the findings). Each case carries \`diagnoses\` (a judge's
  structured verdict: kind, locus, confidence) and \`attribution\` — \`measured\` with the slot and the platform's
  reasons, or \`unattributed\` with why. Delegate to the attributed slot's maintainer; when a case is
  unattributed, choose the slot yourself and SAY in the brief that you chose it.
- **A change across several services.** When the attributed slots span two services of ONE pull request, build
  them as a set — \`build_campaign_candidate { id, ref, repo, pr_number, slots: ["web", "api"] }\` — and the set
  mints ONE candidate version carrying every pin (\`get_campaign_build_sets\`). Two repositories are two hypotheses:
  open two campaigns.
- **The issue's cases.** Link the failing cases to the issue first — \`add_issue_link { type: "case", linkId:
  <caseId>, dataset, version }\` — and open the campaign with \`frame: { fromIssue: true, … }\` (everything but
  \`scenarios\`/\`targets\`): the platform makes the linked cases the TARGETS and every other case of that dataset
  version held-out, and the gate adopts only when every target flipped with zero held-out regressions. That is
  how "the actual issue was resolved" is verified rather than claimed. A frame you write by hand may name
  \`targets\` directly; a target is never held-out.
- **The oracle's paths.** Name the repository paths that ARE the exam — the dataset, judge rubrics, eval configs,
  the tests the graders run — as the frame's \`oracleScope\` (patterns: \`tests/\`, \`evals/**\`,
  \`judges/rubric-*.md\`). The record reads every candidate pull request's changed files against it and rejects a
  round that touched one ("the candidate touched the oracle", paths on the verdict), or that could not be
  checked. Put the same paths into every brief as a constraint WITH the reason, so the delegate is told before
  it is refused.
- **The delegation budget.** \`delegation: { ttlSec, maxUsd }\` on the frame caps the coding agent per round. Every
  round then names its sandbox session (\`delegation_run_id\`), and the record reads what that session cost off
  the run ledger and refuses a round whose session ran past the budget — so open each session with \`ttlSec\`
  at most the frame's.
- \`create_issue\` for the journal, then \`open_campaign { issueId, frame }\`. Frozen at that call.

## 1. Baseline — and its noise floor
- \`run_scorecard { dataset, harness: <id>@<baselineVersion>, trials: N }\`, then \`get_scorecard\`: per-case variance
  and flake rate are the NOISE FLOOR. A baseline flaking above ~0.4 means fix scenario determinism first.
- Note the baseline's source: the commit its pinned image was built from. The chain check will want the next
  campaign to start from what this one adopts, in code as well as in bytes.

## 2. Delegate the mutation — one hypothesis, one PR
- Read what the walk knows: \`get_campaign\` for every round's \`learned\`, then the failing cases' traces. Form ONE
  hypothesis about the CODE — a mechanism, not a wish.
- Open the session: \`create_sandbox { profile, repo: { git, ref: <default branch> }, brief, ttlSec }\` with
  \`ttlSec\` inside the frame's delegation budget, and keep its run id — the round names it. The brief follows
  \`references/round-brief.md\` — \`goal\` as a condition on the harness's behavior on the failing scenarios,
  \`context\` with the hypothesis and what is already ruled out, \`references\` to the scorecard and traces with a
  note each, \`constraints\` that name the oracle's paths and the one lever, \`doneWhen\` as the repository's own
  tests and build.
- Supervise: \`submit_sandbox_task\` one turn at a time, \`read_sandbox_task_trace\` until done, and read what it DID.
  Push back when it drifts from the one lever. If it reports the hypothesis is wrong, believe it and re-scope.
- Verify yourself with \`sandbox_exec\`: the tests, the build, and \`git diff --stat\` against the oracle's paths.
- Land the candidate: commit inside the session, then \`sandbox_git_push\` with a pull request. That push is a
  GUARDED action — it pauses for the member — so say what is about to land before you call it. Do NOT merge.
- ⚠️ The findings shape the BRIEF, never the HARNESS. A delegate that writes the judges' conclusions into the
  scaffold's prompts or config has made the candidate read its own exam; that is the oracle rule and the
  reason step 3 reads the diff before it reads the score.
- \`close_sandbox\` when the PR is open; the session's trajectory stays on the ledger.

## 3. Let EVERDICT build it, then run the round
- \`build_campaign_candidate { id, ref: <pr head sha>, repo, pr_number }\` — Everdict boots the harness slot's
  base image, checks out the commit, runs the template's frozen build steps, and publishes the result as one
  layer in ITS OWN managed store. No outside CI, no registry you have to own. It returns a \`building\` record;
  wait on \`campaign.candidate_built\` (or poll \`get_campaign_builds\`), which names the minted candidate
  version. A \`campaign.candidate_build_failed\` carries the build's error — read it, fix the code, build again.
- This needs the harness TEMPLATE to declare the slot's \`source { git, repo }\` and \`build { steps, workDir,
  capture }\`. A template with no recipe cannot be built — evolve it by pinning, or add the recipe to the
  template first (a template change is a new template version).
- Read the PR's changed files against the oracle's paths yourself before you spend a build and a batch on it.
  The record refuses the round anyway (\`oracleScope\`), but a build you did not start is budget you did not
  spend: a PR that touched the exam is closed, noted in the issue, and re-briefed.
- \`diff_harness_versions\` between baseline and the built candidate is how you check you moved one thing.
- \`run_scorecard\` on \`<id>@<candidateVersion>\` (the version the build minted) with the same dataset, N and judges, and pass
  \`origin: { campaignId, repo, sha, prNumber }\` so the batch says which round it is and where its code came
  from; a \`scorecard.completed\` subscription filtered on \`campaignId\` wakes you when it lands. Then
  \`log_campaign_round { hypothesis, learned, candidateVersion, baselineScorecardId, candidateScorecardId,
  delegation_run_id }\`. The round records where the candidate came from (the scorecard's origin: repo, sha, PR,
  pin override) and what the delegate cost (from the run ledger) beside the verdict the platform derives. You do
  NOT send a verdict, and \`learned\` is the mechanism this round established — write it whatever the verdict.

## 4. Decide — ask the gate; adopt spends an authorization; the merge is the member's
- \`campaign_decision\`: \`continue\` → step 2 with the next hypothesis (a neutral round is a foundation: brief the
  next delegate on top of its branch). \`halt\` → \`settle_campaign\` and report. The record refuses a round past the
  budget or after the rejected streak.
- \`adopt\` → \`settle_campaign\`, \`campaign_adoption\`, \`adopt_campaign_candidate\` with the INSTANCE spec of the
  candidate version (\`get_harness_instance\`) — the platform compares the resolved document against what the
  campaign measured before it writes.
- Then the code: \`merge_campaign_candidate\` with the same proof pays the adoption's CODE debt — it merges the
  pull request the candidate scorecard named, at the head the round measured, through the workspace GitHub App.
  It is a GUARDED action (a member approves), it requires the bytes to be registered first, and the record
  refuses a \`continues\` chain over an adoption whose code is still owed. Adoption registered the bytes; the
  merge is what makes the next campaign's baseline source agree with them.
- Close the issue naming the adopted version, the proving scorecard and the merged PR — or the halt reason with
  the strongest rejected hypothesis. Delete the instance versions that were WORSE; keep neutral ones until the
  campaign closes.

## Constraints
- NEVER touch the oracle — dataset, judges, verdict policy, the graders' tests — in a brief, in a PR, or by hand.
- One hypothesis per round, one PR per hypothesis, one lever per PR.
- Do not paste secrets into a brief; the profile carries the delegate's credentials. Do not paste your tool names;
  the delegate cannot call them.
- Never report a candidate as built, evaluated or adopted on the delegate's word — the build record, the scorecard and
  the gate's answer are the evidence.
- Load \`references/round-brief.md\` (via \`read_skill_file\`) before writing any brief.
`.trim();

// The round's brief — a supporting file (progressive disclosure): the delegation brief's quality bar,
// specialized to an evolution round, and the oracle-path checklist the driver runs against the PR.
const CODE_EVOLVE_ROUND_BRIEF = `
# The round brief — what a delegate needs to change the harness, and nothing more

The general brief rules are \`delegate_work\`'s (\`references/brief.md\` there). An evolution round adds three
things: the hypothesis is the whole brief, the oracle's paths are a hard constraint, and the finish line is the
repository's own build and tests — never the scorecard, which the delegate cannot run and must not aim at.

## goal — the behavior, on the failing scenarios, as a condition
- Bad: "make the eval pass" (aims the delegate at the exam).
- Bad: "raise the tool budget to 40" (your solution; the delegate may find the mechanism is elsewhere).
- Good: "on tasks that need more than 20 tool calls the scaffold stops early because the turn budget is per
  session, not per task — make the budget per task without changing what a turn costs".

## context — the hypothesis and what is ruled out
Say which round this is, what earlier rounds LEARNED (the mechanism, not the score), which failing cases show it,
and what has already been tried. A delegate that re-derives your investigation spends its budget repeating you.

## references — evidence, each with a reason
The candidate scorecard and the specific runs whose traces show the mechanism, each with a \`note\` saying what
to look at. The delegate cannot open them with your tools; put the relevant excerpt in the brief.

## constraints — the oracle's paths, with the reason
- Name the paths: the dataset, judge rubrics, eval configs, the tests the graders run.
- Give the reason: "changing these changes the exam, and a candidate that changed its exam is not a candidate —
  the round is discarded, whatever it scores".
- Name the one lever, and say the change is one pull request against the default branch, no merge.

## doneWhen — checks you will run yourself with sandbox_exec
- The repository's own tests and build pass.
- \`git diff --stat <default branch>\` touches none of the oracle's paths.
- The diff is one lever: if it changed two mechanisms, split it or drop one.

## Before you log the round — the checklist
1. The PR's changed files against the oracle's paths: any hit → not a candidate.
2. Everdict's build record reads \`built\` and names the image DIGEST it published (a tag pins nothing); the build
   was asked for with the pull request's \`repo\` + \`prNumber\`, or the oracle cannot be checked.
3. The candidate version the build minted is the one you will log, and \`diff_harness_versions\` shows one slot
   moved.
4. The candidate batch ran the frame's exact scenarios, N trials, the frame's judges.
5. \`learned\` says what this round established about the MECHANISM — written before you read the verdict.
`.trim();

const CODE_EVOLVE: CapabilityRecord = {
  id: "code-evolve",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "code_evolve",
  description:
    "Run an evolution campaign that changes a HARNESS's code: delegate one hypothesis per round to a coding agent " +
    "in an isolated sandbox with the repository checked out, have Everdict build the image into its own store " +
    "and mint the candidate version, run the round, and adopt only over a statistically significant diff on " +
    "held-out scenarios. Use when a scorecard trend says the scaffold's code is the ceiling and a pin cannot fix it.",
  spec: {
    type: "skill",
    instructions: CODE_EVOLVE_INSTRUCTIONS,
    files: [{ path: "references/round-brief.md", content: CODE_EVOLVE_ROUND_BRIEF }],
  },
  visibility: "public",
  sharedWith: [],
  tags: ["harness", "evolution", "delegation", "scorecard", "example"],
  createdBy: "everdict",
  createdAt: "2026-09-02T00:00:00.000Z",
};

export function firstPartySkillExamples(): CapabilityRecord[] {
  return [
    SCORECARD_FIX_PR,
    TRACE_ANALYSIS,
    MEMORY_CONSOLIDATION,
    DELEGATE_WORK,
    AGENT_EVOLVE,
    HARNESS_EVOLVE,
    CODE_EVOLVE,
  ];
}

// The DELEGATOR's side of a delegation. The delegation profile (CODE_DELEGATE below) is written in the
// delegate's voice — "you are a delegate, here is how to report". Nothing told the other half of the loop how
// to RUN one: which environment to hand work to, what makes a brief answerable, how to supervise turns, and —
// the part that separates delegation from wishful thinking — how to verify the result yourself before
// reporting it as done. The system prompt says nothing about sandboxes, so without this the agent learns
// delegation from tool descriptions alone.
const DELEGATE_WORK_INSTRUCTIONS = `
# Delegate work to a registered environment

Hand a piece of work to another agent environment, supervise it, verify what comes back, and report with
evidence. The discipline: **you own the outcome**. The delegate does the work; you decide it is done, and you
never report "done" on the delegate's word alone.

Everdict's tools load on demand. Before anything else:
\`ToolSearch\` with \`select:list_public_capabilities,create_sandbox,submit_sandbox_task,read_sandbox_task_trace,sandbox_exec,close_sandbox\`
(add \`sandbox_git_push\`, \`snapshot_sandbox\` or \`run_scorecard\` when the job needs them).

## 1. Decide WHO does the work
- A delegation profile is a registered work environment (\`delegation\` capability): which agent runs, in which
  image, against which model, under which standing instructions. Find one with \`list_public_capabilities\` or
  \`list_capabilities\`; the member's own workspace profiles come first.
- If more than one could fit, or none obviously does, ASK the member rather than guessing. Delegating to the
  wrong environment wastes the whole loop, and the member usually knows which one they trust.
- Do not delegate what you can do directly in a few tool calls. Delegation is for work that needs a real
  workspace: reading a repository, running tests, iterating on code.

## 2. Decide WHERE it happens
The profile says who works; the target says where. They are independent — pick the one that fits:
- nothing — the delegate works in its own image (a clean room).
- \`repo:{git,ref?}\` — clone the code in; the usual choice for code work.
- \`world:{id}\` — a persistent world the delegate continues, so its work survives the session (it hibernates
  into the world's next version). Use this when the job spans more than one sitting.
- \`environment:{id}\` / \`image\` — a specific environment the job needs.

## 3. Write the brief
The brief is the handoff, and it lands in the delegate's working directory as \`BRIEF.md\`. Load
\`references/brief.md\` (via \`read_skill_file\`) for the quality bar. In short:
- \`goal\` — what must be TRUE when this is done, in one sentence. Not a task list.
- \`context\` — what happened, what has been tried, what you already know is NOT the cause.
- \`references\` — the evidence you are handing over (\`{type,id,note}\`): the scorecard that regressed, the run
  whose trace shows the failure, the issue that asked for it. Name why each one is in the brief.
- \`constraints\` — what must not change. Say the reason; a constraint whose reason is missing gets worked around.
- \`doneWhen\` — the checks YOU will apply. If you cannot write these, you are not ready to delegate.

## 4. Open the session and supervise
- \`create_sandbox\` with \`profile\` + \`brief\` (+ the target from step 2). It is always a conversation.
- \`submit_sandbox_task\` — one message at a time (a second while one runs is refused). Poll
  \`read_sandbox_task_trace\` until \`done:true\`; read what the delegate actually did, not just its last message.
- Keep talking. Ask for the reasoning when a result looks thin, push back when it drifts from the brief, and
  answer its questions — a delegate that asks is a delegate worth having.
- If the delegate reports the goal itself was wrong (the real fault is elsewhere), BELIEVE IT: stop, take the
  finding back to the member, and re-scope. Do not push it to satisfy a brief you now know is wrong.

## 5. Verify before you believe
- Run the \`doneWhen\` checks YOURSELF with \`sandbox_exec\` — the tests, the command, the file that should exist.
  "It should work now" is not a result.
- Where the work is an eval fix, re-evaluate: \`run_scorecard\`, then \`diff_scorecards\` against the baseline to
  show the regression is gone and nothing else broke.
- If verification fails, say so to the delegate and keep going. Reporting an unverified fix is the one failure
  that costs the member more than doing nothing.

## 6. Land it, then report
- Code: commit inside the session with \`sandbox_exec\`, then \`sandbox_git_push\` (optionally opening a pull
  request). That push is a GUARDED action — it will pause for the member's approval, so tell them what is
  about to land before you call it.
- A world: \`snapshot_sandbox\` so the next delegation starts where this one stopped.
- \`close_sandbox\` when the work is done — the session holds real compute, and its trajectory (brief, turns,
  evidence) stays on the ledger after the container is gone.
- Report to the member: what changed, how you verified it (the exact check and its outcome), and what is still
  open. Link the session run and the pull request.

## Constraints
- Never report work as done that you did not verify yourself.
- One task at a time per session; open a second session for genuinely parallel work.
- The delegate cannot see your tools or the workspace — everything it needs must be in the brief or in the
  environment you gave it.
- Do not paste secrets into a brief or a message. The profile already carries the delegate's credentials.
`.trim();

const DELEGATE_WORK_BRIEF_REFERENCE = `
# What makes a brief answerable

A delegate can only be as good as its brief. These are the failure modes, and the fix for each.

## goal — one sentence, stated as a condition
- Bad: "look at the failing tests and fix stuff" (no finish line).
- Bad: "edit src/parser.ts line 88" (that is your solution, not their goal — you may be wrong).
- Good: "the two spreadsheet cases that regressed after judge v3 pass again, without changing the dataset".

## context — what you already know
Say what happened, when it started, what you have ruled out, and what you suspect but have not confirmed.
A delegate that has to re-derive your investigation spends its budget repeating you.

## references — the evidence, each with a reason
Every reference carries a \`note\` saying WHY it is here: "the batch that regressed", "the trace showing the
timeout", "the issue that asked for this". A bare id makes the delegate guess what to look at first.

## constraints — with the reason attached
- Bad: "do not touch the dataset" (a delegate under pressure will find a way around it).
- Good: "do not touch the dataset — it is the benchmark's ground truth, changing it invalidates every past run".
State only real constraints. A brief full of invented rules gets treated as noise, and the real one goes with it.

## doneWhen — the checks you will actually run
Write them as things you can execute: "\`pnpm test parser\` passes", "the two cases in scorecard sc-9 pass on a
re-run", "no new lint error". If a criterion cannot be checked, it is a wish — either make it checkable or drop
it. These are also what you run in step 5, so writing them badly costs you twice.

## What NOT to put in a brief
- Secrets or tokens — the profile carries the delegate's credentials already.
- Your tool names — the delegate has its own environment and cannot call everdict's tools.
- A solution you have not verified. Say what you suspect, marked as a suspicion.
`.trim();

const DELEGATE_WORK: CapabilityRecord = {
  id: "delegate-work",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "delegate_work",
  description:
    "Hand a piece of work to a registered delegation profile and own the outcome: pick the environment, write " +
    "a brief that can be answered, supervise the turns, verify the result yourself, then land it (push/PR or a " +
    "world snapshot) and report with evidence. Use when a job needs a real workspace — reading a repository, " +
    "running tests, iterating on code — rather than a few tool calls.",
  spec: {
    type: "skill",
    instructions: DELEGATE_WORK_INSTRUCTIONS,
    files: [{ path: "references/brief.md", content: DELEGATE_WORK_BRIEF_REFERENCE }],
  },
  visibility: "public",
  sharedWith: [],
  tags: ["delegation", "sandbox", "workflow", "example"],
  createdBy: "everdict",
  createdAt: "2026-08-06T00:00:00.000Z",
};

// The first-party CATALOG-only entries — public + adoptable in the store, but absent from the default-enabled set
// (they need per-user config). Merged into listPublic alongside the defaults' records. Containerized MCP servers
// (image transport) live here — never auto-enabled, always explicitly adopted. Self-hosted servers without an official
// image (ClickHouse, Qdrant, Chroma, …) are left for members to self-author via the wizard's container-image transport.
// The skill examples ride along: to a browser they are catalog entries like any other.
export function firstPartyCatalogExtras(): CapabilityRecord[] {
  return [GRAFANA_MCP, PLAYWRIGHT_MCP, POSTGRES_MCP, ...firstPartySkillExamples(), ...firstPartyDelegationExamples()];
}

// The standing brief a delegate reads on start — what this environment is and how the delegator expects to be
// answered. Deliberately about the WORKING RELATIONSHIP, not about any one task: the per-delegation brief
// (goal/references/constraints) arrives separately as BRIEF.md.
const CODE_DELEGATE_INSTRUCTIONS = `
# You are a delegate

Everdict handed you this sandbox to do one piece of work and report back. Everything specific to THIS job is in
\`BRIEF.md\` beside this file — read it first.

## How to work here
- The sandbox is yours: install what you need, run the tests, iterate. Nothing here is shared with anyone.
- Stay inside the brief's constraints. If following them makes the goal impossible, SAY SO instead of working
  around them — the delegator can change the constraints, you cannot.
- Verify before you report. "It should work now" is not a result; the brief's done-criteria are.

## How to report
Answer in the conversation, in this order:
1. **What you changed** — files and the mechanism, not a diff dump.
2. **How you verified it** — the exact command and its outcome. If you could not verify, say what stopped you.
3. **What is still open** — anything you decided not to do, and why.

If the brief's goal turns out to be the wrong goal (the real fault is elsewhere), report THAT and stop. A
delegate that quietly redefines its task is worse than one that comes back with a question.
`.trim();

// A delegation profile is an EXAMPLE, like the skills: the image ref is deployment-specific (a workspace mirrors
// or builds its own agent image), so this exists to be adopted and repointed, never to be silently authoritative.
const CODE_DELEGATE: CapabilityRecord = {
  id: "code-delegate",
  tenant: FIRST_PARTY_TENANT,
  version: "1.0.0",
  name: "code_delegate",
  description:
    "Example delegation profile: a Claude Code environment to hand coding work to — repair a failing case, " +
    "implement a fix, verify it. Adopt it and repoint `image` at your own agent image (and `model` at a " +
    "registered model) before using it.",
  spec: {
    type: "delegation",
    harness: { id: "claude-code" },
    // The deployment's own platform namespace holds everdict's images; a workspace that mirrors its own agent
    // image repoints this on adoption. Left as a plain tag on purpose — an example must be readable.
    image: "everdict-platform/job-runner:latest",
    env: {},
    workDir: "work",
    instructions: CODE_DELEGATE_INSTRUCTIONS,
    instructionsFile: "CLAUDE.md",
    ttlSec: 3600,
  },
  visibility: "public",
  sharedWith: [],
  tags: ["delegation", "claude-code", "example"],
  createdBy: "everdict",
  createdAt: "2026-08-06T00:00:00.000Z",
};

// Delegation profiles ship as store EXAMPLES for the same reason skills do: the environment a workspace
// delegates into is theirs to define (their image, their model, their keys, their house rules), so everdict
// offers a working starting point rather than a default nobody can edit.
export function firstPartyDelegationExamples(): CapabilityRecord[] {
  return [CODE_DELEGATE];
}

// The first-party default TOOLSET, in the order they are offered — the web-reading trio: web search (find;
// unconditional, key-gated) + fetch_url (read a page; unconditional, no key, HITL) + PDF read (read a PDF;
// unconditional, no key, HITL). Tools only, by design: a tool is a capability of the product (nobody edits
// `web_search`), whereas a skill is a document the workspace authors — Everdict's skills are store EXAMPLES
// (firstPartySkillExamples), never silent defaults. All are portable Everdict-authored code capabilities — NOT
// external MCP servers: the store's `mcp` kind + the agent bridge are remote-Streamable-HTTP only, so a
// stdio/self-hosted server (ClickHouse, Playwright, Git, …) can't be a universal first-party default; those are
// user-registered (their own endpoint). Rich integration adapters (Mattermost / GitHub / image-registry) ship as
// control-plane MCP tools (credentials live server-side).
export function firstPartyDefaults(): FirstPartyDefault[] {
  return [WEB_SEARCH, FETCH_URL, PDF_READ];
}
