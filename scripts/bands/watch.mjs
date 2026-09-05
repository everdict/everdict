#!/usr/bin/env node
// watches: nothing — reads ledgers and computes statistics; it names no live symbol.
//
// `pnpm watch-bands` — the only thing in this repository that starts work without a person deciding to.
//
// Five stages of this harness refuse things. The sixth was never made to NOTICE, so every `intent.md` here
// existed because a human wrote one, and the chain ran forward from a person and never returned to the queue
// on its own. The materials were already accumulating — `evals/history.jsonl` and `.git/everdict-gate-log.jsonl`
// are exactly the shape a control band reads — and nothing read them.
//
// ⚠️ DETECTION IS DETERMINISTIC. Rolling mean and standard deviation over a versioned window, tiers in a
// versioned config. A model anywhere in the detection path makes the alarm itself unreproducible. The model is
// invoked at 2σ to DIAGNOSE, read-only, and never to decide that something is wrong.
//
// ⚠️ TOO FEW SAMPLES IS NOT "NO BREACH". Under a metric's floor the watcher reports INSUFFICIENT and writes
// nothing. A band over three points is noise wearing a sigma, and the first thing it would do is file an
// intent nobody believes — the same rule the trust suite applies to a scenario that skips.
//
// The 3σ tier may only PROPOSE: it writes `intent/<date>-<slug>/intent.md` and has no route to the code.
// `pnpm intent-chain` then applies to that file exactly as it does to a human's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = path.join(root, "scripts", "bands", "bands.yaml");

