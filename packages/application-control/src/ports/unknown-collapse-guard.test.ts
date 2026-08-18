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
  // The handle ledger. An unreadable one made the cancel widen to every run of the case — and its BATCH
  // read (`listForScorecard`) was not watched at all until Wave 3 found it swallowing there too, which is
  // why the pattern is the verb prefix rather than the exact method (arch-review 55).
  /\battempts\??\.list(ForScorecard)?\s*\(/,
  // The receipt ledger. An unreadable one made the child trajectory read serve the clock's answer.
  /\bcaseReceipts\??\.list\s*\(/,
  // The registry lookup behind every managed teardown. An unreadable one certified absence.
  /\bruntimeRegistry\??\.get\s*\(/,
  // CREDENTIAL READS (arch-review 55). Not watched before, and the third review found five swallows the
  // scanner could not see: a secret store that is DOWN and one that holds no such secret are the same `{}`,
  // and the difference decides whether a backend is built with no cluster credential — which then fails auth
  // and reports the failure as the WORK's, not the config read's.
  /\bsecretsFor\s*\(/,
  /\bruntimeSecretsFor\s*\(/,
  // The PUBLICATION ledger (arch-review 55, Wave 5). Its `listForScorecard` answers where the monotonic
  // analysis alias currently stands, and it was read with `.catch(() => undefined)` folded into "a newer
  // settlement is already there" — so a ledger blip made the drain skip its only effect, record nothing, and
  // certify the operation `published`. The debt then left the sweep. Watched so the fold cannot return.
  /\boperations\??\.listForScorecard\s*\(/,
];

// …and the OTHER collapse, which has no read on its line at all: a DECISION reduced to a boolean by its own
// catch (arch-review 55). `resume(...).catch(() => false)` reads as defensive and means "treat every failure,
// including one that only says we could not find out, as the answer this caller's `false` branch takes" — in
// the case that named it, a terminal `failed{INTERRUPTED}` written over a batch whose jobs were still running.
// Matched anywhere, because the subject is the shape, not the port.
const BOOLEAN_COLLAPSE = /\.catch\s*\(\s*\(\s*\)\s*=>\s*(false|true)\s*\)/;

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
  // unresolvable runtime — or an unreadable secret, which is the second entry — means no sample, and no
  // reader acts on the absence of one: the recording's runtime lane is simply shorter. Nothing downstream
  // branches on it. Both lines SKIP the lane rather than continuing with a degraded backend, which is the
  // distinction that matters (a credential-less backend would fail auth and report it as the work's problem).
  ["apps/api/src/composition/dispatch.ts", 2],
  // THE CAPACITY-HINT READ. `runtimeEnvelopeFor` answers a runtime's declared maxConcurrent/memory budget so
  // the scheduler can shape its queue; an unreadable registry drops it to the built-in defaults. That is a
  // throughput degradation, never a claim about what ran, stopped, or was judged.
  ["apps/api/src/composition/services.ts", 1],
  // THE HF WIZARD'S OPTIONAL TOKEN (arch-review 55, surfaced when credential reads joined the scan).
  // `secretsFor` here fetches an OPTIONAL `HF_TOKEN` that upgrades an anonymous Hugging Face lookup to an
  // authenticated one, for an interactive dataset picker. A store failure degrades to the anonymous call:
  // nothing is recorded, no verdict moves, and the user sees the result of a retry.
  //
  // Stated rather than hidden, because it is not perfectly clean: for a GATED dataset the anonymous call
  // answers "not found", so a secret-store outage can present a real dataset as missing. That is a wrong
  // answer shown to a human who can retry — not a wrong fact written into a run's history — which is why it
  // is here and not a defect. If this lookup ever feeds a recorded decision, it leaves this list.
  ["apps/api/src/core/benchmark/benchmark-service.ts", 5],
]);

// Files whose boolean catch is genuinely a preference, not a decision — a probe whose absence changes nothing
// downstream. Same bar as ALLOWED above: it never means "this one is fine".
const BOOLEAN_ALLOWED = new Set<string>([
  // THE APPROVAL NOTIFICATION LEGS. The decision itself is committed durably BEFORE these run; `delivered`
  // and `resumed` are report fields describing whether the waiting turn could be nudged, and a false one
  // costs a notification, never a verdict. The continuation is picked up from the transcript either way.
  "packages/application-control/src/approval/approval-service.ts",
  // FAIL-CLOSED PROBES. Each `false` does LESS, not more: `publishWhen` withholds a publish it cannot prove
  // it may make, `tryAdmit` declines admission an unreachable ledger cannot grant, the judged-flag leaves a
  // case active for re-dispatch, and the absent-check keeps an envelope reserved. The defect this scan is
  // named for is the opposite shape — a `false` that licensed a TERMINAL write (a tombstone) on a failure
  // that only meant "we could not find out".
  "packages/application-control/src/scorecard/recovery-planner.ts",
  "packages/application-control/src/scorecard/scorecard-service.ts",
  "packages/backends/src/scheduling/scheduler.ts",
  "apps/api/src/core/execution/judge-runner.ts",
  // The legacy supersede marker: a diagnostic transition on the lane that has no attempt ledger.
  "apps/api/src/composition/dispatch.ts",
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

  // ── …AND NO DECISION IS REDUCED TO A BOOLEAN BY ITS OWN CATCH (arch-review 55) ────────────────────
  //
  // The scan above needs a watched READ on the line. This one has none: the collapse happens at a call that
  // RETURNS a decision, and the catch supplies the answer. `resume(id, authority).catch(() => false)` is the
  // instance that named it — `false` meant "not faithfully resumable", and the caller wrote a terminal
  // `failed{INTERRUPTED}` over a batch whose managed jobs were still running, because a transient ledger
  // outage had thrown three layers down.
  //
  // Deliberately narrow: only the literal `() => false` / `() => true` form, which is always this mistake.
  // A catch that inspects the error and decides is a caller doing its job.
  it("no decision is answered by its own catch", () => {
    const offences: string[] = [];
    for (const file of files) {
      const relative = file.slice(repoRoot.length);
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (!BOOLEAN_COLLAPSE.test(line)) continue;
        if (BOOLEAN_ALLOWED.has(relative)) continue;
        offences.push(`${relative}:${index + 1} — ${line.trim()}`);
      }
    }
    expect(
      offences,
      `a decision was answered by its own catch. A failure that only says "we could not find out" must not become the caller's \`false\` branch — return the disposition and let the caller name the case:\n${offences.join("\n")}`,
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
