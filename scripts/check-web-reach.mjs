#!/usr/bin/env node
// ── A ROUTE THE WEB CANNOT OPEN IS EITHER A GAP OR A DECISION, NEVER A SILENCE ──────────────────────
//
// `apps/web` is a pure HTTP client of the control plane, so every capability the runtime grows is one the
// web has to be taught separately — and nothing enforced that. No gate asked whether a route had a caller,
// so a door nobody opens looked exactly like a door nobody needed, and the drift only ever ran one way.
// A census found 36 unreachable routes and, worse, that seven of them were never meant for a browser at
// all: an unbuilt page and a deliberate agent-only surface are indistinguishable in a count.
//
// So this does not demand a caller. It demands an ANSWER: every route is reachable from
// `apps/web/src/shared/lib/control-plane.ts`, or it is listed below with the reason it is not. The list is
// the census's slice-0 decision, and adding a route now forces the same decision rather than deferring it
// to whoever next runs the count by hand. docs/architecture/web-runtime-gap-census-spec.md
//
// Run: node scripts/check-web-reach.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLIENT = "apps/web/src/shared/lib/control-plane.ts";

// Surfaces whose caller is not a browser. A prefix, because these are whole doors rather than one route.
const NOT_A_BROWSER_SURFACE = [
  ["/internal", "control-plane↔agent-service bridges, x-internal-token"],
  ["/runner", "the self-hosted runner's lease loop"],
  ["/runners", "the self-hosted runner's lease loop"],
  ["/mcp", "the agent transport itself"],
  ["/oauth", "the OAuth endpoints a client redirects to"],
  ["/.well-known", "discovery documents"],
  ["/v1", "the OTLP ingest door"],
  ["/health", "liveness"],
  ["/ready", "readiness"],
  ["/metrics", "a Prometheus scrape endpoint"],
  ["/install.sh", "the installer script"],
  ["/frontdoor-callback", "an external redirect target"],
  ["/agent-runtime", "the agent runtime's own surface"],
];

