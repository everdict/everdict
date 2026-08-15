import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE STRUCTURAL HALF OF "FIRST RESULT WINS" (review 46) ───────────────────────────────────────────
//
// `expectNonTerminal` fenced the STATUS race and left the PAYLOAD open, and the payload is the half a reader
// actually looks at. The batch's write-back reflects each case's final result onto its child row, and it
// guarded that with a READ two lines above the write:
//
//     const current = await store.get(childId);
//     if (current?.result) continue;          // ← the check
//     await store.update(childId, { result: r, … });   // ← the write
//
// That is the read-check-write this codebase has now removed from the status plane four separate times,
// re-authored against the result field. The competing writer is in another process by construction (the child
// publishes its own result through the commit point while the parent is reflecting the loop's copy), so the
// window is not theoretical and the loser is not visible: two plausible results, and the LAST one written is
// the one every reader gets. A run's result is its evidence — a row that quietly restates it is a record that
// disagrees with the receipt naming it.
//
// The condition exists (`expectNoResult`, evaluated in SQL by `PgRunStore` and by the in-memory store), and
// like every optional guard in this vocabulary, obeying it is call-site discipline that fails INVISIBLY. This
// scan is what makes the omission fail here instead.
//
// GETTING ON THE ALLOWLIST means the write is not a first publication — it REVISES a result that is already
// there, on purpose, under a fence of its own. It never means "this one is fine unfenced". Each entry caps
// the number of such writes in the file, so a second, different result write appearing next to an allowlisted
// one is a failure rather than an inheritance.
const ALLOWED = new Map<string, number>([
  // THE RE-SCORING WRITE-BACK. `writeBackScores` replaces the judge families a scoring pass just decided
  // (`{ ...child.result, scores: nextScores }`) onto a row that must ALREADY carry a result — it skips the
  // case outright when it does not (`if (!child?.result) continue`). `expectNoResult` is not merely
  // unnecessary there, it is the opposite of the statement being made, and demanding it would be this scan
  // asking for a condition that contradicts the write. What that write carries instead is the SCORING
  // PLANE's own fence (`{ scoring: { scorecardId, passId } }`, mig 0158/0159), and a fenced miss throws
  // rather than continuing — a superseded pass does not get to scatter half its judgments.
  ["packages/application-control/src/scorecard/scorecard-score-service.ts", 1],
]);

// WHERE THE RULE APPLIES: everywhere the product is written. The same lesson terminal-write-guard learned the
// expensive way — arch-review 31's unfenced write was in a composition root, in a layer a package-scoped scan
// could not see — applies unchanged to the payload, so any layer that can reach a store is scanned.
//
// `packages/db` is EXCLUDED rather than allowlisted: it is where `expectNoResult` becomes `AND result IS NULL`
// (`pg-run-store.ts`) and a `cur.result !== undefined` refusal (`run-store.ts`). Asking the implementation to
// pass the condition it implements is circular. `packages/domain` holds no store at all.
const SCAN_ROOTS = ["apps", "packages"];
const EXCLUDED_ROOTS = new Set(["packages/db", "packages/domain"]);

// A RESULT WRITE: the patch names `result`. Deliberately the field and not the value's shape — the write-back
// passed a bare variable (`{ result: r }`) and the re-score passes a spread, and a rule keyed on either
// spelling would see exactly one of the two. `\bresult\s*:` does not match `resultDigest:`, which is a
// receipt's field and not the row's payload.
const RESULT_PATCH = /\bresult\s*:/;
// WHAT COUNTS AS FENCED. One condition, because there is one question: had this row published a result
// before this statement ran? Spelled as the port spells it, so renaming the condition fails this scan loudly
// instead of turning it into a rule about a word nothing uses.
const FENCE = /expectNoResult/;
// The port that defines it. The anchor that keeps the line above meaningful.
const PORT = "packages/application-control/src/ports/run-store.ts";

// Comment text is not code.
function codeOf(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .map((line) => line.replace(/\s+\/\/.*$/, ""))
    .join("\n");
}

