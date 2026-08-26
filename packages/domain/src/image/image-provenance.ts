import {
  CURRENT_EXECUTION_MANIFEST_ERA,
  type ExecutionManifest,
  type ImageProvenance,
  imageResolved,
  imageUnresolved,
} from "@everdict/contracts";
import { parseImageRef } from "./image-ref.js";

// THE READER — the one place a manifest's image identity is derived, so "what did this case run from?" has
// a single answer no consumer re-invents.
//
// The era matters more than the field. An era-1 manifest carries `image` as a copy of the REQUEST, and its
// absence there is ambiguous: a k8s batch that ran a real image and never recorded one is byte-identical to
// a prompt case that provisioned nothing. Reading either as `none` would claim knowledge nobody has — so
// every era-1 manifest is `unresolved{legacy_era}`, which is a statement about our history rather than an
// accusation about that run.
export function imageProvenanceOf(manifest: ExecutionManifest): ImageProvenance {
  const era = manifest.manifestVersion ?? 1;
  if (era < CURRENT_EXECUTION_MANIFEST_ERA) {
    const ref = manifest.image ?? "";
    return imageUnresolved(
      [{ ref }],
      "legacy_era",
      manifest.image !== undefined
        ? `the manifest predates image provenance and recorded only the requested reference '${manifest.image}'`
        : "the manifest predates image provenance and recorded no reference at all",
    );
  }
  // An era-2 manifest CLAIMS every current facet was recorded, so a missing provenance is a producer bug we
  // want visible rather than a silent slide back to the legacy reading.
  return (
    manifest.imageProvenance ??
    imageUnresolved(
      [{ ref: manifest.image ?? "" }],
      "lane_cannot_report",
      "the manifest declares the current era but states no image provenance",
    )
  );
}

// THE MERGE — two layers provision (the in-sandbox Driver and the placement Backend/TopologyRuntime) and
// exactly one of them holds the bytes the case executed. One owner, so four backends cannot each invent a
// rule: a driver answer that is not `none` wins, because the in-sandbox image is the nearer world; a driver
// that provisioned nothing yields to the placement answer, because a pod IS the sandbox when the in-pod
// driver is local.
export function withPlacementImage(manifest: ExecutionManifest, placed: ImageProvenance): ExecutionManifest {
  const current = manifest.imageProvenance;
  if (current !== undefined && current.kind !== "none") return manifest;
  return { ...manifest, manifestVersion: CURRENT_EXECUTION_MANIFEST_ERA, imageProvenance: placed };
}

// THE ANSWER A LANE WITH NO READBACK OWES. A reference the caller already pinned names its own bytes, so
// no lane has to be asked and none can disagree; anything else is `lane_cannot_report` — a standing property
// of that provisioner, stated once here so three orchestrators do not each phrase it differently.
//
// This is also the user's escape from a lane that cannot report: pin the digest and the world is identified
// without any cluster read at all.
export function laneImageProvenance(ref: string, lane: string): ImageProvenance {
  const pinned = parseImageRef(ref).digest;
  if (pinned !== undefined) return imageResolved([{ ref, digest: pinned }], "ref");
  return imageUnresolved(
    [{ ref }],
    "lane_cannot_report",
    `${lane} reports no resolved image digest for a placed workload, so an unpinned reference cannot be identified — pin a digest to make this world verifiable`,
  );
}

// THE OBSERVATION A LANE READS BACK — the kubelet's `containerStatuses[].imageID` is its own account of the
// digest it actually pulled (`docker-pullable://repo@sha256:…` / `repo@sha256:…`), strictly better than any
// inference from the reference: it identifies the bytes of a mutable tag. One extractor, because the imageID
// format varies by container runtime and a second spelling would diverge on exactly the odd one.
// `undefined` = no status names the placed ref, or the named one carries no digest — the caller falls back
// to the reference reading (`laneImageProvenance`), never to a fabricated resolution.
export function observedPlacementImage(
  ref: string,
  statuses: readonly { image: string; imageID: string }[],
): ImageProvenance | undefined {
  // Prefer the status whose `image` is the placed ref verbatim; a single-container pod may report a
  // runtime-normalized image string (`docker.io/library/…`), so the only status stands in when there is
  // exactly one. Multiple non-matching statuses are ambiguity, and picking one would attribute another
  // container's bytes to the case.
  const match = statuses.find((s) => s.image === ref) ?? (statuses.length === 1 ? statuses[0] : undefined);
  const digest = match !== undefined ? /sha256:[0-9a-f]{64}/.exec(match.imageID)?.[0] : undefined;
  if (digest === undefined) return undefined;
  return imageResolved([{ ref, digest }], "orchestrator");
}

// Whether two worlds ran the SAME bytes. Compares the (unit, ref@digest) set rather than the array, so the
// order two lanes happened to report their units in is not a difference. Only ever asked of two `resolved`
// provenances — an unresolved side has no claim to compare.
export function sameResolvedImages(a: ImageProvenance, b: ImageProvenance): boolean {
  if (a.kind !== "resolved" || b.kind !== "resolved") return false;
  // The separators are written as ESCAPES, never as literal bytes. Raw, they make git treat this source as
  // BINARY: the diff reads "Binary files differ" and `git grep` skips the file, so a function that decides
  // whether two runs used the same bytes becomes one nobody can review or search. Same values, same key.
  const key = (p: ImageProvenance): string =>
    p.kind === "resolved"
      ? p.images
          .map((i) => `${i.unit ?? ""}\u0000${i.digest}`)
          .sort()
          .join("\u0001")
      : "";
  return key(a) === key(b);
}
