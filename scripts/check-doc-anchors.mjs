#!/usr/bin/env node
// ── A PAGE THAT SAYS "LOOK AT ME WHEN THIS FILE CHANGES", AND A GATE THAT FINALLY LOOKS ─────────────────
//
// Product documentation had no owner. Skills travel with the code because CLAUDE.md says so; documents had
// the same sentence and no reader, and `docs/guide/` went 467 code commits without an edit. The owner of a
// document is the change that makes it false, so this check asks that change — see `scripts/doc-anchors.mjs`
// for the rule and why it is per document and per push.
//
// Over every commit this push would carry that is NEWER than this check: a changed file that some document
// anchors, with that document unchanged in the range, needs a `Docs-unchanged: <doc> — <why>` line in a commit
// body. Newer than this check for the reason `pnpm fix-proof` gives: the alternative is rewriting history.
//
// The predicate is driven over a truth table FIRST, every run, so a day with no anchored change is not
// indistinguishable from a broken check.
//
//   node scripts/check-doc-anchors.mjs                  the gate (what `pnpm ci:local` runs)
//   node scripts/check-doc-anchors.mjs --range A..B     what a range would owe, ignoring the rule's start
//
// Reads SOURCE + git history only (no build, no deps), prints every violation, exits 1.
// watches: nothing — reads document frontmatter and commit metadata; it names no live source symbol.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anchorsOf, verdictFor } from "./doc-anchors.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = "scripts/check-doc-anchors.mjs";
const violations = [];
const fail = (message) => violations.push(message);
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const gitOut = (...args) => git(...args).stdout.trim();

const argv = process.argv.slice(2);
if (argv.length > 0 && !(argv.length === 2 && argv[0] === "--range")) {
  console.error(`✖ doc-anchors: unknown arguments "${argv.join(" ")}". Known: --range <A..B>`);
  process.exit(1);
}
const explicitRange = argv[1];

// ── the predicate, over constructed ranges ───────────────────────────────────────────────────────
const doc = (anchors) => anchors;
const DOCS = new Map([
  ["docs/scorecards.md", doc(["packages/contracts/src/records/scorecard.ts"])],
  ["docs/guide/concepts/scorecard.md", doc(["packages/contracts/src/records/scorecard.ts", "apps/web/src/x.tsx"])],
  ["docs/sdlc/gates.md", doc(["scripts/ci-local.mjs"])],
  ["docs/architecture/rearchitecture/00-target-architecture.md", doc(["packages/contracts/src/records/scorecard.ts"])],
  ["docs/architecture/scorecard-analysis-views.md", doc(["packages/contracts/src/records/scorecard.ts"])],
]);
const SCHEMA = "packages/contracts/src/records/scorecard.ts";
const kinds = (v) =>
  `owed=${v.owed.map((o) => o.doc).join("|")} advisory=${v.advisory.length} declined=${v.declined.length} stale=${v.stale.join("|")}`;
/** [name, range, expected] */
const TABLE = [
  [
    "a change to nothing anchored owes nothing",
    { changed: ["packages/x/src/y.ts"], bodies: [] },
    "owed= advisory=0 declined=0 stale=",
  ],
  [
    "an anchored change owes every page that anchors it",
    { changed: [SCHEMA], bodies: [] },
    "owed=docs/scorecards.md|docs/guide/concepts/scorecard.md advisory=1 declined=0 stale=",
  ],
  [
    "a page edited in the same push is not owed; the design record beside it stays advisory",
    { changed: [SCHEMA, "docs/scorecards.md", "docs/guide/concepts/scorecard.md"], bodies: [] },
    "owed= advisory=1 declined=0 stale=",
  ],
  [
    "a declaration names the page it declines, and only that page",
    { changed: [SCHEMA], bodies: ["fix: x\n\nDocs-unchanged: docs/scorecards.md — the field name only"] },
    "owed=docs/guide/concepts/scorecard.md advisory=1 declined=1 stale=",
  ],
  [
    "a declaration with no reason is not a declaration",
    { changed: [SCHEMA], bodies: ["Docs-unchanged: docs/scorecards.md, docs/guide/concepts/scorecard.md —"] },
    "owed=docs/scorecards.md|docs/guide/concepts/scorecard.md advisory=1 declined=0 stale=",
  ],
  [
    "one line may decline several pages",
    {
      changed: [SCHEMA],
      bodies: ["Docs-unchanged: docs/scorecards.md, docs/guide/concepts/scorecard.md — internal rename"],
    },
    "owed= advisory=1 declined=2 stale=",
  ],
  [
    "a declaration for a page the push does not implicate is stale",
    { changed: ["packages/x/src/y.ts"], bodies: ["Docs-unchanged: docs/scorecards.md — nothing to say"] },
    "owed= advisory=0 declined=0 stale=docs/scorecards.md",
  ],
  [
    "a design record is advisory — listed, never owed — and the frozen folder is not even listed",
    { changed: [SCHEMA, "docs/scorecards.md", "docs/guide/concepts/scorecard.md"], bodies: [] },
    "owed= advisory=1 declined=0 stale=",
  ],
  [
    "a declaration may decline a design record too, and then it is not stale",
    {
      changed: [SCHEMA, "docs/scorecards.md", "docs/guide/concepts/scorecard.md"],
      bodies: ["Docs-unchanged: docs/architecture/scorecard-analysis-views.md — the lens model did not move"],
    },
    "owed= advisory=0 declined=1 stale=",
  ],
  [
    "records under docs/sdlc/ are another gate's",
    { changed: ["scripts/ci-local.mjs"], bodies: [] },
    "owed= advisory=0 declined=0 stale=",
  ],
];
for (const [name, range, expected] of TABLE) {
  const got = kinds(verdictFor({ ...range, docs: DOCS }));
  // The rearchitecture page anchors the same schema and must never appear — the historical folder is exempt.
  if (got !== expected) fail(`predicate: ${name} — expected \`${expected}\`, got \`${got}\`.`);
}
{
  const superseded = anchorsOf("---\nkind: decision\nstatus: superseded\nanchors: [a.ts]\n---\n# x");
  const live = anchorsOf("---\nkind: wiki\nstatus: current\nanchors: [a.ts, b.ts]\n---\n# x");
  if (superseded.length !== 0) fail("predicate: a superseded decision's anchors are its successor's business.");
  if (live.join(",") !== "a.ts,b.ts") fail(`predicate: anchors parse as a list — got \`${live.join(",")}\`.`);
}

