import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE CASE-ID CONTROL SURFACE IS GONE, AND STAYS GONE (arch-review 53, legacy removal) ─────────────
//
// It existed because a stop, a log tail or an adoption had to reach live work and the only coordinate the
// control plane held was the case id. That coordinate names a GROUP: two runs of one case are two live jobs
// (a re-evaluation beside a scheduled batch, a retry beside the attempt it replaces, a shadow beside its
// baseline), so every one of those calls resolved "the newest job of this case" — somebody else's, half the
// time it mattered.
//
//   kill        stopped every run's job of that case, and on Nomad every TENANT's (namespace=*)
//   logs/events showed a stranger's output in this run's live panel
//   exec        ran a command INSIDE a stranger's sandbox — a write into a world nobody asked about
//   inspect     described another run's node, phase and events
//   adopt       harvested another run's job and attributed its verdict here, which is a DECISION
//
// Wave B gave every one of them an exact twin and left the originals as a fallback for pre-handle ledger
// rows, forbidden on decision paths by a scan. That arrangement asked every future caller to know which of
// two functions was the safe one, and the answer was never visible at the call site. So the originals are
// deleted: a caller with no handle now gets `unknown` — the postcondition is unestablished, which is the
// honest answer and the one the constitution already requires everywhere else.
//
// This scan is the ratchet. Re-adding any of them — as a "temporary" fallback, a debug helper, a convenience
// for a caller that has not threaded its handle yet — puts the whole class back, because the resolution is
// the defect and the resolution is what a case-id parameter forces.
const FORBIDDEN_METHODS = [
  "adopt",
  "kill",
  "logs",
  "caseEvents",
  "exec",
  "execStream",
  "inspectCase",
  "sampleCase",
] as const;

// A METHOD DECLARATION taking a case id — `async kill(caseId: string)`. Deliberately not a call-site scan:
// the surface is gone, so what has to be refused now is its return, and a declaration is where it returns.
const DECLARATION = new RegExp(`\\b(async )?(${FORBIDDEN_METHODS.join("|")})\\s*\\(\\s*caseId\\s*:`);

// The exact surface that replaced it. Asserted here too, because a ban whose alternative quietly shrank
// would push the next caller straight back to a case id.
const EXACT_METHODS = [
  "adoptWork",
  "killWork",
  "logsForWork",
  "eventsForWork",
  "execInWork",
  "inspectWork",
  "sampleWork",
] as const;

const orchestrators = new URL(".", import.meta.url).pathname;
const managed = ["k8s.ts", "nomad.ts"];

describe("the legacy-case-addressing ratchet — the surface is deleted and does not come back", () => {
  it("no managed backend declares a case-id-addressed control method", () => {
    const offences: string[] = [];
    for (const file of readdirSync(orchestrators).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(join(orchestrators, file), "utf8");
      for (const [index, line] of source.split("\n").entries())
        if (DECLARATION.test(line)) offences.push(`${file}:${index + 1} — ${line.trim()}`);
    }
    expect(
      offences,
      `a case-id-addressed control method is back. It resolves "the newest job of this case", which is another run's whenever two runs of one case are live — use the RuntimeWorkRef twin, and answer \`unknown\` when the caller holds no handle:\n${offences.join("\n")}`,
    ).toEqual([]);
  });

  it("the exact-work surface every managed backend must offer instead is complete", () => {
    for (const file of managed) {
      const source = readFileSync(join(orchestrators, file), "utf8");
      for (const method of EXACT_METHODS)
        expect(source.includes(`async ${method}(`), `${file} does not implement ${method}`).toBe(true);
    }
  });

  it("the capability interfaces the surface hung off are gone too", () => {
    // A live `Recoverable`/`Observable`/`Shellable`/`CaseInspectable`/`CaseSampleable` would let a backend
    // re-declare the methods above under a name this scan's first case does not read, because those
    // interfaces are what made a case-id parameter look like a contract rather than a mistake.
    const contract = readFileSync(join(orchestrators, "../backend.ts"), "utf8");
    for (const iface of ["Recoverable", "Observable", "Shellable", "CaseInspectable", "CaseSampleable"])
      expect(contract.includes(`export interface ${iface} {`), `${iface} is back on the Backend contract`).toBe(false);
  });
});
