import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── A NEGATED LIFECYCLE LIST IS FAIL-OPEN (arch-review 56, Wave A) ───────────────────────────────────
//
// The structural half of the vocabulary wave. `reserveWork`'s parent guard shipped as
//
//     AND s.status NOT IN ('succeeded', 'failed')
//
// and was correct when it was written. `superseded` and `cancelled` joined the scorecard enum afterwards and
// `suspended` joined the run enum, and every one of them landed on the PERMITTED side without a single line
// changing — so the guard that exists to stop a cancelled batch from placing compute answered "go ahead".
//
// That is not a missing string, it is a direction. A negated list grows permissive; an allowlist grows
// restrictive. Only one of those is safe to leave in a codebase whose enums are still moving, and the
// difference is invisible at the call site — which is why it needs a scanner rather than a convention.
//
// WHAT IS SCANNED: SQL text in the store layer that gates on a LIFECYCLE column by exclusion. Not every
// negation — `NOT cancel_requested` is a boolean and says what it means, and a `NOT IN` over ids is not a
// vocabulary at all. The lifecycle columns are the ones whose enum grows.
const LIFECYCLE_COLUMNS = ["status", "state", "agent_status"];

// `<col> NOT IN (` and `<alias>.<col> NOT IN (`, which is how every instance was written.
const NEGATED = new RegExp(`\\b(?:[a-z_]+\\.)?(?:${LIFECYCLE_COLUMNS.join("|")})\\s+NOT\\s+IN\\s*\\(`, "i");

// GETTING ON THE ALLOWLIST means the exclusion is over a set that CANNOT grow — a closed vocabulary this
// repo owns and whose additions are already gated by a `satisfies` somewhere. It never means "this one reads
// fine". Each entry names the closed set and why adding to it is impossible without touching the query.
const ALLOWED = new Map<string, string>([
  // The ATTEMPT state machine's terminal list is interpolated from `TERMINAL_ATTEMPT_STATES`, so the query
  // has no hand-written vocabulary to drift: adding a state updates the constant and the SQL together. It is
  // matched here only because the interpolation renders as a NOT IN at runtime, not in the source.
  ["results/pg-execution-attempt-store.ts", "TERMINAL_ATTEMPT_STATES is interpolated, not spelled"],
]);

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesUnder(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("no store gates a lifecycle column by exclusion", () => {
  const root = join(__dirname);

  it("finds no hand-written `NOT IN` over a status/state column", () => {
    const offenders: string[] = [];
    for (const file of sourcesUnder(root)) {
      const relative = file.slice(root.length + 1);
      const allowed = ALLOWED.get(relative);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (line.trimStart().startsWith("//")) return; // a comment describing the defect is not the defect
        if (!NEGATED.test(line)) return;
        // The interpolated form is the generated one — a template hole cannot be a stale vocabulary.
        if (/\$\{[A-Z_]+\}/.test(line) && allowed !== undefined) return;
        offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      [
        "a lifecycle column is gated by EXCLUSION, which is fail-open: every status added to the enum after",
        "this line was written joins the permitted side silently. State the statuses that MAY act instead —",
        "`OPEN_RUN_STATUSES` / `OPEN_SCORECARD_STATUSES` (@everdict/contracts) are the shared allowlists, and",
        "their `satisfies` makes the compiler ask the question when the enum grows.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("is watching a real directory — a scan of nothing passes everything", () => {
    // The guard this file's own class of bug needs: a path that stopped resolving would report zero
    // offenders forever, which is indistinguishable from a clean tree.
    expect(sourcesUnder(root).length).toBeGreaterThan(20);
  });
});
