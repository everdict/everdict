#!/usr/bin/env node
// Migration numbering guard.
//
// `migrate()` tracks applied migrations by FILENAME and applies them in filename order, so two files sharing a
// number both run — but in an order decided by whatever follows the digits. That is fine right up until the two
// touch the same table, and then which one wins is alphabetical accident rather than intent. It happens when two
// branches each take "the next number" without seeing the other, which is exactly what a shared repo does.
//
// So: numbers must be unique from here on. Pairs that ALREADY shipped are grandfathered by name — they are
// applied everywhere and an applied migration is never edited (see .claude/rules/db.md), so the only honest
// treatment is to record them and refuse any NEW one.
// watches: nothing — reads migration filenames and their preflight documents.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "packages", "db", "migrations");

// Collisions that predate this guard. Never add to this list — renumber the newcomer instead.
const GRANDFATHERED = new Set(["0016", "0051", "0072", "0086", "0111", "0116"]);

const byNumber = new Map();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
  const number = file.slice(0, file.indexOf("_"));
  if (!/^\d{4}$/.test(number)) {
    console.error(`✗ ${file} — a migration filename must start with a 4-digit number.`);
    process.exit(1);
  }
  byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
}

const fresh = [...byNumber.entries()].filter(([n, files]) => files.length > 1 && !GRANDFATHERED.has(n));
if (fresh.length > 0) {
  for (const [number, files] of fresh)
    console.error(`✗ migration number ${number} is used by ${files.length} files: ${files.join(", ")}`);
  console.error(
    "Renumber the newer one to the next free number. Two files with one number apply in filename order, " +
      "which is alphabetical accident rather than intent.",
  );
  process.exit(1);
}

const highest = [...byNumber.keys()].sort().at(-1);
console.log(`PASS migrations: ${byNumber.size} numbers, none newly duplicated (highest ${highest})`);
