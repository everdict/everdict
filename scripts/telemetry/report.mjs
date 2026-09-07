#!/usr/bin/env node
// watches: nothing — reads the telemetry ledger and computes statistics; it names no live source symbol.
//
// `pnpm telemetry-report` — the three indicators no file in this repository can answer, answered.
//
// The sink has been collecting since a `SessionStart` hook started it automatically, and the AI-native SDLC
// audit's next finding was the obvious one: 1,065 payloads had accumulated and NOTHING QUERIED THEM. A
// measurement nobody can produce is not instrumented — the article's own test is that someone who did not
// build the harness can get the number in one command from a named source, in under five minutes. This is
// that command.
//
// What it answers, and which play each belongs to:
//   · concurrent sessions per engineer   (p08 parallel sessions — the article ties the ceiling to review capacity)
//   · steering time against waiting time (p08 — active_time.total against the session's own wall clock)
//   · tool decisions allowed and denied  (p04 auto mode / p07 build-time guardrails)
//
// ⚠️ IT REFUSES AN EMPTY LEDGER. A report over no payloads reads exactly like a quiet week, and this
// repository's own rule — an empty corpus is not a pass — applies to a reader as much as to a scanner.
//
// ⚠️ AND IT PRINTS NO IDENTITY. The payloads carry `user.email`, `user.id`, `user.account_uuid` and an
// organization id, because the exporter puts them there. This is a public repository; the three indicators
// need none of it, so nothing here reads those keys and the session id is truncated. What is counted is
// sessions, seconds and decisions.
//
// `--json` emits one object for a control band to read. Plain output is for a person.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNOWN = new Set(["--json", "--since", "--source"]);
const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) {
    console.error(`✖ telemetry-report: unknown option "${argv[i]}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  if (argv[i] === "--json") {
    opts.json = true;
    continue;
  }
  const value = argv[++i];
  if (value === undefined) {
    console.error(`✖ telemetry-report: ${argv[i - 1]} needs a value.`);
    process.exit(1);
  }
  opts[argv[i - 1].slice(2)] = value;
}

// The ledger lives in the COMMON git directory, beside the other ledgers and shared by every worktree.
const commonDir = (() => {
  try {
    const p = path.join(root, ".git");
    return existsSync(p) ? p : root;
  } catch {
    return root;
  }
})();
const LEDGER = opts.source ?? path.join(commonDir, "everdict-telemetry.jsonl");

if (!existsSync(LEDGER)) {
  console.error(
    `✖ telemetry-report: ${path.relative(root, LEDGER)} does not exist. Nothing has been collected — start a session (the SessionStart hook brings the sink up) or run \`pnpm telemetry\`.\n  An absent ledger is not a quiet week, and this refuses to report over it.`,
  );
  process.exit(1);
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────────
// A line that will not parse is COUNTED, never skipped silently: the sink records an undecodable payload on
// purpose (it is a fact about the exporter), and a reader that drops them reports over a corpus it edited.
let lines;
try {
  lines = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean);
} catch (err) {
  console.error(`✖ telemetry-report: could not read ${path.relative(root, LEDGER)} — ${err.message}.`);
  process.exit(1);
}
const since = opts.since ? Date.parse(opts.since) : undefined;
if (opts.since && Number.isNaN(since)) {
  console.error(`✖ telemetry-report: --since "${opts.since}" is not a date.`);
  process.exit(1);
}

const attrsOf = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, Object.values(a.value ?? {})[0]]));
/** @type {Map<string, {first:number,last:number,active:number,cost:number,tokens:number,decisions:Map<string,number>,tools:Map<string,number>,commits:number,lines:number}>} */
const sessions = new Map();
const touch = (id) => {
  if (!sessions.has(id))
    sessions.set(id, {
      first: Number.POSITIVE_INFINITY,
      last: 0,
      active: 0,
      cost: 0,
      tokens: 0,
      decisions: new Map(),
      tools: new Map(),
      commits: 0,
      lines: 0,
    });
  return sessions.get(id);
};
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

let payloads = 0;
let undecodable = 0;
let skippedByWindow = 0;
for (const line of lines) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    undecodable++;
    continue;
  }
  const at = Date.parse(row.at ?? "");
  if (since !== undefined && Number.isFinite(at) && at < since) {
    skippedByWindow++;
    continue;
  }
  payloads++;
  const p = row.payload ?? {};
  if (p.undecodable !== undefined) undecodable++;

  for (const rm of p.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
        for (const dp of points) {
          const a = attrsOf(dp.attributes);
          const id = a["session.id"];
          if (id === undefined) continue;
          const s = touch(id);
          const value = Number(dp.asDouble ?? dp.asInt ?? 0);
          const t = Number(dp.timeUnixNano ?? 0) / 1e6;
          if (Number.isFinite(t) && t > 0) {
            s.first = Math.min(s.first, t);
            s.last = Math.max(s.last, t);
          }
          // Monotonic cumulative sums: the LAST value is the total, not the sum of the points.
          if (m.name === "claude_code.active_time.total") s.active = Math.max(s.active, value);
          else if (m.name === "claude_code.cost.usage") s.cost = Math.max(s.cost, value);
          else if (m.name === "claude_code.token.usage") s.tokens += value;
          else if (m.name === "claude_code.commit.count") s.commits = Math.max(s.commits, value);
          else if (m.name === "claude_code.lines_of_code.count") s.lines += value;
        }
      }
    }
  }
  for (const rl of p.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const a = attrsOf(lr.attributes);
        const id = a["session.id"];
        if (id === undefined) continue;
        const s = touch(id);
        const t = Number(lr.timeUnixNano ?? 0) / 1e6;
        if (Number.isFinite(t) && t > 0) {
          s.first = Math.min(s.first, t);
          s.last = Math.max(s.last, t);
        }
        if (a["event.name"] === "tool_decision") {
          bump(s.decisions, `${a.decision ?? "?"}:${a.source ?? "?"}`);
          bump(s.tools, String(a.tool_name ?? "?"));
        }
      }
    }
  }
}

