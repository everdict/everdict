import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE STRUCTURAL HALF OF "UNKNOWN IS STATED ABSENT, NEVER FABRICATED AS 0" (review 46) ─────────────
//
// A physical attempt's coordinate is `<executionId>#g<generation>` (`attemptIdOf`), and the ledger mints the
// first generation as 1 — so `#g0` names an attempt that cannot exist. That did not make it harmless. It made
// it a SHARED name: every attempt that failed to open a generation fell back to the same `?? 0`, so every one
// of them addressed the identical object key, receipt field and trajectory row. An object store has no
// compare-and-set, which means the collision resolves by overwrite — the stale attempt's snapshot lands on the
// bytes the winner's result already points at. That is arch-review 38's P0, and it came back three times
// through this one fallback because each site spelled it locally and each spelling looked like a default.
//
// The fallback also silently killed the guards written for it: `finalizeCaseAttempt`'s own "unknown generation
// ⇒ no attemptId on the receipt" branch was DEAD CODE for as long as its caller passed 0, because 0 is not
// undefined. A sentinel does not just lie downstream; it disarms the code that was watching for the truth.
//
// THE CORRECT SHAPE, everywhere: a coordinate this process does not know is OMITTED — a conditional spread
// (`...(gen !== undefined ? { generation: gen } : {})`) or a ternary to `undefined`. "Not stated" is a fact a
// reader can act on. An invented coordinate is one they cannot tell from a real one.
//
// GETTING ON THE ALLOWLIST would mean 0 is the value the domain actually means here — which is why the
// allowlist is empty, and why it should stay that way. The fail-closed producer sentinel (a job stamping
// `recordingGeneration ?? 0` into the recording store, where the fence REFUSES 0) is not an identity and is
// not written as one: it is a positional argument to a producer's append, so no rule below reaches it.
const ALLOWED = new Set<string>([]);

