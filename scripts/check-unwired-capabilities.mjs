#!/usr/bin/env node
// ── AN OPTIONAL DEPENDENCY WITH NO PRODUCER IS A PLAN — CHECKED (arch-review 67) ────────────────────
//
// Written in rule `protocol` after arch-review 64, and broken by its own author two waves later:
// `IntermediateCleanupStore` was introduced with a port, an in-memory implementation, application helpers
// and five counterexamples that pass one in — and no composition root anywhere constructs it. Every
// production private-verifier case therefore recorded no cleanup debt and its settlement discharged
// nothing, exactly the leak the ledger was built to close.
//
// The prose law did not bind because the defect is INVISIBLE AT THE CALL SITE: `deps.cleanup?.owe(...)`
// reads identically whether this deployment declined the capability or no code on earth supplies it. That
// is the same reason `noUnusedLocals` had to be turned on for the value-never-received class — a law whose
// application depends on remembering is a law that has already failed once.
//
// So: every port that some deps type accepts OPTIONALLY must be constructed somewhere in a composition
// root, or be listed here with the reason it is not. "Constructed" means a `new Impl(` in apps/*/src — the
// place a deployment is assembled — because that is the thing whose absence nobody can see from the
// consumer.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

// Ports whose absence from every composition root is DELIBERATE, each with the reason. An entry here is a
// statement that the capability is inert on purpose — not a place to park an unfinished wiring job.
const DECLARED_UNWIRED = new Map([
  // (empty: every optional port a deps type accepts is constructed somewhere)
]);

const tracked = execFileSync("git", ["ls-files", "packages/**/*.ts", "apps/**/*.ts"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f !== "" && !f.endsWith(".d.ts") && !/\.(test|scenario)\.ts$/.test(f) && !f.includes("/dist/"));

const read = (f) => readFileSync(`${ROOT}/${f}`, "utf8");

// ① Every port interface this repo declares. A port is an interface a store/adapter binds — they live in
//    `ports/` by convention (rule `api-layer`: interfaces in the contract root, impls in adapter packages).
const ports = new Set();
for (const f of tracked.filter((f) => f.includes("/ports/"))) {
  for (const m of read(f).matchAll(/^export interface (\w+)/gm)) ports.add(m[1]);
}

// ② Which of them some deps type accepts OPTIONALLY. Required deps are already checked by the compiler at
//    the composition root — an unwired required dep does not build. Optional is the shape that hides.
const optionallyAccepted = new Map();
for (const f of tracked) {
  const src = read(f);
  for (const m of src.matchAll(/^\s*(\w+)\?:\s*([\w.]+)\s*;/gm)) {
    const type = m[2].split(".").pop();
    if (!ports.has(type)) continue;
    if (!optionallyAccepted.has(type)) optionallyAccepted.set(type, new Set());
    optionallyAccepted.get(type).add(`${f}:${m[1]}`);
  }
}

// ③ …and which are actually CONSTRUCTED where a deployment is assembled. An implementation is a class that
//    `implements <Port>`; constructing any of them counts.
const implsOf = new Map();
for (const f of tracked) {
  for (const m of read(f).matchAll(/^export class (\w+)[^{]*implements ([\w,\s]+)\{/gm)) {
    for (const port of m[2].split(",").map((s) => s.trim())) {
      if (!ports.has(port)) continue;
      if (!implsOf.has(port)) implsOf.set(port, new Set());
      implsOf.get(port).add(m[1]);
    }
  }
}

const compositionSources = tracked
  .filter((f) => f.startsWith("apps/"))
  .map((f) => read(f))
  .join("\n");

const unwired = [];
for (const [port, sites] of optionallyAccepted) {
  if (DECLARED_UNWIRED.has(port)) continue;
  const impls = implsOf.get(port);
  // ⚠️ ONLY PORTS WITH A CLASS IMPLEMENTATION. Most optional ports here are satisfied STRUCTURALLY at the
  // composition root — an object literal or a closure (`verifier: { run: async () => … }`) — and those the
  // compiler already checks where they are passed: a missing one does not build. Writing an `InMemoryX` or
  // a `PgX` is the act that says "a deployment picks one of these", and it is precisely that promise that
  // went unkept. Flagging structurally-satisfied ports would report seventeen healthy wirings and teach
  // everyone to ignore this check.
  if (impls === undefined || impls.size === 0) continue;
  const constructed = [...impls].some((impl) => compositionSources.includes(`new ${impl}(`));
  if (!constructed) unwired.push({ port, sites: [...sites], impls: [...impls] });
}

if (unwired.length > 0) {
  console.error(`unwired capability check FAILED — ${unwired.length} optional port(s) nobody constructs:\n`);
  for (const { port, sites, impls } of unwired) {
    console.error(`  ✗ ${port}`);
    console.error(`      accepted optionally by: ${sites.join(", ")}`);
    console.error(`      implementations: ${impls.length > 0 ? impls.join(", ") : "(none)"}`);
    console.error("      constructed in a composition root: NO");
  }
  console.error(`
An optional dependency with no producer is a plan (rule \`protocol\`). \`deps.x?.y()\` reads the same whether
this deployment declined the capability or no code anywhere supplies it — which is why the prose law did not
hold and this check exists. Construct it in apps/*/src, or add it to DECLARED_UNWIRED with the reason it is
deliberately inert.`);
  process.exit(1);
}

console.log(
  `PASS unwired capabilities: ${optionallyAccepted.size} optional port dependenc(ies) across ${tracked.length} files — every one is constructed in a composition root${
    DECLARED_UNWIRED.size > 0 ? ` (${DECLARED_UNWIRED.size} declared inert)` : ""
  }.`,
);
