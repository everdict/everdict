import { type CaseResult, MANIFEST_IDENTITY_VERSION, type ScorecardManifest } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { experimentIdentity } from "./experiment-identity.js";

// ── TWO ENVIRONMENT VERSIONS UNDER ONE HARNESS ARE NOT ONE EXPERIMENT ─────────────────────────────────
//
// docs/architecture/harness-definability-spec.md §2, the stated counterexample. A case that names its
// environment by REFERENCE keeps the same content digest while the world underneath it changes, so before
// the `environment` axis existed this pair read comparable and a delta caused by a new seed repository was
// attributable to the harness under test. That is the false green light experiment identity exists to
// refuse, and it is the same treatment two image digests already get.
const world = (() => {
  const ran = (caseId: string): CaseResult =>
    ({
      caseId,
      harness: "agent@1.0.0",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
      execution: {
        os: "linux",
        osResolved: "declared",
        manifestVersion: 2,
        imageProvenance: { kind: "resolved", by: "driver", images: [{ ref: "img:1", digest: "sha256:img" }] },
      },
    }) as unknown as CaseResult;
  return { baseline: [ran("login")], candidate: [ran("login")] };
})();
const sealed = (over: Partial<ScorecardManifest> = {}): ScorecardManifest => ({
  identityVersion: MANIFEST_IDENTITY_VERSION,
  dataset: { id: "bench", version: "7.0.0", digest: "sha256:composite-a" },
  cases: { login: "sha256:case-login-a" },
  grading: "sha256:grading-a",
  harness: { id: "agent", version: "1.0.0", specDigest: "sha256:hhhh" },
  ...over,
});

describe("the environment axis — the world a referenced case acted on", () => {
  it("two environment versions under one unchanged case are a confound, naming the case and both refs", () => {
    const id = experimentIdentity(
      sealed({ environments: { login: { ref: "shop@1.0.0", digest: "sha256:env-1" } } }),
      sealed({ environments: { login: { ref: "shop@2.0.0", digest: "sha256:env-2" } } }),
      world,
    );
    expect(id.held).not.toContain("environment");
    const confound = id.confounds.find((c) => c.axis === "environment");
    expect(confound?.detail).toContain("login");
    expect(confound?.detail).toContain("shop@1.0.0");
    expect(confound?.detail).toContain("shop@2.0.0");
    // …and the case itself did not move, so nothing else may absorb the blame.
    expect(id.held).toContain("dataset_content");
  });

  it("the same environment document on both sides holds the axis", () => {
    const both = { login: { ref: "shop@1.0.0", digest: "sha256:env-1" } };
    const id = experimentIdentity(sealed({ environments: both }), sealed({ environments: both }), world);
    expect(id.held).toContain("environment");
    expect(id.confounds).toEqual([]);
  });

  it("one side sealed an environment and the other sealed none — unverified, never held", () => {
    const id = experimentIdentity(
      sealed({ environments: { login: { ref: "shop@1.0.0", digest: "sha256:env-1" } } }),
      sealed(),
      world,
    );
    expect(id.held).not.toContain("environment");
    expect(id.unverified.find((u) => u.axis === "environment")?.reason).toBe("unsealed");
  });

  it("a document that could not be read at seal time is unverified, not agreement", () => {
    const id = experimentIdentity(
      sealed({ environments: { login: { ref: "shop@1.0.0" } } }),
      sealed({ environments: { login: { ref: "shop@1.0.0" } } }),
      world,
    );
    expect(id.held).not.toContain("environment");
    expect(id.unverified.find((u) => u.axis === "environment")?.reason).toBe("unresolved");
  });

  it("a batch where no case references an environment abstains — the axis is absent, not held and not a confound", () => {
    const id = experimentIdentity(sealed(), sealed(), world);
    expect(id.held).not.toContain("environment");
    expect(id.confounds.map((c) => c.axis)).not.toContain("environment");
    expect(id.unverified.map((u) => u.axis)).not.toContain("environment");
  });
});