const KNOWN = new Set(["--dry-run", "--only", "--source-dir"]);
const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) {
    console.error(`✖ watch-bands: unknown option "${argv[i]}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  if (argv[i] === "--dry-run") {
    opts.dryRun = true;
    continue;
  }
  const value = argv[++i];
  if (value === undefined) {
    console.error(`✖ watch-bands: ${argv[i - 1]} needs a value.`);
    process.exit(1);
  }
  opts[argv[i - 1].slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
}

// ── the config, parsed without a dependency ──────────────────────────────────────────────────────
// A small hand-rolled reader for the one shape this file uses. It refuses anything it does not understand
// rather than guessing, because a silently misread threshold is the failure mode a versioned config exists to
// prevent.
const parseConfig = (text) => {
  const metrics = [];
  let inMetrics = false;
  let current = null;
  let folding;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (/^metrics:/.test(line)) {
      inMetrics = true;
      continue;
    }
    if (!inMetrics) continue;
    if (/^\s{2}-\s/.test(line)) {
      if (current) metrics.push(current);
      current = {};
    }
    const kv = /^\s*(?:-\s*)?([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (kv && current) {
      const [, key, value] = kv;
      // ⚠️ A folded block used to be SKIPPED, so `why` was always undefined and every diagnosis prompt and
      // filed intent rendered an empty string where the metric's reason belongs. Editing the prose in
      // bands.yaml had no effect on anything, which is the quietest way for a config field to be decorative.
      if (value === ">" || value === "") {
        folding = key;
        continue;
      }
      folding = undefined;
      current[key] = /^\d+$/.test(value) ? Number(value) : value;
      continue;
    }
    // A continuation line of the folded block above: deeper-indented prose, joined into one sentence.
    if (folding !== undefined && current && /^\s{4,}\S/.test(line)) {
      current[folding] = `${current[folding] ?? ""}${current[folding] ? " " : ""}${line.trim()}`;
    }
  }
  if (current) metrics.push(current);
  return metrics.filter((m) => m.id !== undefined);
};

if (!existsSync(CONFIG)) {
  console.error(`✖ watch-bands: ${path.relative(root, CONFIG)} is missing — there are no bands to apply.`);
  process.exit(1);
}
const metrics = parseConfig(readFileSync(CONFIG, "utf8"));
if (metrics.length === 0) {
  console.error("✖ watch-bands: the config declares no metrics. Refusing to report over an empty set.");
  process.exit(1);
}

// ── the series ───────────────────────────────────────────────────────────────────────────────────
const gitDir = opts.sourceDir ?? path.join(root, ".git");
const readJsonl = (file) => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return null; // could not read is not the same as empty, and the caller says which it got
  }
};

const SERIES = {
  "evals-history": () => {
    const rows = readJsonl(path.join(root, "evals", "history.jsonl"));
    if (rows === null) return null;
    return rows.filter((r) => r.partial !== true && r.of > 0).map((r) => r.passed / r.of);
  },
  "gate-log": () => {
    const rows = readJsonl(path.join(gitDir, "everdict-gate-log.jsonl"));
    if (rows === null) return null;
    // A rate needs a denominator, so the series is a moving verdict, not a count: 1 for a deny, 0 for an
    // allow. Mean over the window is the rate, which is what the band is about.
    return rows.map((r) => (r.verdict === "deny" ? 1 : 0));
  },
  "scan-log": () => {
    const rows = readJsonl(path.join(gitDir, "everdict-scan-log.jsonl"));
    if (rows === null) return null;
    // An unstructured reading has no countable total; `findings: null` is not zero, and averaging a guess into
    // the series is worse than a gap in it.
    return rows.filter((r) => r.structured !== false && typeof r.findings === "number").map((r) => r.findings);
  },
  "review-reports": () => {
    let files;
    try {
      files = readdirSync(gitDir).filter((f) => /^everdict-review-[0-9a-f]{12}\.json$/.test(f));
    } catch {
      return null;
    }
    return files
      .map((f) => {
        try {
          const doc = JSON.parse(readFileSync(path.join(gitDir, f), "utf8"));
          return (doc.findings ?? []).filter((x) => x.severity === "important").length;
        } catch {
          return null;
        }
      })
      .filter((n) => n !== null);
  },
};

const stats = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, sd: Math.sqrt(variance) };
};

// ── band each metric ─────────────────────────────────────────────────────────────────────────────
const selected = opts.only ? metrics.filter((m) => m.id === opts.only) : metrics;
if (selected.length === 0) {
  console.error(`✖ watch-bands: --only "${opts.only}" matched no metric.`);
  process.exit(1);
}

const breaches = [];
for (const metric of selected) {
  const read = SERIES[metric.source];
  if (read === undefined) {
    console.error(`✖ watch-bands: metric ${metric.id} names source "${metric.source}", which has no reader.`);
    process.exit(1);
  }
  const all = read();
  if (all === null) {
    // Cannot find out is an escalation, never a terminal state — but it is also not a breach, and saying so
    // is the whole point of keeping the two apart.
    console.log(`? ${metric.id.padEnd(24)} UNREADABLE — ${metric.source} could not be read. Nothing was banded.`);
    continue;
  }
  const series = all.slice(-metric.window);
  if (series.length < metric.floor) {
    console.log(`· ${metric.id.padEnd(24)} INSUFFICIENT — ${series.length}/${metric.floor} samples. No band computed.`);
    continue;
  }
  const history = series.slice(0, -1);
  const latest = series.at(-1);
  const { mean, sd } = stats(history);
  if (sd === 0) {
    console.log(
      `· ${metric.id.padEnd(24)} FLAT — ${history.length} identical samples; a sigma over zero variance says nothing.`,
    );
    continue;
  }
  const z = (latest - mean) / sd;
  const signed = metric.direction === "down" ? -z : z;
  const tier = signed >= 3 ? 3 : signed >= 2 ? 2 : signed >= 1 ? 1 : 0;
  const line = `${metric.id.padEnd(24)} latest ${latest.toFixed(3)} · mean ${mean.toFixed(3)} · sd ${sd.toFixed(3)} · ${signed.toFixed(2)}σ ${metric.direction}`;
  if (tier === 0) {
    console.log(`✓ ${line}`);
    continue;
  }
  console.log(`${tier >= 3 ? "‼" : tier === 2 ? "!" : "·"} ${line} → ${tier}σ`);
  breaches.push({ metric, tier, latest, mean, sd, signed, samples: series.length });
}

// ── act, by tier ─────────────────────────────────────────────────────────────────────────────────
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const today = new Date().toISOString().slice(0, 10);

for (const breach of breaches) {
  if (breach.tier === 1) continue; // logged above, which is the whole of the 1σ tier

  if (breach.tier === 2) {
    if (opts.dryRun) {
      console.log(`  (dry run) 2σ would open a read-only diagnosis of ${breach.metric.id}`);
      continue;
    }
    const res = spawnSync(
      "claude",
      [
        "-p",
        `The control band on "${breach.metric.id}" is at ${breach.signed.toFixed(2)} sigma (latest ${breach.latest}, mean ${breach.mean.toFixed(3)}). ${breach.metric.why ?? ""} Diagnose read-only: what in this repository most likely explains it, and what evidence would confirm or refute that? Do not propose a fix.`,
        "--output-format",
        "json",
        "--model",
        "sonnet",
        "--disallowedTools",
        "Edit,Write,Bash,Task,WebFetch,WebSearch",
        "--allowedTools",
        "Read,Grep,Glob",
      ],
      { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (res.status === 0) {
      try {
        console.log(`\n  2σ diagnosis of ${breach.metric.id}:\n${JSON.parse(res.stdout).result}\n`);
      } catch {
        console.log(`  2σ diagnosis of ${breach.metric.id}: (unparseable envelope)`);
      }
    } else {
      console.log(`  2σ diagnosis of ${breach.metric.id} could not run (claude exited ${res.status}).`);
    }
    continue;
  }

  // 3σ — propose, and only into the queue.
  const dir = path.join(root, "intent", `${today}-band-${slug(breach.metric.id)}`);
  if (existsSync(dir)) {
    console.log(
      `  3σ ${breach.metric.id}: an intent for this breach is already open at ${path.relative(root, dir)} — not filing a second.`,
    );
    continue;
  }
  if (opts.dryRun) {
    console.log(`  (dry run) 3σ would file ${path.relative(root, dir)}/intent.md`);
    continue;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "intent.md"),
    `# Intent: ${breach.metric.id} breached its control band at ${breach.signed.toFixed(2)}σ

Author: watch-bands (detection script). Status: draft

## Problem

\`${breach.metric.id}\` is ${breach.signed.toFixed(2)} standard deviations ${breach.metric.direction} from its
own recent behaviour. Latest ${breach.latest}, mean ${breach.mean.toFixed(3)}, sd ${breach.sd.toFixed(3)} over
${breach.samples} sample(s) (window ${breach.metric.window}, floor ${breach.metric.floor}).

${breach.metric.why ?? ""}

## Proposed outcome

Either the cause is found and fixed, or the band is wrong and is retuned in \`scripts/bands/bands.yaml\` with
the reason. Dismissing without one of those two leaves the next breach unreadable.

## Affected users and systems

Whatever produces \`${breach.metric.source}\`. The evidence is in that ledger.

## Constraints

This file was written by a detection script with no route to the code. It proposes; a person triages. It has
not diagnosed anything and its confidence is exactly zero.

## Open questions

- Is this a real change in the thing measured, or a change in how it is measured?
- Has the band ever been calibrated against a breach that turned out to be real?
`,
  );
  console.log(`  3σ ${breach.metric.id}: filed ${path.relative(root, dir)}/intent.md into the queue`);
}

if (breaches.length === 0) console.log("\nNo band breached.");
