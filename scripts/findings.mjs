#!/usr/bin/env node
// watches: nothing — reads finding reports and a disposition ledger; it names no live source symbol.
//
// `pnpm findings` — what happened to what the reviewer and the scanner reported.
//
// ── THE COUNTER-METRIC THIS HARNESS DID NOT HAVE ─────────────────────────────────────────────────
//
// The AI-native SDLC article names one counter-metric for the PR-review play and this repository had no
// answer for it: **finding precision**, tuned by rating findings. Every other control here can show what it
// refused — the push gate logs an arm per denial, the scan records a dismissal with its reason, the eval
// suite proves a case measures its lesson by removing it. The reviewer alone produced findings that nobody
// ever graded. Two reviews in one session returned eight Important findings; five were acted on, three were
// filed as intents, and NOTHING recorded which of them turned out to be real. A reviewer whose precision is
// unmeasured is a reviewer whose next finding cannot be weighed.
//
// The drill did this for the eval suite: it asks whether a case measures anything. This asks the sibling
// question one control over — whether a finding was worth reading.
//
// ⚠️ A DISPOSITION IS A DECISION, SO IT IS COMMITTED. `findings/DISPOSITIONS.md` travels with the repository
// for the same reason `scans/DISMISSED.md` does: `.git/` does not travel, and a judgement nobody else can
// read is one the next person makes again. The REPORTS stay in `.git/` (they are this checkout's operations);
// the verdicts on them are the project's.
//
// ⚠️ AND IT REFUSES AN EMPTY CORPUS. No reports to read is not a precision of 100%.
//
// Usage:
//   pnpm findings                      # precision, and what is still ungraded
//   pnpm findings --record --source review --key <head> --file <path> --verdict real|false-positive|carried --why "..."
//   pnpm findings --json               # one object for a control band
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitDir = path.join(root, ".git");
const LEDGER = path.join(root, "findings", "DISPOSITIONS.md");

