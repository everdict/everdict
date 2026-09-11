// ONE reader for the two committed ledgers that share a marker, because writing it twice already diverged
// three times in one afternoon.
//
// `findings/DISPOSITIONS.md` (what happened to what the reviewer and the scanner reported) and
// `scans/DISMISSED.md` (which findings were dismissed, and why) have the same shape: prose, then
// `<!-- entries below, newest last -->`, then one line per entry. Both are COMMITTED, both are read by a
// script, and both are the counter-metric somebody could otherwise move without anyone seeing.
//
// ── WHY THIS IS A MODULE AND NOT A THIRD COPY ────────────────────────────────────────────────────────
//
// The rule below was built in four passes, each one closing the half the previous pass had been looking at,
// and every pass was caught by `pnpm review` rather than by the author:
//
//   1. `.filter(Boolean)` dropped an unparsed line          → an entry graded for a reader and counted by
//                                                              nothing (`**real**, and PREDICTIVE`)
//   2. the fix flagged a GUESSED shape (`- <date> · `)      → a line broken inside that prefix still vanished
//   3. the total rule covered only BELOW the marker         → a well-formed entry pasted above was invisible
//   4. the sibling ledger got half of the rule ported       → the same hole, in the other file
//
// Four times is not carelessness, it is the shape rule `protocol` L3 names: a predicate written twice has
// already diverged. So there is one predicate, total in both directions, and a caller cannot take half of it.
//
// watches: nothing — it reads two committed markdown ledgers, not source vocabulary.

import { existsSync, readFileSync } from "node:fs";

export const ENTRIES_MARKER = "<!-- entries below, newest last -->";

/**
 * Read a marker-delimited ledger, or refuse it by name.
 *
 * Refuses, rather than returning a shorter list, when:
 *   · the marker is gone          — where the entries begin has no answer, and every line below reads as prose
 *   · an entry sits ABOVE it      — well-formed and in a place nothing reads
 *   · a line below does not parse — an entry for a human eye and for no counter
 *
 * "Could not read it" is never "there was nothing to read" (rule `protocol` L2, and CLAUDE.md's empty-corpus
 * law one level down: a ledger whose unreadable lines are skipped reads exactly like a shorter ledger).
 *
 * @param {{ file: string, tool: string, label: string, line: RegExp, what: string, cost: string }} spec
 *   `tool` is the command a person ran (it prefixes every refusal); `label` is the path they should see; `line` must be anchored and is used BOTH to parse below the
 *   marker and to detect a misplaced entry above it, so the two questions can never drift apart.
 *   `what` is the BARE noun for one entry ("disposition", "dismissal"); `cost` says what losing one costs.
 * @returns {RegExpExecArray[]} one match per entry, in file order
 */
export function readMarkedLedger({ file, tool, label, line, what, cost }) {
  const refuse = (message, offenders = []) => {
    console.error(`✖ ${tool}: ${message}`);
    for (const offender of offenders) console.error(`    ${offender.slice(0, 120)}`);
    process.exit(1);
  };
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const at = text.indexOf(ENTRIES_MARKER);
  if (at < 0)
    refuse(
      `${label} has lost its \`${ENTRIES_MARKER}\` marker, so where the entries begin cannot be established
  and every line below would be read as prose. ${cost}`,
    );

  const misplaced = text
    .slice(0, at)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => line.test(l));
  if (misplaced.length > 0)
    refuse(
      `${misplaced.length} ${what} line(s) in ${label} sit ABOVE the marker, where nothing reads them.
  Move them below it.`,
      misplaced,
    );

  const entries = [];
  const malformed = [];
  for (const raw of text.slice(at + ENTRIES_MARKER.length).split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const m = line.exec(trimmed);
    if (m) entries.push(m);
    else malformed.push(trimmed);
  }
  if (malformed.length > 0)
    refuse(
      `${malformed.length} line(s) below the entries marker in ${label} do not parse.
  Everything after that marker is a ${what}; a line that is not one records it for a reader and for nothing
  else. ${cost}`,
      malformed,
    );
  return entries;
}
