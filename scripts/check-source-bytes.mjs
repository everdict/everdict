#!/usr/bin/env node
// No literal control bytes in source (arch-review 57 follow-up).
//
// Seven files carried a raw `\x00` or `\x01` — always the same idiom, a control character used as the
// separator in a composite key (`${tenant}\x00${id}`). The intent is right: a byte the data cannot contain
// makes the key injective. Writing it RAW is what costs, and it costs where nobody looks:
//
//   · git treats the file as BINARY, so `git diff` says "Binary files differ" and the change is unreviewable;
//   · `git grep` skips it entirely, so every scanner and every search in this repo is blind to that file —
//     including the ones added to catch defects;
//   · string matching against the file fails in ways that read as "the text is not there".
//
// `sameResolvedImages`, which decides whether two runs used the same image bytes, sat behind that for as long
// as the corruption did. A decision function nobody can review or search is a decision function nobody checks.
//
// `\u0000` compiles to the same byte. There is no reason to write the other one, so this refuses it.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
// watches: nothing — matches control codes in bytes.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tab, newline and carriage return are ordinary text. Everything else below 0x20, plus DEL, is not.
// ASSEMBLED from codepoints. `noControlCharactersInRegex` reads the pattern in both the literal and the
// `new RegExp("…")` form — correctly, because a control character in a pattern is nearly always a mistake,
// and this is the one file where it is the whole point. Building the class from `String.fromCharCode` states
// the intent without disabling the rule here, which would also disable it for the next pattern someone adds.
const CONTROL_CODES = [
  ...Array.from({ length: 9 }, (_, i) => i), // NUL … BS
  11,
  12, // VT, FF — tab (9) and the newlines (10, 13) are ordinary text
  ...Array.from({ length: 18 }, (_, i) => i + 14), // SO … US
  127, // DEL
];
const CONTROL = new RegExp(`[${CONTROL_CODES.map((c) => String.fromCharCode(c)).join("")}]`, "g");

// Extensions that ARE text by definition — a font or an image is allowed to be full of these.
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sql|css|sh|py|toml)$/;

const files = execSync("git ls-files", { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split("\n")
  .filter((f) => f !== "" && SOURCE.test(f));

const violations = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const hits = line.match(CONTROL);
    if (hits === null) continue;
    const shown = line.replace(CONTROL, (c) => `⟦${c.charCodeAt(0).toString(16).padStart(2, "0")}⟧`).trim();
    violations.push(`${file}:${i + 1} holds ${hits.length} literal control byte(s) — ${shown.slice(0, 100)}`);
  }
}

if (violations.length > 0) {
  console.error(`source bytes check FAILED — ${violations.length} line(s):\n`);
  for (const v of violations.slice(0, 30)) console.error(`  ✗ ${v}`);
  if (violations.length > 30) console.error(`  … and ${violations.length - 30} more`);
  console.error(
    "\nWrite the escape instead — `\\u0000` is the same byte and keeps the file text. Raw, it makes git treat\n" +
      "the source as binary: no diff, no `git grep`, and every scanner in this repo goes blind to that file.",
  );
  process.exit(1);
}

console.log(`PASS source bytes: ${files.length} source files, no literal control bytes — every one stays reviewable.`);
