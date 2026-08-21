import { MANIFEST_IDENTITY_VERSION, imageResolved } from "@everdict/contracts";
import type { CaseResult, ProvisionedWorldProof, ScorecardManifest } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { experimentIdentity } from "./experiment-identity.js";

// ── THE SAME IMAGE IS NOT THE SAME WORLD (arch-review 59 P1-high) ────────────────────────────────────
//
// `execution_world` is the axis that says a delta was measured in one box. It compared image BYTES and
// nothing else, so two sides could hold the axis while one ran with a GPU and the other without, or one
// behind a deny-all egress policy and the other online. Those are different worlds by this repo's own
// definition — `worldProofCovers` refuses an inexact match on exactly these fields on the way IN — and a
// regression measured across them is not evidence about the change under test, which is the only claim this
// axis makes.
//
// The evidence existed and had no reader. The lane attests what it enforced, the in-container driver refuses
// a declaration that attestation does not cover, and then nobody wrote it down: `ExecutionManifest` recorded
// the image and stopped. So this change is two halves — record the attested world where the manifest is
// written, and compare it where the axis is read — and either alone is inert.
//
// Recorded rather than declared, deliberately: the case's `resources`/`network` are what was ASKED for, and
// stamping a request as proof is the failure rule `protocol` names in full. What lands here is what the lane
// said it applied and the driver already checked.
//
// Seen RED before the axis read the world, observed:
//   a GPU on one side and none on the other held the execution_world axis: expected [ 'execution_world' ]
//   to not contain 'execution_world'
//
// …and the rollout half, which is the one that would have quietly re-judged history:
//   a pair that recorded no world at all changed its answer: expected [] to deeply equal [ 'execution_world' ]

// The PRODUCTION seal shape, identical on both sides, so every other axis holds and whatever this file
// observes is about the world alone (rule `testing`: a hand-built fixture asserts against a shape no
// production path emits).
const MANIFEST: ScorecardManifest = {
  identityVersion: MANIFEST_IDENTITY_VERSION,
  dataset: { id: "bench", version: "7.0.0", digest: "sha256:composite" },
  cases: { c1: "sha256:case-c1" },
  grading: "sha256:grading",
  harness: { id: "agent", version: "1.0.0", specDigest: "sha256:hhhh" },
};

const world = (over: Partial<ProvisionedWorldProof> = {}): ProvisionedWorldProof => ({
  os: "linux",
  enforcedBy: "k8s",
  resources: { cpu: 2000, memoryMb: 4096 },
  ...over,
});

// A case that pinned the SAME image bytes on both sides — so the image half of the axis is satisfied and
// whatever this test observes is about the rest of the box.
const caseWith = (w?: ProvisionedWorldProof): CaseResult =>
  ({
    caseId: "c1",
    harness: "h@1",
    trace: [],
    scores: [],
    execution: {
      os: "linux",
      osResolved: "declared",
      manifestVersion: 2,
      // Built by the PRODUCTION constructor, not by hand — a hand-shaped provenance asserts against a value
      // no lane emits, and `sameResolvedImages` reads a field my first fixture did not have.
      imageProvenance: imageResolved([{ ref: "ghcr.io/x/y:1", digest: "sha256:same" }], "ref"),
      ...(w ? { world: w } : {}),
    },
  }) as unknown as CaseResult;

const axisOf = (b: CaseResult, c: CaseResult) =>
  experimentIdentity(MANIFEST, MANIFEST, { baseline: [b], candidate: [c] });

describe("[R59 COUNTEREXAMPLE] the execution_world axis compares the box, not only the image", () => {
  it("HOLDS when the two sides were placed in the same attested world", () => {
    // The control. Without this the assertions below could be passing because the axis stopped holding for
    // some unrelated reason, which is a green about a different question.
    const id = axisOf(caseWith(world()), caseWith(world()));
    expect(id.held).toContain("execution_world");
    expect(id.confounds).toHaveLength(0);
  });

  it("is a CONFOUND when one side had a GPU and the other did not", () => {
    const id = axisOf(caseWith(world()), caseWith(world({ resources: { cpu: 2000, memoryMb: 4096, gpu: 1 } })));
    expect(id.held, "a GPU on one side and none on the other held the execution_world axis").not.toContain(
      "execution_world",
    );
    expect(id.confounds.map((c) => c.axis)).toContain("execution_world");
  });

  it("is a CONFOUND when one side ran offline and the other online", () => {
    // The axis that changes what a task can DO, not merely how fast. A benchmark whose baseline could reach
    // the network and whose candidate could not is measuring the network, whatever else it reports.
    const id = axisOf(
      caseWith(world({ network: { mode: "none", allowedHosts: [] } })),
      caseWith(world({ network: { mode: "public", allowedHosts: [] } })),
    );
    expect(id.confounds.map((c) => c.axis)).toContain("execution_world");
  });

  it("is a CONFOUND across two different enforcement lanes", () => {
    // "nomad enforced 2 cpu" and "k8s enforced 2 cpu" are two mechanisms with different semantics. Comparing
    // across them is comparing across them, whether or not the numbers agree.
    const id = axisOf(caseWith(world()), caseWith(world({ enforcedBy: "nomad" })));
    expect(id.confounds.map((c) => c.axis)).toContain("execution_world");
  });

  it("is a CONFOUND when the two sides ran under different ISOLATION runtimes", () => {
    // `enforcedBy: "k8s"` reads identically for a pod under gVisor and one under the shared-kernel default,
    // so the axis held across a difference that changes what the workload could do — and it is the axis
    // `assertHardenedIsolation` polices, so a comparison blind to it cannot see whether both sides were
    // measured under the isolation their tenant is owed (arch-review 60 P2).
    const id = axisOf(caseWith(world({ isolation: "runsc" })), caseWith(world({ isolation: "runc" })));
    expect(id.held, "a batch measured under gVisor was compared with one on a shared kernel").not.toContain(
      "execution_world",
    );
    expect(id.confounds.map((c) => c.axis)).toContain("execution_world");
  });

  it("distinguishes an explicit runtime from the lane's DEFAULT", () => {
    // Absent means the lane applied no explicit runtime, which is a real state rather than a missing one —
    // it is exactly what `assertHardenedIsolation` refuses for an untrusted zone, so it must not read as
    // equal to a hardened one.
    const id = axisOf(caseWith(world({ isolation: "runsc" })), caseWith(world()));
    expect(id.confounds.map((c) => c.axis)).toContain("execution_world");
  });

  it("is UNVERIFIED when only one side recorded the world it was placed in", () => {
    // Not a confound: nobody said the worlds differ. The pair simply cannot compare beyond image bytes, and
    // "we could not find out" must not be upgraded into either answer.
    const id = axisOf(caseWith(), caseWith(world()));
    expect(id.confounds.map((c) => c.axis)).not.toContain("execution_world");
    expect(id.unverified.map((u) => u.axis)).toContain("execution_world");
  });

  it("does NOT change the answer for a pair that recorded no world at all", () => {
    // The rollout rule this file's subject already follows for image provenance: an axis must not retroactively
    // re-judge data that did not change. A pair from before the field existed — or from `POST /scorecards/ingest`,
    // which scores somebody else's runtime and has no world to record by construction — is exactly as
    // verifiable as it was yesterday.
    const id = axisOf(caseWith(), caseWith());
    expect(id.held, "a pair that recorded no world at all changed its answer").toContain("execution_world");
    expect(id.unverified.map((u) => u.axis)).not.toContain("execution_world");
  });
});