// Each `…update(` call's own ARGUMENT SPAN, by balancing parentheses — the same walker the terminal-write
// guard uses, and for the same reason: the guard object is the FOURTH argument, several lines below the patch
// that needs it, so file-level or line-level co-occurrence answers a different question than the one asked.
function updateCalls(code: string): string[] {
  const spans: string[] = [];
  for (const match of code.matchAll(/\.update\(/g)) {
    let depth = 0;
    let i = (match.index ?? 0) + match[0].length - 1;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push(code.slice(start, i + 1));
  }
  return spans;
}

const resultWritesIn = (code: string): string[] => updateCalls(code).filter((span) => RESULT_PATCH.test(span));

function tsFilesUnder(dir: string, prefix: string): string[] {
  if (EXCLUDED_ROOTS.has(prefix) || prefix.endsWith("/dist") || prefix.endsWith("/node_modules")) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return tsFilesUnder(full, rel);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

describe("result-write fence guard — publishing a run's result states that it had none", () => {
  const root = join(__dirname, "../../../..");
  const scanned = SCAN_ROOTS.flatMap((r) => tsFilesUnder(join(root, r), r));
  const files = scanned.map((rel) => ({ rel, code: codeOf(readFileSync(join(root, rel), "utf8")) }));
  const resultWrites = files.flatMap(({ rel, code }) => resultWritesIn(code).map((span) => ({ rel, span })));

  it("a result write outside the allowlist carries the condition instead of a read above it", () => {
    const byFile = new Map<string, number>();
    const offenders: string[] = [];
    for (const { rel, span } of resultWrites) {
      if (FENCE.test(span)) continue;
      const seen = (byFile.get(rel) ?? 0) + 1;
      byFile.set(rel, seen);
      const allowed = ALLOWED.get(rel);
      if (allowed === undefined) offenders.push(`${rel}: unfenced result write — ${span.replace(/\s+/g, " ")}`);
      else if (seen > allowed) offenders.push(`${rel}: ${seen} unfenced result writes, allowlist permits ${allowed}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlisted writers still exist — a stale allowlist is a scanner scanning nothing", () => {
    for (const [rel, expected] of ALLOWED) {
      const unfenced = resultWritesIn(codeOf(readFileSync(join(root, rel), "utf8"))).filter((s) => !FENCE.test(s));
      expect(`${rel}: ${unfenced.length}`).toBe(`${rel}: ${expected}`);
    }
  });

  it("the rule fires on the shape it was written for — the read-check-write, before the condition was added", () => {
    // The write-back exactly as it stood before review 46, guard object and all: the read two lines up is
    // present, and the scan is indifferent to it, which is the entire point. `settleRun`'s own patches are
    // NOT in this fixture set on purpose — the settle verb carries no `result` at all (the result rides the
    // commit transaction in `packages/db`), so there is no settle file to allowlist and adding one would be
    // an entry that matches nothing.
    const pre = [
      "const current = await store.get(childId);",
      "if (current?.result) continue;",
      "await store.update(childId, { result: r, updatedAt: this.now() }, undefined, {",
      "  expectNotCancelled: true,",
      "});",
    ].join("\n");
    expect(resultWritesIn(codeOf(pre)).filter((s) => !FENCE.test(s))).toHaveLength(1);
    // …and it goes quiet the moment the condition travels with the statement.
    expect(resultWritesIn(codeOf(pre.replace("expectNotCancelled: true,", "expectNoResult: true,")))).toHaveLength(1);
    expect(
      resultWritesIn(codeOf(pre.replace("expectNotCancelled: true,", "expectNoResult: true,"))).filter(
        (s) => !FENCE.test(s),
      ),
    ).toEqual([]);
    // A lifecycle write that publishes no result is not this guard's business.
    expect(
      resultWritesIn(codeOf("await store.update(id, { status: 'running' }, undefined, { expectNonTerminal: true });")),
    ).toEqual([]);
    // …and a receipt's digest is not the row's payload.
    expect(resultWritesIn(codeOf("await store.update(id, { resultDigest: d }, undefined, undefined);"))).toEqual([]);
  });

  it("the scanner still matches the writers it is meant to watch", () => {
    // A guard that stops finding result writes reports green forever, and this one polices a single field —
    // one rename away from matching nothing at all.
    expect(resultWrites.length).toBeGreaterThan(1);
    // The condition is still the port's, not a word this file made up.
    expect(readFileSync(join(root, PORT), "utf8")).toMatch(/expectNoResult\?:\s*true/);
    // At least one live write states it — the write-back review 46 fixed. If this drops to zero, either the
    // fix was reverted or the write moved somewhere this scan cannot see.
    expect(resultWrites.filter(({ span }) => FENCE.test(span)).length).toBeGreaterThan(0);
    // …and the walk still reaches the whole product, not one package.
    expect(scanned.some((rel) => rel.startsWith("apps/api/"))).toBe(true);
    expect(scanned.length).toBeGreaterThan(500);
  });
});