// The slice-0 decision, route by route. `build` entries are gaps somebody owes a surface; everything here
// is the OTHER answer — the caller is not a person, and saying so is the work a count cannot do.
const DECIDED = new Map([
  // ── NOT A BROWSER'S DOOR ──────────────────────────────────────────────────────────────────────────
  ["/workspace/github-app/callback", "GitHub redirects the browser here and the server handles it"],
  ["/workspace/mattermost/messages", "outbound notification send; the platform calls it"],
  ["/bundles/apply", "one-shot register for the CLI/GitOps"],
  ["/scorecards/backfill-models", "an operator maintenance sweep over historical records"],
  ["/agents/validate", "reached through the craft form's own submit path, not as a door of its own"],
  ["/scorecards/query", "the client engine answers it; both are held to fixtures/analysis-parity.json"],
  ["/v2/token", "the Docker Registry v2 token endpoint — the docker client's auth realm"],
  ["/integrations/mattermost/action", "Mattermost posts here when someone clicks a message button"],
  ["/integrations/mattermost/command", "a Mattermost slash command's webhook"],
  ["/workspace/metrics", "a Prometheus scrape endpoint"],
  ["/workspace/image-registries/manifest", "a registry manifest read by an image client"],
  ["/workspace/image-registries/push-credentials", "push credentials minted for `everdict image push`, not a page"],
  ["/ops/driver/:p/:p", "operator driver inspection — a runbook, not a page"],
  ["/ops/driver/:p/:p/cancel", "operator driver control — a runbook"],
  ["/ops/driver/:p/:p/terminate", "operator driver control — a runbook"],
  ["/runs/:p/live/stream", "an SSE stream the run page opens directly, not through the shared client"],
  ["/runs/:p/logs/stream", "an SSE stream the run page opens directly, not through the shared client"],

  // ── OWED — a real gap with a person behind it ─────────────────────────────────────────────────────
  //
  // Named rather than merely absent, so the debt is visible and this check can be green today without
  // pretending it is decided. Removing a line is the definition of done for that surface.
  ["/knowledge/annotate", "OWED — knowledge authoring"],
  ["/knowledge/annotations", "OWED — knowledge authoring"],
  ["/knowledge/context", "OWED — knowledge authoring"],
  ["/knowledge/extract", "OWED — knowledge authoring"],
  ["/knowledge/node", "OWED — knowledge authoring"],
  ["/knowledge/relate", "OWED — knowledge authoring"],
  ["/knowledge/related", "OWED — knowledge authoring"],
  ["/knowledge/subgraph", "OWED — knowledge authoring"],
  ["/campaigns", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/adopt", "OWED — an adoption gate a person should decide"],
  ["/campaigns/:p/builds", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/merge", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/settle", "OWED — a settle a person should decide"],
  ["/campaigns/:p/adoption", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/brief", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/build-sets", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/decision", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/rounds", "OWED — the evolution domain has no web surface"],
  ["/campaigns/:p/rounds/:p/evidence", "OWED — the evolution domain has no web surface"],
  ["/groups", "OWED — the two-phase experiment has no surface"],
  ["/groups/:p", "OWED — the two-phase experiment has no surface"],
  ["/groups/:p/score", "OWED — the two-phase experiment has no surface"],
  ["/checkpoints", "OWED — agent handoff evidence, read by people"],
  ["/checkpoints/:p", "OWED — agent handoff evidence, read by people"],
  ["/checkpoints/:p/verify", "OWED — agent handoff evidence, read by people"],
  ["/fs", "OWED — the files page"],
  ["/fs/revisions", "OWED — the files page's revision history"],
  ["/fs/search", "OWED — the files page cannot search"],
  ["/fs/usage", "OWED — the files page cannot say what it costs"],
  ["/environments", "OWED — the environment REGISTRY (settings has image adoption, a different noun)"],
  ["/environments/:p/versions/:p", "OWED — the environment registry"],
  ["/environments/:p/versions/:p/tags", "OWED — the environment registry"],
  ["/harnesses/:p/delegate", "OWED — harness delegation"],
  ["/harnesses/:p/lineage", "OWED — harness lineage"],
  ["/harnesses/:p/pins", "OWED — harness re-pin"],
  ["/harnesses/:p/span-attr-mapping", "OWED — trace span mapping"],
  ["/judges/:p/versions/:p/tags", "OWED — judge version tags"],
  ["/benchmarks/:p/judge", "OWED — benchmark import"],
  ["/datasets/:p/versions/:p/attest", "OWED — ground-truth attestation"],
  ["/products/:p/versions", "OWED — the product version ledger"],
  ["/runs/:p/cancel", "OWED — stopping a run from its own page"],
  ["/sandboxes/:p/git/push", "OWED — the sandbox surface"],
  ["/sandboxes/:p/snapshot", "OWED — the sandbox surface"],
  ["/sandboxes/:p/tasks/:p/trace", "OWED — the sandbox surface"],
  ["/sandboxes/:p/touch", "OWED — the sandbox surface"],
  ["/scorecards/:p/gate/override", "OWED — overriding a blocked gate"],
  ["/scorecards/:p/report", "OWED — the citable report"],
  ["/scorecards/:p/verify-manifest", "OWED — manifest verification"],
  ["/scorecards/estimate", "OWED — submit-time cost estimate"],
  ["/skills/:p/verify", "OWED — skill verification"],
  ["/scorecards/gate", "OWED — the CI gate decision"],
  ["/workspace/images/mirror", "OWED — a real user action on the managed image store"],
  ["/workspace/images/push-grant", "OWED — the push credential a member mints for `everdict image push`"],
  ["/workspace/trace-ingestion", "OWED — the OTLP door's quota/retention, with no settings page"],
  ["/workspace/trace-thresholds", "OWED — perception config evaluated at seal time"],
]);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (entry.endsWith(".ts")) out.push(rel);
  }
  return out;
};

// A route's declaration, normalized to one parameter spelling. Anything else compares two spellings.
// A trailing `${…}` that BUILDS A QUERY STRING is not a path segment. It cannot be matched with a regex,
// because the group nests: `/knowledge/graph${depth !== undefined ? `?depth=${depth}` : ""}`. So the tail is
// found by balancing braces, and dropped when its text contains a `?` or names a query variable.
const stripTrailingQuery = (path) => {
  if (!path.endsWith("}")) return path;
  let depth = 0;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path[i] === "}") depth++;
    else if (path[i] === "{") {
      depth--;
      if (depth === 0) {
        if (path[i - 1] !== "$") return path;
        const inner = path.slice(i + 1, -1);
        return /\?|^\s*(qs|query|search|params)\s*$/.test(inner) ? path.slice(0, i - 1) : path;
      }
    }
  }
  return path;
};

