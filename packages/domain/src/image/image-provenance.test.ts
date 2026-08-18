import { CURRENT_EXECUTION_MANIFEST_ERA, type ExecutionManifest, imageResolved, NO_IMAGE } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { imageProvenanceOf, laneImageProvenance, sameResolvedImages, withPlacementImage } from "./image-provenance.js";

const era1 = (over: Partial<ExecutionManifest> = {}): ExecutionManifest => ({
  os: "linux",
  osResolved: "declared",
  ...over,
});
const era2 = (over: Partial<ExecutionManifest> = {}): ExecutionManifest => ({
  os: "linux",
  osResolved: "declared",
  manifestVersion: CURRENT_EXECUTION_MANIFEST_ERA,
  ...over,
});

describe("imageProvenanceOf — what a stored manifest is entitled to claim", () => {
  it("reads a pre-era manifest as unresolved, never as a world with no image", () => {
    // Given: a row from before image provenance, which recorded the REQUEST — When read, Then the answer is
    // about our history. Reading it as `none` would claim this case provisioned nothing, and a k8s batch
    // that ran a real image and recorded no reference looks byte-identical to a prompt case that did not.
    const p = imageProvenanceOf(era1({ image: "acme/agent:latest" }));
    expect(p).toMatchObject({ kind: "unresolved", reason: "legacy_era" });
    if (p.kind === "unresolved") expect(p.images).toEqual([{ ref: "acme/agent:latest" }]);
  });

  it("reads a pre-era manifest with no reference at all the same way", () => {
    // The ambiguity IS the reason: absence here cannot be told from a lane that provisioned nothing.
    expect(imageProvenanceOf(era1())).toMatchObject({ kind: "unresolved", reason: "legacy_era" });
  });

  it("returns what an era-2 producer recorded", () => {
    const provenance = imageResolved([{ ref: "acme/agent:1.2", digest: "sha256:aaaa" }], "driver");
    expect(imageProvenanceOf(era2({ imageProvenance: provenance }))).toEqual(provenance);
  });

  it("keeps a declared `none` as none — an image-free world is a claim, not a gap", () => {
    expect(imageProvenanceOf(era2({ imageProvenance: NO_IMAGE }))).toEqual(NO_IMAGE);
  });

  it("makes an era-2 producer that stated nothing VISIBLE rather than silently legacy", () => {
    // A manifest declaring the current era claims every current facet was recorded. Falling back to the
    // legacy reading here would turn a producer bug into an indistinguishable statement about history.
    expect(imageProvenanceOf(era2())).toMatchObject({ kind: "unresolved", reason: "lane_cannot_report" });
  });
});

describe("laneImageProvenance — the answer a lane with no readback owes", () => {
  it("names the bytes when the request itself pinned a digest, with no lane read at all", () => {
    expect(laneImageProvenance("acme/agent:1.2@sha256:cccc", "the Nomad API")).toEqual({
      kind: "resolved",
      by: "ref",
      images: [{ ref: "acme/agent:1.2@sha256:cccc", digest: "sha256:cccc" }],
    });
  });

  it("states that the lane cannot report rather than staying silent", () => {
    const p = laneImageProvenance("acme/agent:latest", "the Nomad API");
    expect(p).toMatchObject({ kind: "unresolved", reason: "lane_cannot_report" });
    if (p.kind === "unresolved") expect(p.detail).toContain("pin a digest");
  });
});

describe("withPlacementImage — one merge rule, not one per backend", () => {
  const placed = imageResolved([{ ref: "acme/pod:1", digest: "sha256:bbbb" }], "orchestrator");
  const driverAnswer = imageResolved([{ ref: "acme/agent:1", digest: "sha256:aaaa" }], "driver");

  it("lets the placement answer stand when the in-sandbox driver provisioned nothing", () => {
    // A pod IS the sandbox when the in-pod driver is local: the nearer world is the pod's image.
    const merged = withPlacementImage(era2({ imageProvenance: NO_IMAGE }), placed);
    expect(merged.imageProvenance).toEqual(placed);
    expect(merged.manifestVersion).toBe(CURRENT_EXECUTION_MANIFEST_ERA);
  });

  it("keeps the driver's answer when the case ran in its own container", () => {
    // The in-sandbox image is the nearer world — the pod's image is the box that box ran in.
    expect(withPlacementImage(era2({ imageProvenance: driverAnswer }), placed).imageProvenance).toEqual(driverAnswer);
  });

  it("fills an era-1 manifest from the placement lane and declares the era it just became", () => {
    const merged = withPlacementImage(era1(), placed);
    expect(merged).toMatchObject({ manifestVersion: CURRENT_EXECUTION_MANIFEST_ERA, imageProvenance: placed });
  });
});

describe("sameResolvedImages — two worlds ran the same bytes", () => {
  const a = imageResolved(
    [
      { ref: "acme/api:1", digest: "sha256:aaaa", unit: "api" },
      { ref: "acme/web:1", digest: "sha256:bbbb", unit: "web" },
    ],
    "runtime",
  );

  it("ignores the order two lanes happened to report their units in", () => {
    const reordered = imageResolved(
      [
        { ref: "acme/web:1", digest: "sha256:bbbb", unit: "web" },
        { ref: "acme/api:1", digest: "sha256:aaaa", unit: "api" },
      ],
      "runtime",
    );
    expect(sameResolvedImages(a, reordered)).toBe(true);
  });

  it("separates the same TAG over different bytes — the defect this whole axis exists for", () => {
    const other = imageResolved(
      [
        { ref: "acme/api:1", digest: "sha256:zzzz", unit: "api" },
        { ref: "acme/web:1", digest: "sha256:bbbb", unit: "web" },
      ],
      "runtime",
    );
    expect(sameResolvedImages(a, other)).toBe(false);
  });

  it("refuses to call two unresolved worlds the same — an unknown is not a match", () => {
    const unknown = laneImageProvenance("acme/api:1", "the Nomad API");
    expect(sameResolvedImages(unknown, unknown)).toBe(false);
  });
});