if (payloads === 0) {
  console.error(
    `✖ telemetry-report: ${lines.length} line(s) in the ledger and none in scope${opts.since ? ` since ${opts.since}` : ""}. Refusing to report over an empty corpus — a report over nothing reads exactly like a quiet week.`,
  );
  process.exit(1);
}
if (sessions.size === 0) {
  console.error(
    `✖ telemetry-report: ${payloads} payload(s) carried no session.id, so nothing can be attributed. Check that OTEL_METRICS_INCLUDE_SESSION_ID is not disabled.`,
  );
  process.exit(1);
}

// ── concurrency: how many sessions were live at the same time ────────────────────────────────────
// A session is "live" between its first and last observed signal. The article ties the parallel-session
// ceiling to review capacity, so what matters is the PEAK overlap, not the total count.
const spans = [...sessions.entries()]
  .filter(([, s]) => Number.isFinite(s.first) && s.last > 0)
  .map(([id, s]) => ({ id, from: s.first, to: Math.max(s.last, s.first) }));
const edges = spans.flatMap((s) => [
  { t: s.from, d: 1 },
  { t: s.to, d: -1 },
]);
edges.sort((a, b) => a.t - b.t || a.d - b.d);
let live = 0;
let peak = 0;
let peakAt = 0;
for (const e of edges) {
  live += e.d;
  if (live > peak) {
    peak = live;
    peakAt = e.t;
  }
}

const totals = [...sessions.values()].reduce(
  (acc, s) => {
    acc.active += s.active;
    acc.cost += s.cost;
    acc.tokens += s.tokens;
    acc.commits += s.commits;
    acc.lines += s.lines;
    acc.wall += Number.isFinite(s.first) && s.last > s.first ? (s.last - s.first) / 1000 : 0;
    for (const [k, v] of s.decisions) acc.decisions.set(k, (acc.decisions.get(k) ?? 0) + v);
    for (const [k, v] of s.tools) acc.tools.set(k, (acc.tools.get(k) ?? 0) + v);
    return acc;
  },
  { active: 0, cost: 0, tokens: 0, commits: 0, lines: 0, wall: 0, decisions: new Map(), tools: new Map() },
);
const accepted = [...totals.decisions].filter(([k]) => k.startsWith("accept")).reduce((a, [, v]) => a + v, 0);
const denied = [...totals.decisions].filter(([k]) => !k.startsWith("accept")).reduce((a, [, v]) => a + v, 0);
// Steering vs waiting: active seconds over the wall clock the sessions actually spanned.
const steering = totals.wall > 0 ? totals.active / totals.wall : 0;

if (opts.json) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      payloads,
      undecodable,
      sessions: sessions.size,
      peakConcurrent: peak,
      activeSeconds: Math.round(totals.active),
      wallSeconds: Math.round(totals.wall),
      steeringShare: Number(steering.toFixed(4)),
      toolDecisions: { accepted, denied },
      costUsd: Number(totals.cost.toFixed(4)),
      tokens: totals.tokens,
      commits: totals.commits,
      linesOfCode: totals.lines,
    }),
  );
  process.exit(0);
}

const hhmm = (s) => `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
console.log(
  `▶ telemetry · ${payloads} payload(s) · ${sessions.size} session(s)${opts.since ? ` since ${opts.since}` : ""}`,
);
console.log(`  ledger: ${path.relative(root, LEDGER)}${undecodable > 0 ? ` · ${undecodable} undecodable` : ""}`);
console.log("");
console.log("  p08  concurrent sessions");
console.log(
  `         peak ${peak} live at once${peakAt > 0 ? ` (${new Date(peakAt).toISOString().slice(0, 16)}Z)` : ""}`,
);
console.log(
  "         the stated ceiling is THREE, tied to review capacity — docs/architecture/harness-observability.md",
);
console.log("");
console.log("  p08  steering vs waiting");
console.log(
  `         ${hhmm(totals.active)} active over ${hhmm(totals.wall)} wall · ${(steering * 100).toFixed(1)}% steering`,
);
console.log("");
console.log("  p04/p07  tool decisions");
console.log(`         ${accepted} accepted · ${denied} denied`);
for (const [k, v] of [...totals.decisions].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
  console.log(`         ${String(v).padStart(5)}  ${k}`);
}
if (denied === 0) {
  console.log("         ⚠️  ZERO denials here does NOT mean nothing is guarded. The push gate records its own");
  console.log("             refusals in .git/everdict-gate-log.jsonl (grouped by arm) because a control's");
  console.log("             refusals are evidence about that control; this stream only sees the tool layer.");
}
console.log("");
console.log("  cost and output");
console.log(
  `         $${totals.cost.toFixed(2)} · ${totals.tokens.toLocaleString()} tokens · ${totals.commits} commit(s) · ${totals.lines} line(s) of code`,
);
console.log("");
console.log("· no identity is printed: the payloads carry an email, a user id and an organization id, and none");
console.log("  of the three indicators needs them. See scripts/telemetry/README.md.");