const SCAN_ROOTS = ["apps", "packages"];
const EXCLUDED = [/\.test\.ts$/, /\/dist\//, /node_modules/];

// ① THE ARGUMENT SPAN of the two calls that MINT an identity. Paren-balanced rather than line-based, because
//    the shape that shipped the defect wrapped across lines under the formatter
//    (`attemptId: attemptIdOf(\n  executionId,\n  winnerGeneration ?? 0,\n)`), and a line-scoped rule reads
//    that as three innocent lines. Whatever a caller computes elsewhere, a sentinel reaching the mint is a
//    fabricated coordinate by the time it gets here.
const IDENTITY_CALL = /\b(?:attemptIdOf|openPhysicalAttempt)\(/g;
// `?? 0` and its stringly twin `?? "0"` — the second exists because a coordinate is a string by the time it
// is written, and the fallback follows the value into that form.
const SENTINEL = /\?\?\s*"?0"?/;

// ② THE PROPERTY FORMS, wherever they appear. The mint is not the only place the number travels: it is
//    written onto the pending-settle entry, the receipt input and the evidence call long before anything
//    calls `attemptIdOf`, and defaulting it THERE fabricates the same coordinate one indirection earlier.
//    The value may not cross a property boundary (`,` `;` `{` `}` are excluded), so a match is always one
//    property's own value — a newline inside it is fine, a comma is the end of it.
const GENERATION_DEFAULT = /\bgeneration\s*:\s*[^,;{}]*\?\?\s*"?0"?/;
// ANY fallback for `attemptId`, not just 0: this one is a string, so the sentinel wears whatever the author
// reached for (`?? ""`, `?? executionId`). All of them answer "which attempt produced this" with something no
// attempt is named, which is the property being defended — the field is optional precisely so it can be left
// out.
const ATTEMPT_ID_DEFAULT = /\battemptId\s*:\s*[^,;{}]*\?\?/;

// ③ THE SENTINEL BOUND TO A LOCAL, one line above the mint. This is not a variation — it is how the defect
//    was written in `run-service` (`const attempt = this.attempt.get(id) ?? 0;` … `attemptIdOf(id, attempt)`),
//    and rules ① and ② are both blind to it: the argument span holds a bare identifier, and there is no
//    property literal anywhere. A guard that catches a defect in two of the three files it shipped in is a
//    guard that certifies the third.
//
//    Deliberately the narrowest data-flow question that answers it: a local DEFAULTED to 0, whose name says
//    it carries this coordinate, and which is then handed to a mint IN THE SAME FILE. All three conditions
//    are load-bearing. Without the name, `const epoch = … ?? 0` trips — and 0 is a real epoch (absent is
//    zero, not unfenced), so the rule would need an allowlist on its first run, which is the point at which
//    a rule stops being one. Without the usage check, the live `const generation = … ?? 0` that feeds the
//    RECORDING seal trips — and 0 is a real recording generation (the recording plane's first attempt is 0;
//    it is the ATTEMPT LEDGER that starts at 1, which is the whole reason `#g0` names nothing).
const SENTINEL_LOCAL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*[^;\n]*\?\?\s*"?0"?/g;
const CARRIES_COORDINATE = /attempt|generation/i;

// WHOSE `generation` THIS IS. The word names two unrelated ordinals in this codebase: the physical attempt's,
// and the JUDGMENT CLAIM's rotation counter (`orchestrator/activities.ts`, mig 0158/0159), where `?? 0` is
// correct — rotation 0 is the un-rotated first pass, a real value the fence arbitrates on. A rule that could
// not tell them apart would have to be deleted the first time it was pointed at the scoring plane.
//
// So the property rules only apply in files that speak the PHYSICAL attempt's vocabulary. A file that mints
// attempt ids, opens attempts, or carries a recording generation is talking about this ordinal; one that does
// none of those is talking about some other one, and this guard has nothing to say about it.
const SPEAKS_PHYSICAL_ATTEMPT = /\b(?:attemptIdOf|openPhysicalAttempt|PhysicalAttempt|recordingGeneration)\b/;

// Comment text is not code — this file's neighbours discuss `?? 0` at length, on purpose, including in the
// comments that explain why it was removed.
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

// Each call's own argument span, by balancing parentheses from the opening one.
function callSpans(code: string, opening: RegExp): string[] {
  const spans: string[] = [];
  for (const match of code.matchAll(opening)) {
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

// The whole rule, applied to one file's text. Kept as a function over (rel, text) so the tests below can put
// the exact offending shapes in front of it: this guard's defects were all fixed before it existed, and a
// scanner nobody has ever seen fail is a scanner nobody has evidence works.
function fabricatedIdentitiesIn(rel: string, text: string): string[] {
  const code = codeOf(text);
  const spans = callSpans(code, IDENTITY_CALL);
  const found: string[] = [];
  for (const span of spans) {
    if (SENTINEL.test(span)) found.push(`${rel}: sentinel inside an identity call — ${span.replace(/\s+/g, " ")}`);
  }
  for (const declaration of code.matchAll(SENTINEL_LOCAL)) {
    const name = declaration[1];
    if (name === undefined || !CARRIES_COORDINATE.test(name)) continue;
    // The bare identifier, not a property access on something that shares its name: `attempt.generation`
    // inside a mint is the ATTEMPT's own number, which is the correct shape, and reading it as a use of the
    // defaulted local would flag the fix as the defect.
    const passed = new RegExp(`(?<![.\\w$])${name}(?![\\w$.])`);
    const mint = spans.find((span) => passed.test(span));
    if (mint !== undefined)
      found.push(`${rel}: \`${name}\` defaulted to 0, then minted — ${mint.replace(/\s+/g, " ")}`);
  }
  if (!SPEAKS_PHYSICAL_ATTEMPT.test(code)) return found;
  for (const line of code.split("\n")) {
    if (GENERATION_DEFAULT.test(line)) found.push(`${rel}: generation defaulted to 0 — ${line.trim()}`);
    if (ATTEMPT_ID_DEFAULT.test(line)) found.push(`${rel}: attemptId given a fallback — ${line.trim()}`);
  }
  return found;
}

function tsFilesUnder(dir: string, prefix: string): string[] {
  if (prefix.endsWith("/dist") || prefix.endsWith("/node_modules")) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(full).isDirectory()) return tsFilesUnder(full, rel);
    if (!name.endsWith(".ts") || EXCLUDED.some((re) => re.test(rel))) return [];
    return [rel];
  });
}

describe("identity-sentinel guard — an unknown attempt is stated absent, never fabricated as generation 0", () => {
  const root = join(__dirname, "../../../..");
  const scanned = SCAN_ROOTS.flatMap((r) => tsFilesUnder(join(root, r), r)).filter((rel) => !ALLOWED.has(rel));
  const files = scanned.map((rel) => ({ rel, code: codeOf(readFileSync(join(root, rel), "utf8")) }));

  it("no production path invents an attempt coordinate for an attempt it cannot name", () => {
    const offenders = files.flatMap(({ rel }) => fabricatedIdentitiesIn(rel, readFileSync(join(root, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  // A file that speaks the physical attempt's vocabulary, which is the condition the property rules are
  // qualified by. Written as an import so the fixture reads like the module it stands for and so the marker
  // itself is not a call site.
  const attemptFile = (body: string): string => `import { attemptIdOf } from "@everdict/contracts";\n${body}\n`;

  it("the rule fires on the shapes it was written for — the defect, in the spelling it shipped in", () => {
    // The sites review 46 removed, verbatim. A guard whose failure nobody has witnessed is a guard that may
    // already be matching nothing, and this codebase has shipped two of those. These four ran green here for
    // as long as they existed; the fifth check below is the one the live tree actually failed on.
    expect(
      fabricatedIdentitiesIn(
        "f.ts",
        attemptFile("const x = { attemptId: attemptIdOf(executionId, winnerGeneration ?? 0) };"),
      ),
    ).toHaveLength(1);
    expect(
      fabricatedIdentitiesIn("f.ts", attemptFile("pending.push({ executionId, generation: winnerGeneration ?? 0 });")),
    ).toEqual(["f.ts: generation defaulted to 0 — pending.push({ executionId, generation: winnerGeneration ?? 0 });"]);
    expect(
      fabricatedIdentitiesIn("f.ts", attemptFile('const k = attemptIdOf(id, this.attempt.get(id) ?? "0");')),
    ).toHaveLength(1);
    expect(
      fabricatedIdentitiesIn("f.ts", attemptFile("const a = { attemptId: opened.attemptId ?? executionId };")),
    ).toEqual(["f.ts: attemptId given a fallback — const a = { attemptId: opened.attemptId ?? executionId };"]);
    // …across lines too, which is how the formatter had left the longest of them.
    expect(
      fabricatedIdentitiesIn(
        "f.ts",
        attemptFile("await openPhysicalAttempt(deps, {\n  executionId,\n  generation: gen ?? 0,\n});"),
      ),
    ).not.toEqual([]);
    // THE ONE THE LIVE TREE FAILED ON (arch-review 46, found by this scanner): the caller of
    // `assembleCaseEvidence` defaulted an absent generation to 0, and the snapshot offload three lines into
    // that method keys the object as `attempts/<executionId>#g0` with no `unisolated` gate in front of it —
    // so two unisolated attempts of one case shared one key, which is arch-review 38's P0 restored through a
    // fallback. The comment above it asserted the opposite ("0 is a real generation; unknown is unisolated"),
    // which is exactly why a structural rule and not a reviewer had to be the one to notice.
    expect(
      fabricatedIdentitiesIn(
        "f.ts",
        attemptFile(
          "await this.assembleCaseEvidence(covered, {\n  executionId: input.executionId,\n  generation: input.generation ?? 0,\n});",
        ),
      ),
    ).toEqual(["f.ts: generation defaulted to 0 — generation: input.generation ?? 0,"]);
  });

  it("the sentinel bound to a local one line above the mint is the same defect", () => {
    // `run-service`'s spelling of it, verbatim from before review 46 — the one rules ① and ② cannot see.
    const bound = "const attempt = this.attempt.get(id) ?? 0;\nconst key = `attempts/${attemptIdOf(id, attempt)}`;";
    expect(fabricatedIdentitiesIn("run-service.ts", bound)).toEqual([
      "run-service.ts: `attempt` defaulted to 0, then minted — (id, attempt)",
    ]);
    // …and the three conditions that keep it from becoming a rule with an allowlist. A defaulted local that
    // never reaches a mint is not a fabricated identity — the live `const generation = … ?? 0` feeding the
    // RECORDING seal is exactly this, and 0 is a real generation to that store.
    expect(
      fabricatedIdentitiesIn(
        "f.ts",
        attemptFile("const generation = this.attempt.get(id) ?? 0;\nawait store.seal(id, meta, generation);"),
      ),
    ).toEqual([]);
    // A local whose name says it carries some OTHER ordinal is not this guard's business: `driverEpoch: epoch`
    // reaches `openPhysicalAttempt` in two live files, and an absent epoch really is 0 (absent, not unfenced).
    expect(
      fabricatedIdentitiesIn(
        "f.ts",
        "const epoch = this.driver.get(id) ?? 0;\nawait openPhysicalAttempt(deps, { executionId, driverEpoch: epoch });",
      ),
    ).toEqual([]);
    // …and the correct shape, which passes the ATTEMPT's own number rather than a defaulted stand-in.
    expect(
      fabricatedIdentitiesIn(
        "f.ts",
        attemptFile("const attempt = await open();\nconst k = attemptIdOf(id, attempt.generation);"),
      ),
    ).toEqual([]);
  });

  it("the rule stays off the shapes that are correct", () => {
    // Stated absent — the conditional spread and the ternary to `undefined`, which is what the fix installed.
    expect(
      fabricatedIdentitiesIn(
        "f.ts",
        attemptFile("x = { ...(gen !== undefined ? { attemptId: attemptIdOf(id, gen) } : {}) };"),
      ),
    ).toEqual([]);
    expect(
      fabricatedIdentitiesIn("f.ts", attemptFile("const a = gen === undefined ? undefined : attemptIdOf(id, gen);")),
    ).toEqual([]);
    // The FAIL-CLOSED PRODUCER SENTINEL is not an identity: a job stamping into the recording store passes 0
    // positionally so the recording fence can refuse it (`open-physical-attempt.ts`). Banning that would be
    // this guard asking for the opposite of the behaviour it is defending.
    expect(
      fabricatedIdentitiesIn("f.ts", attemptFile("await record(runId, entry, job.recordingGeneration ?? 0);")),
    ).toEqual([]);
    // Absence written as SQL NULL is the same statement in the store's language.
    expect(
      fabricatedIdentitiesIn("f.ts", attemptFile("const p = [receipt.attemptId ?? null, receipt.generation ?? null];")),
    ).toEqual([]);
  });

  it("the other ordinal called `generation` is left alone — the qualifier is the whole reason it can be", () => {
    // The judgment claim's ROTATION counter (`orchestrator/activities.ts`, mig 0158/0159). `?? 0` there is a
    // real value the fence arbitrates on, in a file that never speaks of a physical attempt — and it is live
    // code today, so a rule without this qualifier would have to be deleted the first time it ran.
    const claim = "const claim = { generation: input.generation ?? 0, attempt };";
    expect(fabricatedIdentitiesIn("activities.ts", claim)).toEqual([]);
    // …and the qualifier is a filter on WHICH ordinal, not a hole to hide in: the identical line in a file
    // that mints attempt ids is the defect.
    expect(fabricatedIdentitiesIn("f.ts", attemptFile(claim))).toHaveLength(1);
  });

  it("the scanner still matches the call sites it is meant to watch", () => {
    // A structural guard that quietly stops finding its subject reports green forever. Both spellings are
    // counted, and the walk is checked for the layer a package-scoped glob would lose: the composition root
    // in `apps/api` opens attempts too, and it is where an earlier review's P0 was hiding.
    const spans = files.flatMap(({ code }) => callSpans(code, IDENTITY_CALL));
    expect(spans.length).toBeGreaterThan(10);
    expect(files.some(({ code }) => /\battemptIdOf\(/.test(code))).toBe(true);
    expect(files.some(({ code }) => /\bopenPhysicalAttempt\(/.test(code))).toBe(true);
    expect(scanned.some((rel) => rel.startsWith("apps/api/"))).toBe(true);
    // …and the vocabulary qualifier is a filter, not a mute button: the files carrying the property forms are
    // in scope. If this drops to zero, the property rules have stopped applying to anything.
    expect(files.filter(({ code }) => SPEAKS_PHYSICAL_ATTEMPT.test(code)).length).toBeGreaterThan(5);
  });
});
