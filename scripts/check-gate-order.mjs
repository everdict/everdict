#!/usr/bin/env node
// The two names this check reads out of route handlers. Both are live: `gate` is exported from
// `apps/api/src/api/route-context.ts` and `safeParse` is Zod's, called at every validating door.
export const WATCHES = ["gate", "safeParse"];
//
// ── A DOOR REFUSES BEFORE IT PROCESSES, AND A THIRD OF THEM DID NOT ─────────────────────────────
//
// Rule `api-layer` states the handler shape in order and has since the layer existed:
//
//     ① feature-gate → ② authenticate → ③ authorize (`gate`) → ④ validate (`safeParse`) → ⑤ delegate
//
// `pnpm scan` reported `POST /harnesses` for taking those two in the other order, and called it out as
// something no other door did. That claim was wrong and the census is why this file exists rather than a
// two-line patch: 45 of the 138 handlers that carry both do it, across 21 resource slices. A rule a third of
// the surface does not follow is not a rule anybody is applying; it is prose, in a repository that has
// written down a dozen times what happens to a law kept as prose.
//
// ── WHY THE ORDER, STATED PLAINLY, BECAUSE IT IS NOT A SECURITY HOLE ────────────────────────────
//
// No effect happens on the wrong side of the gate. `gate` still runs before the service is called, so nothing
// here is an authorization bypass, and this check is not filed as one. What the reversed order costs is
// smaller and real:
//
//   · an unauthorized caller is handed the request contract's opinion of their body before being refused.
//     Minor on its own — the OpenAPI document is served at `/docs` — but it is a door answering a caller it
//     has already decided to refuse.
//   · the door does work for a caller it will not serve. Bounded by the body limit, and still work.
//   · and the one that actually matters: WHEN THE DOORS DISAGREE, NOBODY CAN SEE AN ANOMALY. That is the same
//     argument `pnpm guard-siblings` is built on — within one resource, a door carries what its siblings
//     carry — and it is the argument for a ratchet rather than for a campaign.
//
// ⚠️ NOTHING NEEDS THE BODY FIRST, and that is what makes this mechanical rather than a matter of taste.
// `gate(principal: Principal, action: Action)` takes no resource-derived argument — `0212_drop_team_axis.sql`
// removed the axis that used to supply one, and rule `authz-optional` records that removal. The reason
// parse-first ever existed died with it, and 45 doors kept the shape.
//
// ── A RATCHET, NOT A WALL ───────────────────────────────────────────────────────────────────────
//
// The 43 that remain are recorded in `scripts/gate-order-baseline.txt`, per file, and they pass. What is
// refused is a NEW one — the door written after this lesson, which is the door that never learns it. A file
// whose count DROPPED must update the baseline in the same change, for the same reason every ratchet here
// says so: a debt that quietly stops shrinking on paper stops being a debt anybody pays.
//
//     45 → 43   the two `harness.routes.ts` doors `pnpm scan` named, repaired in the change that added this.
//
// ⚠️ WHAT IT CANNOT SEE, said out loud because a scanner's silence is not coverage. It splits a file at each
// `app.<verb>(` and reads the text between, so a handler whose gate lives in a helper it calls, or whose
// validation runs inside the service, carries neither name and is not counted at all. It measures the doors
// that spell both here — which is the population the rule is about — and says nothing about the rest.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(root, "scripts", "gate-order-baseline.txt");
const write = process.argv.includes("--write");

// A handler starts at an `app.get(` / `app.post<`… and runs until the next one. Crude on purpose: the
// alternative is a TypeScript parser for a question two `indexOf`s answer.
const HANDLER_START = /app\.(?:get|post|put|patch|delete)[<(]/;

const files = execFileSync("git", ["ls-files", "apps/api/src/api/**/*.routes.ts"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((f) => f !== "");

// An empty corpus reads exactly like coverage, and the failure is silent for as long as nobody asks.
if (files.length === 0) {
  console.error("✖ gate-order: no route files matched. Refusing to report over an empty corpus.");
  process.exit(1);
}

const found = new Map();
let handlers = 0;
for (const file of files) {
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  const starts = lines.flatMap((l, i) => (HANDLER_START.test(l) ? [i] : []));
  starts.push(lines.length);
  let n = 0;
  for (let k = 0; k < starts.length - 1; k++) {
    const body = lines.slice(starts[k], starts[k + 1]).join("\n");
    const g = body.indexOf("gate(");
    const p = body.indexOf("safeParse");
    // Only a handler that spells BOTH answers this question. One that gates without validating (a read), or
    // validates without gating (an ungated door), is a different subject.
    if (g < 0 || p < 0) continue;
    handlers++;
    if (p < g) n++;
  }
  if (n > 0) found.set(file, n);
}

const render = () =>
  `${[...found.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([f, n]) => `${n}\t${f}`)
    .join("\n")}\n`;

const total = [...found.values()].reduce((a, b) => a + b, 0);

if (write) {
  writeFileSync(BASELINE, render());
  console.log(`· wrote ${path.relative(root, BASELINE)}: ${found.size} file(s), ${total} handler(s).`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`✖ gate-order: ${path.relative(root, BASELINE)} is missing. Regenerate it with --write.`);
  process.exit(1);
}
const baseline = new Map(
  readFileSync(BASELINE, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [n, f] = l.split("\t");
      return [f, Number(n)];
    }),
);

const violations = [];
for (const [file, n] of found) {
  const was = baseline.get(file) ?? 0;
  if (n > was)
    violations.push(
      `  - ${file}: ${n} door(s) validate before authorizing, baseline ${was}. Rule \`api-layer\` orders the handler shape: authorize with \`gate(principal, action)\` FIRST, then \`safeParse\` the body. \`gate\` takes no value from the body, so nothing here needs it parsed.`,
    );
}
for (const [file, was] of baseline) {
  const n = found.get(file) ?? 0;
  if (n < was)
    violations.push(
      `  - ${file}: ${n} door(s) validate before authorizing, baseline ${was} — the debt shrank and the baseline did not. Run \`pnpm gate-order --write\` in the SAME change; a baseline that outlives what it recorded reads as permission.`,
    );
}

if (violations.length > 0) {
  console.error(`\n✖ gate-order: ${violations.length} violation(s)\n`);
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(
  `PASS gate order: ${handlers} door(s) spell both gate and safeParse; ${total} baselined deviation(s) in ${found.size} file(s) — no new one, none silently repaid.`,
);
