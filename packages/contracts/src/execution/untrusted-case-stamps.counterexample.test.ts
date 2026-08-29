import { describe, expect, it } from "vitest";
import { CaseResultSchema, UntrustedCaseResultSchema } from "./eval-case.js";

// ── [R122 COUNTEREXAMPLE] A PRODUCER MAY NOT STAMP THE CONTROL PLANE'S OWN FACTS ────────────────────
//
// `CaseResult` is the MEASUREMENT — what the agent did — and it is parsed from two producer surfaces: a
// self-hosted runner's `submit_job_result`, and the `__EVERDICT_RESULT__` sentinel printed by the job-runner
// container, whose image a workspace supplies (`RuntimeSpec.image`, "job-runner image (tenant registry)").
//
// Two of its fields are the platform's own statements about that measurement:
//
//   provenance   "stamped by the control plane at dispatch" (schema), "stamped by SelfHostedBackend as the
//                runner owner" (billing) — and it DECIDES WHO PAYS.
//   verifier     "Sealed by `verifierReceiptOf` at the invocation" — the private verifier's receipt, which
//                is constitutional evidence and carries the attempt ids a settlement joins on.
//
// The self-hosted lane overwrites provenance (`{...result, provenance: {...}}`), so that door was safe by
// accident of order. The MANAGED lane never touches it: `placement-image` rewrites `execution` and nothing
// else. One lane learned, its sibling did not.
//
// What that buys an attacker, through billing:
//
//   { ranOn: "self-hosted", by: "anything" }   → billingTenant() = undefined → the case is never charged,
//                                                never metered, and consumes no budget
//   { ranOn: "self-hosted", by: "ws:victim" }  → the victim workspace is charged, and its enforcement
//                                                budget is drained — denial of their evaluations
//
// ⚠️ THE FILE ALREADY CONTAINS THIS LAW. Twenty lines above `verifier`, an arch-review 66 comment explains
// why the cleanup coordinate was REMOVED from this schema, and its second bullet is verbatim the mechanism
// here: "`submit_job_result` parses a self-hosted runner's JSON with this schema, so a workspace-controlled
// runner could name the objects a settlement would delete." The lesson was written down and two fields below
// it two more platform facts kept riding on the producer's document.
//
// `traceSealed` is deliberately NOT stripped: its own comment says the distinction exists "unless the
// PRODUCER says so", which makes it a producer vouch rather than a platform stamp.
//
// Seen RED before the split:
//   "a producer stamped the control plane's billing provenance: expected { ranOn: 'self-hosted', … } to be undefined"
const forged = () => ({
  caseId: "c1",
  harness: "h@1.0.0",
  snapshot: { kind: "prompt", output: "" },
  trace: [],
  scores: [],
  traceSealed: true,
  judgmentsSealed: true,
  provenance: { ranOn: "self-hosted", by: "ws:victim-workspace", attestation: "managed" },
  verifier: {
    planDigest: "sha256:p",
    workspaceDigest: "sha256:w",
    scores: [],
    scoreDigest: "sha256:s",
    complete: true,
  },
});

describe("[R122 COUNTEREXAMPLE] the untrusted case result drops the platform's own stamps", () => {
  it("strips a producer-authored billing provenance", () => {
    const parsed = UntrustedCaseResultSchema.safeParse(forged());
    expect(parsed.success, "a legitimate result was refused along with its forged stamp").toBe(true);
    expect(
      parsed.success ? parsed.data.provenance : "unparsed",
      "a producer stamped the control plane's billing provenance",
    ).toBeUndefined();
  });

  it("strips a producer-authored verifier receipt", () => {
    const parsed = UntrustedCaseResultSchema.safeParse(forged());
    expect(
      parsed.success ? parsed.data.verifier : "unparsed",
      "a producer minted the private verifier's own receipt",
    ).toBeUndefined();
  });

  it("strips a producer-claimed judgment seal — silence may not wear the claim", () => {
    // `ScoringService` sets this only when judges actually ran, because "a blanket `true` would turn silence
    // into evidence" — its own words. A producer sending it IS that silence, and `evidenceStatusOf` reads it
    // as `complete`.
    const parsed = UntrustedCaseResultSchema.safeParse(forged());
    expect(
      parsed.success ? parsed.data.judgmentsSealed : "unparsed",
      "a producer claimed its judgments were sealed",
    ).toBeUndefined();
  });

  it("keeps `traceSealed` — that one IS the producer's vouch, and this is not a field sweep", () => {
    const parsed = UntrustedCaseResultSchema.safeParse(forged());
    expect(
      parsed.success ? parsed.data.traceSealed : undefined,
      "a producer's own evidence vouch was thrown away",
    ).toBe(true);
  });

  it("the STORED schema still carries both — a split, not a deletion", () => {
    const stored = CaseResultSchema.safeParse(forged());
    expect(stored.success).toBe(true);
    expect(stored.success ? stored.data.provenance?.by : undefined).toBe("ws:victim-workspace");
  });
});
