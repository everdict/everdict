import { describe, expect, it } from "vitest";
import { CaseResultSchema, UntrustedCaseResultSchema } from "./eval-case.js";

// ── [R121 COUNTEREXAMPLE] A PRODUCER MAY NOT NAME AN OBJECT FOR US TO SIGN ──────────────────────────
//
// `EnvSnapshot` carries `screenshotRef` / `domRef`, and the platform mints them: `offloadSnapshot` puts the
// bytes and replaces the field with `artifact://<key>`. On the way back out `refreshSnapshotRefs` calls
// `publicUrlFor(ref)`, which re-signs THAT KEY into a browser-facing presigned URL.
//
// `EnvSnapshot` sits on `CaseResult`, which is the document a producer submits: a self-hosted runner's
// `submit_job_result`, and the `__EVERDICT_RESULT__` stdout sentinel a dispatched job prints. So a runner
// could name any key in the bucket and be handed a signed URL for it — and the artifact bucket is ONE bucket
// for the deployment (`EVERDICT_S3_BUCKET`), which makes it cross-workspace.
//
// It is worse than the trace-ref case this rule was written for: a presigned URL is fetchable directly, so it
// does not merely bypass `runs:read` — it leaves our authorization behind entirely.
//
//     the ref parses            ≠   the platform minted it
//     the caller may read this record   ≠   the caller may read what its refs point at
//
// The rule is narrow on purpose: `artifact://` is OUR scheme, so a producer may not hand us one. A local path
// (`/tmp/shot.png`, which os-use legitimately reports from inside the compute) is not a coordinate over our
// storage and survives untouched — `publicUrlFor` already ignores it.
//
// Seen RED before the split: "a producer-named artifact key survived into the record we sign".
const FORGED = "artifact://scorecards/another-workspace-scorecard/case-1.png";

const forgedResult = (screenshotRef: string) => ({
  caseId: "c1",
  harness: "h@1.0.0",
  snapshot: { kind: "browser", url: "u", dom: "d", screenshotRef, console: [] },
  trace: [],
  scores: [],
});

describe("[R121 COUNTEREXAMPLE] the untrusted case result drops artifact coordinates", () => {
  it("strips a producer-supplied artifact ref from the snapshot", () => {
    const parsed = UntrustedCaseResultSchema.safeParse(forgedResult(FORGED));
    expect(parsed.success, "a legitimate result was refused along with its forged field").toBe(true);
    const snapshot = parsed.success ? (parsed.data.snapshot as Record<string, unknown>) : {};
    expect(snapshot.screenshotRef, "a producer-named artifact key survived into the record we sign").toBeUndefined();
  });

  it("leaves a LOCAL path alone — this is a scheme rule, not a field ban", () => {
    // os-use reports the path the screenshot was captured at inside the compute. It names nothing in our
    // object store, `publicUrlFor` already ignores it, and dropping it would lose a producer's own report.
    const parsed = UntrustedCaseResultSchema.safeParse(forgedResult("/tmp/screenshots/final.png"));
    expect(parsed.success).toBe(true);
    const snapshot = parsed.success ? (parsed.data.snapshot as Record<string, unknown>) : {};
    expect(snapshot.screenshotRef, "a producer's own local path was thrown away").toBe("/tmp/screenshots/final.png");
  });

  it("the STORED schema still carries the ref — a split, not a deletion", () => {
    // This is what reads back what WE wrote. If it stopped carrying the ref, every offloaded screenshot and
    // DOM would become unreachable, which is the opposite failure.
    const stored = CaseResultSchema.safeParse(forgedResult(FORGED));
    expect(stored.success).toBe(true);
    expect((stored.success ? (stored.data.snapshot as Record<string, unknown>) : {}).screenshotRef).toBe(FORGED);
  });
});
