import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── ONE SERIALIZER, OR THE BOUNDARY IS A CONVENTION (arch-review 56, Wave B) ─────────────────────────
//
// A `CaseJob` becomes a dispatch payload by base64-ing it into `EVERDICT_CASE_JOB`, and the harness under
// evaluation runs inside the container that env belongs to. So the payload is, in practice, readable by the
// thing being measured — which is why `caseJobPayload` refuses a case whose grading depends on material the
// agent must not see (an imported task's hidden `tests/` bytes and its verifier credentials).
//
// A refusal in one function is worth nothing if the next lane hand-rolls the same two lines. Both existing
// backends did exactly that, independently, with the same expression — which is how the disclosure came to
// exist in two places at once and be reviewed as one. The scanner is the part that survives the next lane.
//
// WHAT IS SCANNED: any construction of the job payload that does not go through the one function. Matched on
// the env name, because that is the thing a new backend copies from an old one.
// The VALUE is inspected rather than lookahead-matched. The first draft was
// `/EVERDICT_CASE_JOB\s*:\s*(?!caseJobPayload\()/`, and `\s*` happily matched zero characters so the
// lookahead landed on the leading space and every compliant line "matched" — a scanner green over compliance
// and red over nothing. Verified by reverting a lane, which is the rule this guard exists under.
const ASSIGNMENT = /EVERDICT_CASE_JOB\s*:(.*)$/;
const buildsItsOwn = (line: string): boolean => {
  const value = ASSIGNMENT.exec(line)?.[1];
  return value !== undefined && !value.trim().startsWith("caseJobPayload(");
};

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

describe("every dispatch lane builds its payload through the one serializer", () => {
  const root = join(__dirname);

  it("finds no backend serializing a CaseJob itself", () => {
    const offenders: string[] = [];
    for (const file of sourcesUnder(root)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.trimStart().startsWith("//")) return;
          if (buildsItsOwn(line)) offenders.push(`${file.slice(root.length + 1)}:${index + 1}  ${line.trim()}`);
        });
    }
    expect(
      offenders,
      [
        "a lane builds the EVERDICT_CASE_JOB payload itself. The job is readable by the harness that runs in",
        "the container it is set on, so the ONE serializer (`caseJobPayload`, @everdict/contracts) refuses a",
        "case whose grading depends on material the agent must not see. A hand-rolled `JSON.stringify(job)`",
        "silently re-opens that — which is how the same disclosure came to exist in two backends at once.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("is watching a directory that contains the lanes", () => {
    // Without this, a moved path reports zero offenders forever — indistinguishable from a clean tree, and
    // the exact way `suite.md` and `workspace-integrations.md` went dead before the convention harness.
    const files = sourcesUnder(root);
    expect(files.some((f) => f.endsWith("k8s.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("nomad.ts"))).toBe(true);
  });
});
