#!/usr/bin/env node
// A GRADER MAY NOT SPEND "I COULD NOT ANSWER" AS THE AGENT'S WRONG ANSWER.
//
// `RewardFileGrader` models the third value correctly: a verifier that publishes no reward makes the case
// `unmeasured` / `missing_evidence`, and every consumer of a score plane filters `isMeasured`. That discipline
// was defeated one layer below it, by a shell fragment:
//
//     python3 /opt/sbench_digest.py … && echo 1.0 > reward.txt || echo 0.0 > reward.txt
//
// `||` fires on EVERY non-zero exit. The scorer exits non-zero when the agent's answer differs (a real 0.0)
// and also when it cannot run at all — and it could not run for 420 of SpreadsheetBench's 912 tasks, whose
// `answer_position` its parser raised on. Every one of those was published as a confident zero, over a
// workbook the grader never opened. The campaign then consumed a comparable round, derived a verdict, and
// ended `no_improvement`: hypotheses blamed for an instrument, three layers up, with the collapse invisible
// at each one because a reward file reads `0.0` either way.
//
// So: a grader command that writes a reward on the failure arm of `&&`/`||` is refused. Branch on the exit
// code and publish NOTHING for the arm that means "the grader could not run" — an absent reward is the
// third value the platform already knows how to read.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = execSync("git ls-files '*.mjs' '*.ts' '*.js' '*.json' '*.py' '*.sh'", {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("scripts/check-grader-collapse"));

// `|| echo 0`, `|| echo 0.0`, `|| printf 0`, and the `&&`-then-`||` reward idiom — the failure arm writing a
// score. Deliberately narrow: it fires on a literal ZERO being published, which is the value that lies.
// Publishing a NON-zero on the failure arm is a different (and much louder) bug, and no such line exists.
const COLLAPSE = /\|\|\s*(?:echo|printf)\s+["']?0(?:\.0+)?["']?\s*>/;
// …and the same collapse spelled as a redirect into the reward path without a preceding exit-code branch.
const REWARD_PATH = /reward\.(?:txt|json)/;

const violations = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  if (!REWARD_PATH.test(text)) continue;
  text.split("\n").forEach((line, i) => {
    if (COLLAPSE.test(line) && REWARD_PATH.test(line)) violations.push(`${file}:${i + 1}`);
  });
}

if (violations.length > 0) {
  console.error(`grader collapse check FAILED — ${violations.length} line(s):\n`);
  for (const v of violations.slice(0, 30)) console.error(`  ✗ ${v}`);
  if (violations.length > 30) console.error(`  … and ${violations.length - 30} more`);
  console.error(
    "\nA reward published on the failure arm of `||` cannot tell a wrong answer from a grader that could not\n" +
      "run. Branch on the exit code and publish nothing for the second one:\n\n" +
      "    <grader>; rc=$?; case $rc in 0) echo 1.0 > reward.txt;; 1) echo 0.0 > reward.txt;;\n" +
      '      *) echo "the grader could not run (exit $rc)" >&2;; esac\n\n' +
      "An absent reward is `unmeasured` / `missing_evidence`, which every score-plane reader already honours.",
  );
  process.exit(1);
}

console.log(
  `PASS grader collapse: ${files.length} source files, no reward published on a grader's failure arm — "could not run" never reaches a verdict as somebody's zero.`,
);