const normalize = (path) =>
  stripTrailingQuery(path)
    .replace(/\$\{[^{}]*\}/g, ":p")
    .replace(/\$\{[\s\S]*?\}/g, ":p") // a nested group left over — collapse it too
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":p")
    .split("?")[0]
    .replace(/\/$/, "");

const routes = new Set();
for (const file of walk("apps/api/src")) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)[^(]*\(\s*"([^"]+)"/g)) {
    // A ROUTE PATH STARTS WITH "/". `app.getDefaultJsonParser("error", "error")` matches the method regex
    // and is not a route — a scanner that invents a door teaches people to skip its output.
    if (!m[2].startsWith("/")) continue;
    routes.add(normalize(m[2]));
  }
}
// A corpus that came back empty would make this check pass over a repository it never read.
if (routes.size === 0) {
  console.error("web reach check FAILED — no routes found in apps/api; the extraction is broken, not the web.");
  process.exit(1);
}

// ── READING A PATH OUT OF A TEMPLATE LITERAL, INCLUDING THE NESTED ONES ────────────────────────────
//
// A naive `/[`'"](\/[^`'"]*)[`'"]/` stops at the FIRST backtick, and this client is full of
//
//     `/runs/${encodeURIComponent(id)}/trajectory${suffix ? `?${suffix}` : ''}`
//
// where that backtick is the NESTED template inside `${…}`. The path came back truncated, so a route the
// web calls on every run page reported as unreachable. That is the third time this exact class of
// extraction error has produced a false census (the first two are recorded in the spec), which is why the
// scan tracks `${}` depth instead of matching a character class.
const pathsIn = (source) => {
  const found = [];
  for (let i = 0; i < source.length; i++) {
    const quote = source[i];
    if (quote !== "`" && quote !== "'" && quote !== '"') continue;
    if (source[i + 1] !== "/") continue;
    let depth = 0;
    let j = i + 1;
    for (; j < source.length; j++) {
      const c = source[j];
      if (c === "\n") break; // a path literal does not span lines
      if (quote === "`" && c === "$" && source[j + 1] === "{") {
        depth++;
        j++;
        continue;
      }
      if (depth > 0) {
        if (c === "{") depth++;
        else if (c === "}") depth--;
        continue; // inside ${…}: a backtick here is the nested template's, not this literal's end
      }
      if (c === quote) break;
    }
    if (j < source.length && source[j] === quote) found.push(source.slice(i + 1, j));
    i = j;
  }
  return found;
};

const client = readFileSync(join(ROOT, CLIENT), "utf8");
const reachable = new Set();
for (const path of pathsIn(client)) reachable.add(normalize(path));

const failures = [];
const unusedDecisions = new Set(DECIDED.keys());
for (const route of [...routes].sort()) {
  if (NOT_A_BROWSER_SURFACE.some(([prefix]) => route === prefix || route.startsWith(`${prefix}/`))) continue;
  if (reachable.has(route)) {
    // A route the web now reaches must LEAVE the decision list — a reason that outlived its subject reads
    // as permission for a door somebody already opened.
    if (DECIDED.has(route))
      failures.push(
        `${route} is reachable from the web now — drop its line from DECIDED (it says: ${DECIDED.get(route)})`,
      );
    unusedDecisions.delete(route);
    continue;
  }
  if (DECIDED.has(route)) {
    unusedDecisions.delete(route);
    continue;
  }
  failures.push(
    `${route} has no caller in ${CLIENT} — build the surface, or add it to DECIDED with the reason a person does not need it`,
  );
}
for (const stale of unusedDecisions)
  failures.push(`${stale} is in DECIDED and is not a route any more — drop the line`);

if (failures.length) {
  console.error(`web reach check FAILED — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nSee docs/architecture/web-runtime-gap-census-spec.md for what this gate is protecting.");
  process.exit(1);
}
const owed = [...DECIDED.values()].filter((r) => r.startsWith("OWED")).length;
console.log(
  `web reach OK — ${routes.size} routes, every browser-facing one reachable from the web or decided ` +
    `(${DECIDED.size} decided, of which ${owed} are OWED surfaces with a named debt).`,
);