const VERDICTS = new Set(["real", "false-positive", "carried"]);
const KNOWN = new Set(["--record", "--source", "--key", "--file", "--verdict", "--why", "--json"]);
const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) {
    console.error(`✖ findings: unknown option "${argv[i]}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  if (argv[i] === "--record" || argv[i] === "--json") {
    opts[argv[i].slice(2)] = true;
    continue;
  }
  const value = argv[++i];
  if (value === undefined) {
    console.error(`✖ findings: ${argv[i - 1]} needs a value.`);
    process.exit(1);
  }
  opts[argv[i - 1].slice(2)] = value;
}

// ── the ledger ───────────────────────────────────────────────────────────────────────────────────
// One line per graded finding: date · source@key · `file` · **verdict** — why
const LINE = /^- (\d{4}-\d{2}-\d{2}) · (review|scan)@(\S+) · `([^`]+)` · \*\*(real|false-positive|carried)\*\* — (.+)$/;
// ── EVERY LINE AFTER THE MARKER IS AN ENTRY, OR THE FILE IS REFUSED ─────────────────────────────
//
// `.filter(Boolean)` used to drop an unparsed line, so an entry reading as a perfectly good grading to a
// PERSON was invisible to the counter — and the counter is the whole point of this file. It happened: a
// verdict written `**real**, and PREDICTIVE` (an adverb after the closing asterisks) graded a finding in the
// reader's eyes and nowhere else, quietly lowering nothing and raising nothing. `pnpm findings` reported 88
// graded over 89 entry-shaped lines and said nothing about the difference.
//
// ⚠️ THE FIRST REPAIR GUESSED AT A SHAPE AND LEFT A RESIDUE. It flagged a line matching
// `- <date> · `, which is the half of the space I had just removed — a line broken INSIDE that prefix (a
// missing separator, a different date format) still vanished, reproducing the defect class in the diff that
// closed it (found by `pnpm review`, and it is skill `code-review`'s residue rule exactly).
//
// So the rule is total instead: the file declares where its entries start, and EVERY non-empty line after
// that marker must parse. No shape is guessed, so there is no other half to miss.
const ENTRIES_MARKER = "<!-- entries below, newest last -->";
const readLedger = () => {
  if (!existsSync(LEDGER)) return [];
  const text = readFileSync(LEDGER, "utf8");
  const at = text.indexOf(ENTRIES_MARKER);
  if (at < 0) {
    console.error(
      `✖ findings: ${path.relative(root, LEDGER)} has lost its \`${ENTRIES_MARKER}\` marker, so where the
  entries begin cannot be established and every line below would be read as prose.`,
    );
    process.exit(1);
  }
  const entries = [];
  const malformed = [];
  for (const raw of text.slice(at + ENTRIES_MARKER.length).split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const m = LINE.exec(line);
    if (m) entries.push({ date: m[1], source: m[2], key: m[3], file: m[4], verdict: m[5], why: m[6] });
    else malformed.push(line);
  }
  if (malformed.length > 0) {
    console.error(
      `✖ findings: ${malformed.length} line(s) below the entries marker in ${path.relative(root, LEDGER)} do not parse.
  Everything after that marker is an entry; a line that is not one grades a finding for a reader and for
  nothing else, and the count below would silently omit it.
  The form is:  - <date> · <review|scan>@<key> · \`<file>\` · **real|false-positive|carried** — <why>`,
    );
    for (const line of malformed) console.error(`    ${line.slice(0, 120)}`);
    process.exit(1);
  }
  return entries;
};

if (opts.record) {
  for (const need of ["source", "key", "file", "verdict", "why"]) {
    if (opts[need] === undefined) {
      console.error(
        "✖ findings: --record needs --source, --key, --file, --verdict and --why. A verdict without a reason is the trend nobody can trust.",
      );
      process.exit(1);
    }
  }
  if (!VERDICTS.has(opts.verdict)) {
    console.error(`✖ findings: --verdict must be one of ${[...VERDICTS].join(" | ")} (got "${opts.verdict}").`);
    process.exit(1);
  }
  if (opts.source !== "review" && opts.source !== "scan") {
    console.error("✖ findings: --source must be review or scan.");
    process.exit(1);
  }
  // Twelve characters, the same floor `scan --dismiss` applies: "not a bug" is not a reason.
  if (opts.why.trim().length < 12) {
    console.error("✖ findings: --why is too short. Say what made it real, false or carried.");
    process.exit(1);
  }
  mkdirSync(path.dirname(LEDGER), { recursive: true });
  if (!existsSync(LEDGER)) {
    writeFileSync(
      LEDGER,
      "# Finding dispositions\n\nWhat happened to what the reviewer and the scanner reported. Written by\n`pnpm findings --record`, and COMMITTED: a judgement nobody else can read is one the next person makes again.\n\nA finding is `real` (it named a defect), `false-positive` (it did not), or `carried` (real, and deliberately\nnot fixed here — an intent holds it). Precision counts real and carried against the total; carrying a finding\nis not the same as disagreeing with it.\n\n<!-- entries below, newest last -->\n",
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  appendFileSync(
    LEDGER,
    `- ${today} · ${opts.source}@${opts.key} · \`${opts.file}\` · **${opts.verdict}** — ${opts.why.trim()}\n`,
  );
  console.log(`· recorded: ${opts.source}@${opts.key} ${opts.file} → ${opts.verdict}`);
  process.exit(0);
}

// ── the corpus: what was reported ────────────────────────────────────────────────────────────────
const reports = [];
let unreadable = 0;
let files;
try {
  files = readdirSync(gitDir);
} catch {
  console.error(`✖ findings: could not read ${path.relative(root, gitDir)} — the reports live there.`);
  process.exit(1);
}
for (const f of files) {
  const review = /^everdict-review-([0-9a-f]{12})\.json$/.exec(f);
  const scan = /^everdict-scan-([a-z-]+)\.json$/.exec(f);
  if (!review && !scan) continue;
  let doc;
  try {
    doc = JSON.parse(readFileSync(path.join(gitDir, f), "utf8"));
  } catch {
    unreadable++;
    continue;
  }
  const source = review ? "review" : "scan";
  const key = review ? review[1] : scan[1];
  for (const finding of doc.findings ?? []) {
    // Only what a person is asked to weigh: the reviewer's Important, and the scanner's non-low confidence.
    const important = source === "review" ? finding.severity === "important" : finding.confidence !== "low";
    if (!important) continue;
    reports.push({ source, key, file: String(finding.file ?? "?"), line: finding.line });
  }
}

if (reports.length === 0) {
  console.error(
    `✖ findings: no review or scan reports with weighable findings under ${path.relative(root, gitDir)}${unreadable > 0 ? ` (${unreadable} unreadable)` : ""}.\n  Refusing to report a precision over an empty corpus — nothing to grade is not a clean record.`,
  );
  process.exit(1);
}

// ── match dispositions to findings ───────────────────────────────────────────────────────────────
//
// ⚠️ THE LEDGER'S UNIT IS (source, key, FILE), AND SO IS THIS COUNT. Two findings a reviewer raised about the
// same file in the same run are ONE judgement — there is no way to grade them apart, because the disposition
// line names a file. Counting the reports instead made the header read "64 reported · 63 graded" with an
// EMPTY ungraded list: a reader goes looking for the one nobody weighed and there isn't one. A measurement
// whose two numbers are in different units is a measurement that will be re-derived by hand, which is the
// state this reader exists to end.
const graded = readLedger();
const keyOf = (x) => `${x.source}@${x.key}:${x.file}`;
const gradedSet = new Map(graded.map((g) => [keyOf(g), g]));
const weighable = [...new Map(reports.map((r) => [keyOf(r), r])).values()];
const collapsed = reports.length - weighable.length;
const ungraded = weighable.filter((r) => !gradedSet.has(keyOf(r)));
const real = graded.filter((g) => g.verdict === "real").length;
const carried = graded.filter((g) => g.verdict === "carried").length;
const wrong = graded.filter((g) => g.verdict === "false-positive").length;
const precision = graded.length > 0 ? (real + carried) / graded.length : undefined;

if (opts.json) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      reported: weighable.length,
      findings: reports.length,
      graded: graded.length,
      ungraded: ungraded.length,
      real,
      carried,
      falsePositive: wrong,
      precision: precision === undefined ? null : Number(precision.toFixed(4)),
    }),
  );
  process.exit(0);
}

console.log(
  `▶ findings · ${weighable.length} weighable finding(s) reported · ${graded.length} graded${collapsed > 0 ? ` (${reports.length} raised; ${collapsed} share a file with another and are one judgement)` : ""}`,
);
console.log(`  ledger: ${path.relative(root, LEDGER)}${existsSync(LEDGER) ? "" : " (not started)"}`);
console.log("");
if (precision === undefined) {
  console.log("  precision: UNKNOWN — nothing has been graded yet.");
  console.log("             That is not a precision of 100%; it is the absence of the measurement, and it is");
  console.log("             the counter-metric the article names for the PR-review play.");
} else {
  console.log(
    `  precision: ${(precision * 100).toFixed(0)}%  (${real} real + ${carried} carried / ${graded.length} graded)`,
  );
  if (wrong > 0) console.log(`             ${wrong} false positive(s) — the reviewer's cost, measured.`);
}
console.log("");
if (ungraded.length > 0) {
  console.log(`  ungraded (${ungraded.length}) — each is a finding somebody read and nobody weighed:`);
  for (const r of ungraded.slice(0, 8)) {
    console.log(`    ${r.source}@${r.key}  ${r.file}${r.line ? `:${r.line}` : ""}`);
  }
  if (ungraded.length > 8) console.log(`    … and ${ungraded.length - 8} more`);
  console.log("");
  console.log("  grade one:  pnpm findings --record --source <review|scan> --key <key> --file <path> \\");
  console.log('                --verdict real|false-positive|carried --why "<what made it so>"');
}
