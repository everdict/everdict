import type { CaseJob, CaseResult, NetworkPolicy, ProvisionedWorldProof, ResourceRequest } from "@everdict/contracts";
import { laneImageProvenance, withPlacementImage } from "@everdict/domain";

// ── WHAT THE PLACEMENT RAN, ADDED TO WHAT THE DRIVER SAW (arch-review 57 P1-high) ────────────────────
//
// A managed case runs two layers deep: the backend places a container, and inside it `runCase` drives a
// `LocalDriver`. Provenance is recorded from the inner one, and that driver answers `NO_IMAGE` — truthfully,
// since it pulled nothing. It is a host process in a box somebody else made.
//
// The box was made HERE. So the outer lane is the only layer that can say which image the run actually had,
// and until this function existed nothing carried that across: every managed result persisted
// `imageProvenance: none`, which in this vocabulary is the POSITIVE claim that the run provisioned no image
// at all. Two runs of `task:latest` then compare as the same world across a tag that moved — the exact
// question the provenance exists to answer, answered wrong and reassuringly.
//
// The merge rule is the careful part, and `withPlacementImage` owns it: the placement FILLS a gap and never
// overwrites. A driver that really did pull the image (Docker reads the digest back off the container) knows
// strictly more than a placement can infer, and trading that observation for an inference would be a loss.
export function mergePlacedImage(result: CaseResult, job: CaseJob, lane: string): CaseResult {
  const ref = job.evalCase.image;
  // Nothing placed, or a result from before the manifest era: there is nothing to qualify, and inventing a
  // manifest here would make a thin result look like a rich one.
  if (ref === undefined || result.execution === undefined) return result;
  // `laneImageProvenance` is the honest reading of a REFERENCE: a digest-pinned ref names its own bytes, and
  // a mutable tag is `unresolved{lane_cannot_report}` — "we could not find out", which is a third thing and
  // not a weaker "none".
  return { ...result, execution: withPlacementImage(result.execution, laneImageProvenance(ref, lane)) };
}

// ── AND WHAT IT ENFORCED, TOLD INWARD (arch-review 57 P1-high) ───────────────────────────────────────
//
// The proof the in-container driver checks. It names ONLY the axes this lane really constrains, because
// `worldProofCovers` reads silence as "not enforced" — and a proof claiming an axis the lane does not apply
// would be worse than the refusal it replaces: the case would run in a world nobody provided and report an
// ordinary result.
//
// Resources are claimed by whatever the lane RENDERED — the caller passes its own native answer, never the
// case's raw declaration, so the proof cannot outrun the manifest (rule `protocol`, "a proof is born from
// the same builder as the effect"; arch-review 59 P0-world).
//
// NETWORK is claimed only where a lane actually writes the object that constrains it. K8s does, for
// `mode: "none"`, when its operator has said the cluster enforces NetworkPolicy — and the proof had to learn
// that in the same change, because it did not: the policy was applied, the Job started, and the in-container
// check then refused the case for lack of a network proof. The feature was inert end to end while every test
// passed (arch-review 59 P1-high). Nomad still writes nothing, so an offline case there still reaches the
// refusal, which stays the correct answer until that lane can honestly say otherwise.
export function withWorldProof(
  job: CaseJob,
  enforcedBy: ProvisionedWorldProof["enforcedBy"],
  resources: ResourceRequest | undefined,
  // What the lane applied on the NETWORK axis, if anything. Absent = it applied nothing, and silence is what
  // `worldProofCovers` reads as "not enforced" — the fail-closed direction.
  network?: NetworkPolicy,
): CaseJob {
  const declared = job.evalCase.resources;
  const claimsNetwork = network !== undefined;
  // Nothing declared and nothing applied: no claim to make, and the run needs none.
  if ((declared === undefined || resources === undefined) && !claimsNetwork) return job;
  return {
    ...job,
    worldProof: {
      os: "linux",
      enforcedBy,
      ...(declared !== undefined && resources !== undefined ? { resources } : {}),
      ...(claimsNetwork ? { network } : {}),
    },
  };
}
