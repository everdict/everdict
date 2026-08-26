import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { mergePlacedImage } from "./placement-image.js";

// ── THE LANE THAT PULLED THE IMAGE IS THE ONE THAT CAN NAME IT (arch-review 57 P1-high) ──────────────
//
// `runCase` records image provenance from `compute.image`. On a managed lane the compute is a `LocalDriver`
// INSIDE the task container, and that driver answers `NO_IMAGE` — truthfully, because it pulled nothing; it
// is a host process in a box somebody else made. The box was made by the outer backend, which chose the task
// image and pulled it.
//
// So the two layers observe different things and only the inner one is written down:
//
//   outer (K8s/Nomad)   image = task-image:tag        ← chose it, pulled it
//   inner (LocalDriver) image = none                  ← "I pulled nothing", which is true
//   persisted manifest  imageProvenance = none        ← the inner answer, unqualified
//
// `none` is a POSITIVE claim in this vocabulary: it says two runs that both provisioned nothing ran in the
// same world. For a managed run that is false, and falsely REASSURING — the release comparison it feeds reads
// two runs of `task:latest` as the same world when the tag moved between them, which is precisely the
// question image provenance exists to answer.
//
// `withPlacementImage` and `laneImageProvenance` were written for this in an earlier review and never called
// from production: a search at 11943e7f finds the definition, the barrel export and their tests. A helper
// with no caller is a plan, not a protocol.
//
// RED as of 2c4c3545, observed:
//   Cannot find module './placement-image.js'
//
// What this pins is the MERGE rule, which is where the subtlety is: the outer answer fills a gap, it never
// overwrites an inner answer. A driver that really did pull the image (Docker) knows more than the placement
// does, and the manifest keeps the stronger claim.

const manifest = (over: Record<string, unknown> = {}) => ({
  os: "linux" as const,
  osResolved: "declared" as const,
  driver: "local",
  manifestVersion: 1,
  ...over,
});

const result = (execution: unknown): CaseResult =>
  ({ caseId: "c1", harness: "h", trace: [], scores: [], execution }) as unknown as CaseResult;

const job = (image?: string): CaseJob =>
  ({ evalCase: { id: "c1", ...(image !== undefined ? { image } : {}) } }) as unknown as CaseJob;

describe("[R57 COUNTEREXAMPLE] a managed result records the image its PLACEMENT ran, not the inner driver's silence", () => {
  it("fills a `none` provenance with the lane's own answer", () => {
    const merged = mergePlacedImage(
      result(manifest({ imageProvenance: { kind: "none" } })),
      job("task:1"),
      "Nomad",
      undefined,
    );
    expect(merged.execution?.imageProvenance, "the inner driver's `none` survived a placed image").not.toEqual({
      kind: "none",
    });
  });

  it("says UNRESOLVED for a mutable tag rather than inventing a digest", () => {
    // The lane placed `task:1`, which names no bytes. "We could not find out" is the honest answer and is a
    // different statement from "there was no image" — the whole point of the three-valued provenance.
    const merged = mergePlacedImage(
      result(manifest({ imageProvenance: { kind: "none" } })),
      job("task:1"),
      "Nomad",
      undefined,
    );
    expect(merged.execution?.imageProvenance).toMatchObject({ kind: "unresolved" });
  });

  it("reads a DIGEST-PINNED reference as resolved, from the ref itself", () => {
    const pinned = "registry.example/task@sha256:abc123";
    const merged = mergePlacedImage(
      result(manifest({ imageProvenance: { kind: "none" } })),
      job(pinned),
      "K8s",
      undefined,
    );
    expect(merged.execution?.imageProvenance).toMatchObject({ kind: "resolved" });
  });

  it("NEVER overwrites a driver that actually pulled the image", () => {
    // A Docker driver read the digest back off the container it launched. That is a stronger claim than the
    // placement's, and a merge that clobbered it would trade an observation for an inference.
    const observed = { kind: "resolved", images: [{ ref: "task:1", digest: "sha256:real" }], source: "container" };
    const merged = mergePlacedImage(result(manifest({ imageProvenance: observed })), job("task:1"), "Nomad", undefined);
    expect(merged.execution?.imageProvenance).toEqual(observed);
  });

  it("leaves a result with NO manifest alone — there is nothing to qualify", () => {
    // A pre-manifest result (or one from a lane that records none) is not made to look richer than it is.
    const bare = result(undefined);
    expect(mergePlacedImage(bare, job("task:1"), "Nomad", undefined)).toEqual(bare);
  });

  it("is a no-op when the placement itself has no image to report", () => {
    const only = result(manifest({ imageProvenance: { kind: "none" } }));
    expect(mergePlacedImage(only, job(undefined), "Nomad", undefined)).toEqual(only);
  });
});
