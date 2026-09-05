#!/usr/bin/env node
// watches: nothing — reads `lessons/` and `evals/cases/`; it names no live source symbol.
//
// ── A LESSON THAT SAYS IT PRODUCED AN EVAL CASE MUST HAVE ONE ────────────────────────────────────
//
// The article's rule is that each production incident becomes a permanent eval, and `lessons/README.md` says
// where a lesson goes afterwards — an eval case, a scan class, a check, or nothing. That route existed as a
// paragraph and as nothing a machine read, which is the state this repository has a name for.
//
// ⚠️ IT DOES NOT DEMAND AN EVAL FOR EVERY LESSON. Not everything is mechanisable, and `lessons/README.md`
// already says that recording the decision not to mechanise IS the answer — it is what stops the next person
// re-deciding it from scratch. Demanding a case for every lesson would turn that honest answer into a gate
// violation, and the first repair anybody reached for would be to stop writing lessons.
//
// So the check is narrow and asks only what the lesson itself claims: when "What was done about it" names an
// eval case, the case exists. A promise in a record nobody verifies is how a route becomes decorative.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lessonsDir = path.join(root, "lessons");
const casesDir = path.join(root, "evals", "cases");

const violations = [];
const fail = (m) => violations.push(m);

if (!existsSync(lessonsDir)) {
  console.error("✖ lesson-evals: lessons/ is missing — the incident-to-eval route has no origin.");
  process.exit(1);
}
if (!existsSync(casesDir)) {
  console.error("✖ lesson-evals: evals/cases/ is missing — a lesson could not name a case that exists.");
  process.exit(1);
}

const cases = new Set(
  readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
);
if (cases.size === 0) {
  console.error("✖ lesson-evals: evals/cases/ is empty, so every claim would fail for the same uninformative reason.");
  process.exit(1);
}

const lessons = readdirSync(lessonsDir).filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "TEMPLATE.md");

// A lesson names a case by its id in backticks, the way every other reference in this tree does.
const BACKTICKED = /`([a-z0-9][a-z0-9-]{3,})`/g;
// The claim: the lesson's own closing section says an eval case came out of it.
//
// ⚠️ AND A CLAIM OF ABSENCE IS NOT A CLAIM. The first version matched `/eval case/` and read "No eval case:
// this is not a thing an agent gets wrong" — a lesson explaining why it mechanised NOTHING — as a promise of a
// case, then failed for the missing name. It was caught by the first lesson written after the check existed,
// which is the cheapest possible moment and still one commit late. `lessons/README.md` says a lesson may
// answer "nothing"; a check that cannot read that answer punishes the honest one.
const CLAIMS_EVAL = /eval case|evals\/cases\//i;
const DENIES_EVAL = /\b(no|not|without|never|neither)\b[^.\n]{0,24}\beval/i;

let checked = 0;
for (const file of lessons) {
  const body = readFileSync(path.join(lessonsDir, file), "utf8");
  const section = /##\s*What was done about it\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i.exec(body)?.[1];
  if (section === undefined) {
    fail(
      `lessons/${file}: no "## What was done about it" section. The template's four questions are four because the fourth is the one a later reader acts on.`,
    );
    continue;
  }
  // Produced something else, produced nothing, or said in so many words that it produced no eval. All fine.
  if (!CLAIMS_EVAL.test(section) || DENIES_EVAL.test(section)) continue;
  checked++;
  const named = [...section.matchAll(BACKTICKED)].map((m) => m[1]).filter((id) => id !== "evals");
  const hits = named.filter((id) => cases.has(id));
  if (named.length === 0) {
    fail(
      `lessons/${file}: says an eval case came out of it and names none in backticks. A promise nobody can check is how this route becomes decorative.`,
    );
    continue;
  }
  if (hits.length === 0) {
    fail(
      `lessons/${file}: names ${named.map((n) => `\`${n}\``).join(", ")} as its eval case(s), and evals/cases/ has none of them. Either the case was never written, or it was renamed and this record now points at nothing.`,
    );
  }
}

if (violations.length > 0) {
  console.error(`\n✖ lesson-evals: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\n  A lesson may say nothing was mechanised — that is a recorded decision and it passes. What it may\n  not do is claim a case that is not there. See lessons/README.md.",
  );
  process.exit(1);
}
console.log(`PASS lesson evals: ${lessons.length} lesson(s), ${checked} claiming an eval case, all of them present.`);