// ── the documents at the tip ─────────────────────────────────────────────────────────────────────
const tip = explicitRange?.split("..")[1] || "HEAD";
const docPaths = gitOut("ls-tree", "-r", "--name-only", tip, "--", "docs")
  .split("\n")
  .filter((f) => f.endsWith(".md"));
const docs = new Map();
for (const p of docPaths) {
  const anchors = anchorsOf(git("show", `${tip}:${p}`).stdout);
  if (anchors.length > 0) docs.set(p, anchors);
}
if (docs.size === 0) {
  console.error(`✖ doc-anchors: no document at ${tip} declares an anchor. Refusing to report over an empty corpus.`);
  process.exit(1);
}

// ── the commits this push would carry, newer than this check ─────────────────────────────────────
const introduced = gitOut("log", "--follow", "--diff-filter=A", "--format=%H", "--", self)
  .split("\n")
  .filter(Boolean)
  .at(-1);
const remote = gitOut("remote").split("\n").filter(Boolean)[0];
const base = `${remote}/main`;
let range = explicitRange;
let commits = [];
if (range === undefined) {
  if (introduced === undefined) {
    console.log(`· ${self} is not committed yet; the rule applies from the commit that introduces it.`);
  } else if (remote === undefined || git("rev-parse", "--verify", "--quiet", base).status !== 0) {
    console.log(`· cannot resolve ${base}; only the truth table ran.`);
  } else {
    range = `${base}..HEAD`;
  }
}
if (range !== undefined) {
  commits = gitOut("rev-list", "--reverse", range).split("\n").filter(Boolean);
  // Strictly newer than the rule, unless the range was named by hand to ask "what would this owe".
  if (explicitRange === undefined && introduced !== undefined)
    commits = commits.filter((sha) => git("merge-base", "--is-ancestor", sha, introduced).status !== 0);
}

let verdict = { owed: [], advisory: [], declined: [], stale: [] };
if (commits.length > 0) {
  const changed = new Set();
  const bodies = [];
  for (const sha of commits) {
    for (const f of gitOut("show", "--name-only", "--format=", sha).split("\n").filter(Boolean)) changed.add(f);
    bodies.push(gitOut("log", "-1", "--format=%B", sha));
  }
  verdict = verdictFor({ changed: [...changed], bodies, docs });
  for (const { doc: page, anchors } of verdict.owed) {
    fail(
      `${page} anchors ${anchors.join(", ")}, which this push changes, and the page is unchanged. Update it, or add \`Docs-unchanged: ${page} — <why>\` to a commit body.`,
    );
  }
  for (const { doc: page, anchors } of verdict.advisory)
    console.log(`· advisory: ${page} anchors ${anchors.join(", ")}, which this push changes — read it; not refused.`);
  for (const page of verdict.stale) {
    fail(
      `a commit declares \`Docs-unchanged: ${page}\`, and nothing this push changes is anchored by that page. A reason that outlived its subject reads as permission.`,
    );
  }
}

if (violations.length > 0) {
  console.error(`\n✖ doc-anchors: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\n  A document is owned by the change that makes it false. Read the page against what moved, and either\n  edit it in this push or say in one line why it still holds.",
  );
  process.exit(1);
}
console.log(
  `PASS doc-anchors: the rule holds over ${TABLE.length} constructed ranges; ${docs.size} anchored document(s); ${commits.length} commit(s) in scope${range ? ` (${range})` : ""}, ${verdict.declined.length} page(s) declined with a reason, ${verdict.advisory.length} design record(s) listed as advisory.`,
);
