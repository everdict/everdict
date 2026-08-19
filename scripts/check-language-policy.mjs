#!/usr/bin/env node
// English-only source guard, as a RATCHET (CLAUDE.md — "Language policy (public repo)").
//
// The policy is unambiguous: everything in the repo is English — docs, code comments, log and error
// messages, OpenAPI summaries, test descriptions. The only Korean is ko-locale PRODUCT DATA: the message
// catalog, the inline ko dictionaries it names, and test assertions on that ko output.
//
// Nothing checked it, and 486 source files drifted. That is the same lesson this tree keeps paying for: a
// rule nobody can run is a rule nobody keeps. But translating 3,354 comment lines in one sweep is the wrong
// repair — those comments carry the REASON a piece of code is the way it is ("do not call revalidatePath
// here — there is no cache to invalidate, and Next 16 drops the client prefetch cache on the declaration
// alone"), and a bulk translation trades precision for coverage in exactly the place precision is the point.
//
// So this is a ratchet, not a sweep. The existing files are recorded in a baseline and pass; a file that is
// NOT in the baseline may not introduce Korean; and a baselined file that has been cleaned must LEAVE the
// baseline in the same change. The count only goes down, and it goes down where someone is already reading
// the file — which is the only place a comment can be translated without losing what it says.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(root, "scripts", "language-policy-baseline.txt");

// The Hangul block, by codepoint. Written as escapes for the same reason the control-byte rule gives: a
// literal here would make this file its own first violation, and a checker that has to exempt itself is
// one nobody can trust to be strict.
const HANGUL = /[\uac00-\ud7a3]/;

// ko-locale PRODUCT DATA, which the policy allows by name. Not a general escape hatch: each entry is a place
// the product speaks Korean to a Korean user, and a test that asserts on that output is asserting on product
// behaviour rather than writing prose in Korean.
const KO_LOCALE = [
  "apps/web/messages/ko.json",
  "apps/web/src/shared/lib/format.ts",
  "apps/web/src/shared/lib/clipboard.ts",
  "apps/web/src/shared/lib/cron.ts",
];
const isKoLocale = (file) => KO_LOCALE.some((p) => file === p || file.startsWith(`${p}/`));

// Binary blobs match the byte range by accident.
const BINARY = /\.(png|jpe?g|webp|gif|ico|pdf|woff2?|ttf|zip|gz|so|node)$/i;

const tracked = execSync("git ls-files", { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split("\n")
  .filter((f) => f !== "" && !BINARY.test(f));

const offenders = new Set();
for (const file of tracked) {
  if (isKoLocale(file)) continue;
  const full = path.join(root, file);
  if (!existsSync(full)) continue; // deleted-but-staged
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    continue;
  }
  if (HANGUL.test(text)) offenders.add(file);
}

const baseline = existsSync(BASELINE)
  ? new Set(
      readFileSync(BASELINE, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#")),
    )
  : new Set();

const problems = [];

// A file that is new to the list. This is the half that has to be refused: everything already recorded is
// history, and history is repaid by editing, not by a gate.
for (const file of offenders) {
  if (!baseline.has(file)) problems.push(`${file} introduces Korean into English-only source`);
}

// …and the half that makes it a ratchet. A baselined file that no longer carries Korean must leave the
// baseline in the same change, or the number stops meaning anything and the list grows stale entries that
// quietly re-permit the next one.
for (const file of baseline) {
  if (offenders.has(file)) continue;
  const why = tracked.includes(file) ? "no longer carries Korean" : "is no longer in the repository";
  problems.push(`baseline names ${file}, which ${why} — remove the line (the ratchet only tightens)`);
}

if (problems.length > 0) {
  console.error(`language policy check FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems.slice(0, 40)) console.error(`  ✗ ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  console.error(
    `\nRepo artifacts are English (CLAUDE.md, Language policy). Korean belongs in the ko message catalog and
the inline ko dictionaries it names. Translate what you wrote — and if you cleaned a baselined file,
drop its line from ${path.relative(root, BASELINE)} in the same change.`,
  );
  process.exit(1);
}

console.log(
  `PASS language policy: ${tracked.length} tracked files, ${offenders.size} carrying Korean — all of them recorded in the baseline, none new. The debt only shrinks from here.`,
);
