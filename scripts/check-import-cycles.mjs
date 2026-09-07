#!/usr/bin/env node
// ── A CYCLE IS TOLERATED ONLY WHILE EVERY USE IS DEFERRED (arch-review 84) ──────────────────────────
//
// The symmetric completion join needs one predicate and one fact shared by two writers, and putting either
// of them inside one of the writers made the two modules import each other. ESM permits that exactly as long
// as every use happens at CALL time; move one to module scope — a `const` derived at import, a decorator, a
// registry populated on load — and one side sees a half-initialized namespace. The failure is a runtime
// `undefined` in a module that type-checks, and nothing in this repository looked for it.
//
// A RATCHET, not a sweep. Sixteen cycles predate this check and each one is somebody's untangling to do; a
// gate that failed on all of them would be turned off in a week. What it forbids is a NEW one — which is the
// only kind anybody is in a position to fix while they still remember why the import went in.
//
// The fix is almost always the same shape: the value both sides need belongs to neither of them. Give it its
// own module that imports from neither, and the cycle disappears along with the question of which writer
// "owns" the shared thing.
// watches: nothing — walks the module graph.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE = `${ROOT}/scripts/import-cycles-baseline.txt`;

// One entry per package root madge is run over. Adding a root is a widening, and a widening that finds new
// cycles is the point.
const ROOTS = [
  "packages/contracts/src",
  "packages/domain/src",
  "packages/application-control/src",
  "packages/db/src",
  "packages/registry/src",
  "packages/backends/src",
  "apps/api/src",
];

function cyclesIn(root) {
  // madge prints `1) a.ts > b.ts` per cycle; anything else (headers, the "no circular" line) is noise.
  // ⚠️ madge EXITS 1 when it finds cycles, which is its whole job — so a plain `execFileSync` throws on the
  // only interesting case and this check would have passed exactly when there was nothing to report. Caught
  // by driving it against a tree that HAS cycles rather than by reading the code.
  let out;
  try {
    out = execFileSync("npx", ["madge", "--circular", "--extensions", "ts", root], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const failed = err;
    if (typeof failed?.stdout !== "string") throw err; // madge itself broke — not a cycle report
    out = failed.stdout;
  }
  return out
    .split("\n")
    .filter((line) => /^\s*\d+\)/.test(line))
    .map((line) => `${root} :: ${line.replace(/^\s*\d+\)\s*/, "").trim()}`);
}

const found = ROOTS.flatMap(cyclesIn).sort();

if (process.argv.includes("--write")) {
  writeFileSync(BASELINE, `${found.join("\n")}\n`);
  console.log(`wrote ${found.length} baselined cycles`);
  process.exit(0);
}

const baseline = readFileSync(BASELINE, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "");
const known = new Set(baseline);
const added = found.filter((c) => !known.has(c));
// A baselined cycle that is GONE must leave the list in the same change — a debt marked paid nowhere reads
// as permission for the next one (the same discipline `language-policy` uses).
const foundSet = new Set(found);
const stale = baseline.filter((c) => !foundSet.has(c));

if (added.length > 0 || stale.length > 0) {
  if (added.length > 0) {
    console.error("✖ new import cycle(s):\n");
    for (const c of added) console.error(`  ${c}`);
    console.error(
      "\n  A cycle survives only while every use is deferred to call time; one module-scope use and one side",
    );
    console.error("  sees a half-initialized namespace. The value both sides need usually belongs to neither —");
    console.error("  give it its own module that imports from neither.");
  }
  if (stale.length > 0) {
    console.error("\n✖ baselined cycle(s) that no longer exist — remove them from the baseline:\n");
    for (const c of stale) console.error(`  ${c}`);
  }
  process.exit(1);
}
console.log(`PASS import cycles: ${found.length} baselined across ${ROOTS.length} roots, none new.`);
