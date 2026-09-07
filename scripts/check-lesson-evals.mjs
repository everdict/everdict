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

// ── IT READS A DECLARATION NOW, BECAUSE THE PROSE HEURISTIC WAS WRONG THREE TIMES ─────────────────
//
// A lesson's "What was done about it" section declares one line:
//
//     Eval case: `<id>`          …or…      Eval case: none — <why>
//
// The three rounds it took to stop guessing, because each is a real defect and the shape is the lesson:
//
//   1. Matched `/eval case/` and read "No eval case: this is not a thing an agent gets wrong" — a lesson
//      explaining why it mechanised NOTHING — as a promise, then failed it for naming no case. The honest
//      answer punished, which is how a route stops being used.
//   2. Repaired by treating a denial as a denial UNLESS the section named ids — and "named an id" meant any
//      lone hyphenated backtick. A lesson denying an eval case while mentioning `check-python` stopped being
//      a denial and failed for a case that was never claimed. Same defect, other direction.
//   3. Repaired again by requiring one named id to be a REAL case before a denial is overridden — which let
//      "there was no eval case before; now there is: `renamed-away-case`" through as an honest denial. That
//      is the exact record-pointing-at-nothing this check exists to refuse, and the fix for round 2 built it.
//
// Three rounds, two directions, one cause: the check was inferring intent from sentences people write
// freely. This repository already knows the answer — `WATCHES`, `DECIDED`, `NEEDS`, `DECLARED_UNWIRED` —
// a declaration is COMPLETE where a heuristic is opt-in, and it cannot be re-litigated by a rewording.
const DECLARATION = /^Eval case:\s*(.+)$/m;
const NAMED_CASE = /^`([^`]+)`\s*$/;

let declared = 0;
for (const file of lessons) {
  const body = readFileSync(path.join(lessonsDir, file), "utf8");
  const section = /##\s*What was done about it\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i.exec(body)?.[1];
  if (section === undefined) {
    fail(
      `lessons/${file}: no "## What was done about it" section. The template's four questions are four because the fourth is the one a later reader acts on.`,
    );
    continue;
  }
  const answer = DECLARATION.exec(section)?.[1]?.trim();
  if (answer === undefined) {
    fail(
      `lessons/${file}: no \`Eval case:\` line in "What was done about it". Declare \`Eval case: \\\`<id>\\\`\` or \`Eval case: none — <why>\` — see lessons/TEMPLATE.md. This check used to read the prose and was wrong three times, in both directions.`,
    );
    continue;
  }
  if (/^none\b/i.test(answer)) {
    // Not everything is mechanisable, and `lessons/README.md` says recording that decision IS the answer.
    // A bare `none` is not one: without the reason the next person re-decides it from scratch.
    if (!/^none\s*[—:-]\s*\S/.test(answer))
      fail(
        `lessons/${file}: declares \`Eval case: none\` with no reason. Deciding not to mechanise is a decision; a decision with no reason is a shrug the next reader cannot argue with.`,
      );
    continue;
  }
  declared++;
  const id = NAMED_CASE.exec(answer)?.[1];
  if (id === undefined) {
    fail(
      `lessons/${file}: \`Eval case: ${answer}\` is neither \`none — <why>\` nor a single backticked case id. A promise nobody can check is how this route becomes decorative.`,
    );
    continue;
  }
  if (!cases.has(id))
    fail(
      `lessons/${file}: declares eval case \`${id}\`, and evals/cases/ has no such case. Either it was never written, or it was renamed and this record now points at nothing.`,
    );
}

if (violations.length > 0) {
  console.error(`\n✖ lesson-evals: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\n  A lesson may say nothing was mechanised — that is a recorded decision and it passes. What it may\n  not do is claim a case that is not there. See lessons/README.md.",
  );
  process.exit(1);
}
console.log(
  `PASS lesson evals: ${lessons.length} lesson(s) declare an eval case; ${declared} name one, and every named case exists.`,
);
