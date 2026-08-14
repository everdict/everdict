import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE STRUCTURAL HALF OF "CLAIMING THE RIGHT TO COMMIT IS NOT THE COMMIT" (review 40) ──────────────
//
// `commitCase` couples the receipt claim to the child's fenced terminal write in one transaction. The raw
// `commit` stays on the port for exactly two callers that genuinely have no child write to couple — seeding
// a carried-over result whose child row is born terminal, and the failure exit's receipt (its child was
// terminalized by the fenced settle in the dispatch catch). Every OTHER finalization path must go through
// `commitCase`, and this scan is what says so: a new code path reaching for the raw claim re-opens the
// poison pill (a receipt naming a child that never carried its result), and it must fail HERE, in review,
// rather than in a takeover race a year later.
//
// GETTING ON THE ALLOWLIST means the call provably has no child write to couple. It never means "this one
// is fine without the transaction".
const ALLOWED_RAW_COMMIT_FILES = new Map<string, number>([
  // seeding (child born terminal) + commitFailureReceipt (child terminalized by the fenced fail-settle).
  ["packages/application-control/src/scorecard/scorecard-batch-service.ts", 2],
]);

const SCAN_ROOTS = ["apps", "packages"];
// packages/db implements the port (its Pg commitCase calls its own commitOn); tests certify with fixtures.
const EXCLUDED = [/^packages\/db\//, /\.test\.ts$/, /\.trust\.test\.ts$/, /\/dist\//, /node_modules/];

// The raw claim's call shape: `<something>eceipts.commit(` / `<something>eceipts?.commit(` — the receipt
// store is the only port whose member is spelled `commit` with this receiver naming convention. Whitespace
// (incl. a formatter's line break) may sit between the receiver and the member.
const RAW_COMMIT = /[rR]eceipts\??\s*\.\s*commit\(/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (EXCLUDED.some((re) => re.test(p)) || name === "node_modules" || name === "dist") continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

describe("case-commit guard — the raw receipt claim is allowlisted, the commit point is commitCase", () => {
  it("no production path outside the allowlist claims a receipt without coupling the child's write", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const offenders: string[] = [];
    for (const scanRoot of SCAN_ROOTS) {
      for (const file of walk(join(root, scanRoot))) {
        const rel = file.slice(root.length + 1);
        if (EXCLUDED.some((re) => re.test(rel))) continue;
        const hits = readFileSync(file, "utf8").match(RAW_COMMIT)?.length ?? 0;
        if (hits === 0) continue;
        const allowed = ALLOWED_RAW_COMMIT_FILES.get(rel);
        if (allowed === undefined) offenders.push(`${rel} (${hits} raw commit call(s), not allowlisted)`);
        else if (hits > allowed) offenders.push(`${rel} (${hits} raw commit call(s), allowlist permits ${allowed})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlisted callers still exist — a stale allowlist is a scanner scanning nothing", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    for (const [rel, expected] of ALLOWED_RAW_COMMIT_FILES) {
      const hits = readFileSync(join(root, rel), "utf8").match(RAW_COMMIT)?.length ?? 0;
      expect(`${rel}: ${hits}`).toBe(`${rel}: ${expected}`);
    }
  });
});
