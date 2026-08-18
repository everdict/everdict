import { z } from "zod";

// WHICH BYTES A WORLD ACTUALLY RAN — recorded BY the site that pulled them, never re-derived downstream
// from the reference the case asked for.
//
// `EvalCase.image` is a REQUEST. `repo:latest` names different bytes on Tuesday and Thursday, and the
// execution manifest used to record that request verbatim — so a release gate could compare two batches,
// find every sealed axis identical, and issue a green light over two different images. The request is not
// the world; this is.
//
// Three states, because there are three different facts and one optional field answered all of them with
// the same silence (rule `protocol` L2, case-law R55.9):
//   none       — this lane provisioned no image at all (a host process, a prompt env). There is no digest
//                to want, and two image-free worlds are the SAME world, not two unknown ones.
//   resolved   — an image ran and the provisioner read back the digest it resolved to.
//   unresolved — an image ran and its identity could not be established. Never an absent field: "no image"
//                and "an image nobody identified" are opposite claims about how much we know.
export const ProvisionedImageSchema = z.object({
  ref: z.string(), // the reference AS REQUESTED — the tag survives so a human still reads a version off it
  digest: z.string(), // "sha256:<hex>" AS OBSERVED by the provisioner
  // The service/unit this image backs, when the world is built from several (a service topology). Absent on
  // a single-image lane, where naming the unit would be inventing a distinction the lane does not have.
  unit: z.string().optional(),
});
export type ProvisionedImage = z.infer<typeof ProvisionedImageSchema>;

// WHY an image could not be identified. The five are not interchangeable, and collapsing them is how an
// outage and a design limit come to read the same:
//   inspect_failed     — the read did not happen (daemon/API error). `ReadResult`'s `unknown`.
//   no_registry_digest — the read happened and this image HAS no registry identity (built locally, never
//                        pushed). `ReadResult`'s `absent` — a real answer, not a failure.
//   lane_cannot_report — this provisioner has no API that reports it at all. A standing property of the
//                        lane, not an incident on this run.
//   partial            — a multi-image world where some units resolved and some did not. A stack is
//                        identified or it is not; "most of it" is not an identity.
//   legacy_era         — synthesized by the READER for a manifest written before this era. No live
//                        provisioner emits it: it is a statement about our history, not about that run.
export const IMAGE_UNRESOLVED_REASONS = [
  "inspect_failed",
  "no_registry_digest",
  "lane_cannot_report",
  "partial",
  "legacy_era",
] as const;
export const ImageUnresolvedReasonSchema = z.enum(IMAGE_UNRESOLVED_REASONS);
export type ImageUnresolvedReason = z.infer<typeof ImageUnresolvedReasonSchema>;

export const ImageProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("resolved"),
    // EVERY image this world was built from. One on a driver/pod lane, N on a service topology. A world is
    // `resolved` only when all of them are — see `partial`.
    images: z.array(ProvisionedImageSchema).min(1),
    // WHO observed it. `ref` = the request already carried a digest, so no read was needed and no lane can
    // disagree; the others name the layer that pulled. Kept because a registry-verified digest and a
    // node-local content id are different strengths of the same claim, and a reader may want to say so.
    by: z.enum(["ref", "driver", "orchestrator", "runtime"]),
  }),
  z.object({
    kind: z.literal("unresolved"),
    images: z.array(z.object({ ref: z.string(), unit: z.string().optional() })).min(1),
    reason: ImageUnresolvedReasonSchema,
    detail: z.string(),
  }),
]);
export type ImageProvenance = z.infer<typeof ImageProvenanceSchema>;

// The two constructors every provisioner uses, so a lane never hand-builds the union and quietly omits an
// arm's required field.
export const imageResolved = (
  images: readonly ProvisionedImage[],
  by: "ref" | "driver" | "orchestrator" | "runtime",
): ImageProvenance => ({ kind: "resolved", images: [...images], by });

export const imageUnresolved = (
  images: readonly { ref: string; unit?: string }[],
  reason: ImageUnresolvedReason,
  detail: string,
): ImageProvenance => ({ kind: "unresolved", images: [...images], reason, detail });

export const NO_IMAGE: ImageProvenance = { kind: "none" };
