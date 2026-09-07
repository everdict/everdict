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
// watches: nothing — derives port names from the interfaces themselves.
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
// …and WHERE each implementation lives, so the reachability check below can exclude a port's own files:
// "somebody can reach this" means a reference from somewhere other than the port and its implementations.
const implFiles = new Map();
for (const f of tracked) {
  for (const m of read(f).matchAll(/^export class (\w+)[^{]*implements ([\w,\s]+)\{/gm)) {
    for (const port of m[2].split(",").map((s) => s.trim())) {
      if (!ports.has(port)) continue;
      if (!implsOf.has(port)) implsOf.set(port, new Set());
      implsOf.get(port).add(m[1]);
      if (!implFiles.has(port)) implFiles.set(port, new Set());
      implFiles.get(port).add(f);
    }
  }
}

const compositionSources = tracked
  .filter((f) => f.startsWith("apps/"))
  .map((f) => read(f))
  .join("\n");

// ── …AND AN IMPLEMENTATION NOBODY EVEN DECLARES A DEP FOR (arch-review 72 P0) ───────────────────────
//
// The check above asks whether a DECLARED optional dep has a producer. `PgAdoptionOperationStore` was
// written, exported, tested — and never declared as anyone's dependency, so it was never a candidate and
// this gate reported PASS over a whole feature nobody could reach.
//
// That is the same law in its third form, and the third time it shipped:
//   64  an optional dependency with no producer
//   67  a constructed capability that misses one of its consumers
//   72  an implementation with NO consumer at all
//
// So the question widens. Writing an `InMemoryX`/`PgX` for a port is the act that says "a deployment picks
// one of these"; if NOTHING anywhere accepts that port — not as an optional dep, not as a required one, not
// as a constructor parameter — the promise was never kept and the code is unreachable by construction.
//
// A port used only inside its own package is not the target: the reference has to be somewhere OTHER than
// the port's own file and its implementations, which is what "somebody can reach this" means.
const portFileOf = new Map();
for (const f of tracked.filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
  for (const m of read(f).matchAll(/^export interface (\w+)/gm)) portFileOf.set(m[1], f);
}
const unreachable = [];
for (const [port, impls] of implsOf) {
  if (DECLARED_UNWIRED.has(port)) continue;
  if (optionallyAccepted.has(port)) continue; // the check below already owns it
  const own = new Set([portFileOf.get(port), ...implFiles.get(port)].filter(Boolean));
  // Two things that name a port without consuming it, and both defeated the first draft of this check:
  //
  //   a BARREL re-export      `index.ts` makes it importable, not used — the promise, restated
  //   a COMMENT               prose about the port reads identically to a use, to a raw regex
  //
  // So the reference has to look like a TYPE POSITION: annotated, implemented, or a generic argument. That
  // is what "somebody can reach this" means, and it is the difference between a check people read and one
  // they learn to skip.
  const used = new RegExp(`(:\\s*|implements\\s+|<)${port}\\b`);
  const referenced = tracked
    .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !own.has(f) && !f.endsWith("/index.ts"))
    .some((f) => used.test(read(f)));
  if (!referenced) unreachable.push({ port, impls: [...impls] });
}

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

if (unreachable.length > 0) {
  console.error(`unwired capability check FAILED — ${unreachable.length} port implementation(s) nobody can reach:\n`);
  for (const { port, impls } of unreachable) {
    console.error(`  ✗ ${port}`);
    console.error(`      implementations: ${impls.join(", ")}`);
    console.error("      referenced outside its own port/impl files: NO");
  }
  console.error(
    "\n  Writing an implementation for a port is a promise that a deployment picks one. Nothing accepts this\n" +
      "  port anywhere, so the code is unreachable by construction — the arch-review 72 form of the law.\n" +
      "  Wire a consumer, or record it in DECLARED_UNWIRED with the reason it is inert on purpose.",
  );
  process.exitCode = 1;
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
