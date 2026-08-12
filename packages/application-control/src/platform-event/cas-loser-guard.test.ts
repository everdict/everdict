import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── CAS REJECTED STATE IS NOT REJECTED SIDE EFFECTS ──────────────────────────────────────────────────
//
// A guarded write is honest about the ledger: a statement that matches no row inserts no outbox event either,
// so the DURABLE record of a lost race is correctly empty. What several callers did anyway was stamp their
// facts before the write and push them to the live bus after it, without reading whether the write landed.
//
// In this platform that bus is not a UI toast. It is the input to agent activation, so a loser announcing a
// settlement that never happened can start work nobody can take back — and the durable reconcile that would
// have caught the discrepancy runs long after the agent did.
//
// The rule: in a function that performs a GUARDED write, the live push must be downstream of a check on that
// write's return value. This scan enforces the observable half of it — a file that guards a write and also
// pushes must contain the check — because the alternative (teaching a regex to follow control flow) would be
// a guard nobody can trust either way.
const GUARDED_UPDATE = /(?:\bconst\s+(\w+)\s*=\s*)?await\s+[\w.?]*\.update\(/g;
const GUARD = /expect(NonTerminal|NotCancelled)\b/;
const PUSH = /pushPersisted/;

function tsFilesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return tsFilesUnder(full, rel);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

// The call's own argument span, plus what follows it — "does this write's answer reach the push" is a
// question about ORDER, so the scan reads the text in order rather than asking the file as a whole.
function guardedWrites(code: string): Array<{ bound: boolean; publishesAfter: boolean }> {
  const found: Array<{ bound: boolean; publishesAfter: boolean }> = [];
  for (const match of code.matchAll(GUARDED_UPDATE)) {
    const from = match.index ?? 0;
    let depth = 0;
    let i = from + match[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const span = code.slice(from, i + 1);
    if (!GUARD.test(span)) continue;
    // The window a settle's own publish lands in. Generous on purpose: a false positive here costs one
    // binding, and a false negative costs a fact on the live bus that the ledger never recorded.
    found.push({ bound: match[1] !== undefined, publishesAfter: PUSH.test(code.slice(i, i + 600)) });
  }
  return found;
}

describe("CAS-loser guard — a rejected write announces nothing", () => {
  const root = join(__dirname, "..");
  const writes = tsFilesUnder(root).flatMap((rel) =>
    guardedWrites(readFileSync(join(root, rel), "utf8")).map((w) => ({ rel, ...w })),
  );

  it("a guarded write followed by a live push binds its answer", () => {
    // Binding is the observable half: a write whose result was never assigned is one whose answer nobody
    // COULD have read, so the push after it is unconditional by construction. (Binding and then ignoring it
    // is caught by the repo's unused-variable lint, which is the other half.)
    expect(writes.filter((w) => w.publishesAfter && !w.bound).map((w) => w.rel)).toEqual([]);
  });

  it("the scanner is watching real guarded writes", () => {
    expect(writes.length).toBeGreaterThan(3);
    expect(writes.filter((w) => w.publishesAfter).length).toBeGreaterThan(0);
  });
});
