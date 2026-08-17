import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE STRUCTURAL HALF OF "UNKNOWN IS FIRST-CLASS" (arch-review 53, Wave A.5) ───────────────────────
//
// Wave A.5 gave the authority reads a three-valued answer and taught their callers to refuse on `unknown`.
// That is call-site discipline, and this codebase has now watched call-site discipline fail invisibly four
// times — which is what the fence scanners exist for. The failure mode here is one line:
//
//     const rows = await ledger.list(id).catch(() => []);
//
// It compiles, it reads as defensive, and it silently converts "the ledger is down" into "the ledger is
// empty". Downstream, the same three consequences every time: a teardown widens to the case-id kill, an
// evidence read falls back to the writer's clock, a fold over zero answers certifies that live work is gone.
// Every instance this program removed was ADDED deliberately, by someone reasoning that an unreadable ledger
// and an empty one amount to the same thing. They do not, and a comment saying so is what the next session
// will write too, unless the tree refuses.
//
// WHAT IS SCANNED: reads of the ledgers a DECISION rests on, by the name of the port method. Not every store
// call — a list endpoint that should become a 500 may throw freely, and wrapping those would be ceremony
// that teaches nothing.
const WATCHED_READS = [
  // The handle ledger. An unreadable one made the cancel widen to every run of the case.
  /\battempts\??\.list\s*\(/,
  // The receipt ledger. An unreadable one made the child trajectory read serve the clock's answer.
  /\bcaseReceipts\??\.list\s*\(/,
  // The registry lookup behind every managed teardown. An unreadable one certified absence.
  /\bruntimeRegistry\??\.get\s*\(/,
];

// A swallow: `.catch(() => [])`, `.catch(() => undefined)`, `.catch(() => ({}))`, and the `?? []` that
// follows an awaited catch. Matched on the same LINE as the read, which is how every instance was written.
const SWALLOW = /\.catch\s*\(\s*\(\s*\)\s*=>\s*(\[\s*\]|undefined|\(\{\s*\}\)|\{\s*\})\s*\)/;

// GETTING ON THE ALLOWLIST means the caller genuinely does not decide on the answer — it is diagnostics, or a
// path whose fallback is provably safe and stated. It never means "this one is fine".
//
// ONE ENTRY WAS DELETED RATHER THAN REWORDED (arch-review 54, Phase 2) — the adoption lane, admitted with:
//
//     "An unresolvable lane there falls back to RE-DISPATCH, which spends compute but cannot produce a wrong
//      verdict, and `AdoptOutcome.unknown` already carries the doubt for the case that matters."
//
// Both halves were false. A second physical attempt of one execution bills twice, calls the provider twice,
// writes competing evidence, and re-fires any external side effect the harness has; and the doubt `unknown`
// carried was discarded by the caller, which is the thing the entry asserted could not happen. An allowlist
// entry is a place the TYPE failed to say it — so the fix was the union (`AdoptionDecision`), not the exemption.
//
// The two that remain are reads whose callers genuinely decide nothing, and each says why.
const ALLOWED = new Map<string, number>([
  // THE LIVE-METRICS SAMPLER. `sampleCaseRuntime` reads a case's current cpu/memory for a progress panel. An
  // unresolvable runtime means no sample, and no reader acts on the absence of one — the recording's runtime
  // lane is simply shorter. Nothing downstream branches on it.
  ["apps/api/src/composition/dispatch.ts", 1],
  // THE CAPACITY-HINT READ. `runtimeEnvelopeFor` answers a runtime's declared maxConcurrent/memory budget so
  // the scheduler can shape its queue; an unreadable registry drops it to the built-in defaults. That is a
  // throughput degradation, never a claim about what ran, stopped, or was judged.
  ["apps/api/src/composition/services.ts", 1],
]);

const ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage", ".turbo"]);

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("the unknown-collapse scanner — a failed authority read never becomes an empty one", () => {
  const files = ROOTS.flatMap((root) => walk(join(repoRoot, root), []));

  it("no authority read swallows its failure into an empty answer", () => {
    const offences: string[] = [];
    for (const file of files) {
      const relative = file.slice(repoRoot.length);
      const lines = readFileSync(file, "utf8").split("\n");
      let found = 0;
      for (const [index, line] of lines.entries()) {
        // A COMMENT IS NOT A CALL. Quoting the removed idiom to explain why it was removed is exactly what
        // the case law asks for, and flagging it taught the opposite: the only entry this scanner's
        // allowlist ever held was a comment describing the very defect the guard exists to prevent
        // (arch-review 54, Phase 2). Prose cannot swallow a read.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (!WATCHED_READS.some((re) => re.test(line))) continue;
        if (!SWALLOW.test(line)) continue;
        found++;
        if (found <= (ALLOWED.get(relative) ?? 0)) continue;
        offences.push(`${relative}:${index + 1} — ${line.trim()}`);
      }
    }
    expect(
      offences,
      `an authority read swallows its failure into an empty answer. Use the port's three-valued read (\`ReadResult\`, @everdict/contracts) and REFUSE on unknown — an unreadable ledger is not an empty one:\n${offences.join("\n")}`,
    ).toEqual([]);
  });

  it("the scanner is still watching reads that exist", () => {
    // A scanner whose patterns match nothing passes forever. This asserts the watched reads are real call
    // sites in the tree — the same self-check the fence scanners carry, for the same reason.
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const re of WATCHED_READS)
      expect(re.test(all), `${re} matches nothing — the scanner is scanning a read that no longer exists`).toBe(true);
  });

  it("the allowlisted file still exists", () => {
    for (const relative of ALLOWED.keys())
      expect(
        files.some((f) => f.slice(repoRoot.length) === relative),
        `${relative} is allowlisted and gone — a stale allowlist is an unenforced rule`,
      ).toBe(true);
  });
});
