import type { ManagedDispatchAuthority } from "@everdict/application-control";
import type { CaseJob, PersistedWorkIntent, RuntimeWorkRef } from "@everdict/contracts";
import { encodeResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type K8sApi, K8sBackend } from "./k8s.js";

// ── THE KUBELET ALREADY SAYS WHICH BYTES IT PULLED (docs/architecture/evolution-lineage.md, Track B) ─
//
// The world axis refuses to compare a case whose image cannot be named, and the K8s lane could not name an
// unpinned tag: `laneImageProvenance` honestly reported `unresolved{lane_cannot_report}`, so every scorecard
// run from a `:latest`-style reference on this lane carried an unverifiable world — and the comparison the
// evolution loop rests on degraded exactly where drift is most likely. The observation was always available:
// `status.containerStatuses[].imageID` is the kubelet's own account of the pulled digest, strictly better
// than any inference from the reference. This drives the PRODUCTION dispatch (rule `testing`) and asserts
// the value reached the manifest a diff actually reads.
//
// RED as of d0274fa1: `expected 'unresolved' to be 'resolved'` — nothing read the pod status back, so the
// lane's answer for a mutable tag stayed "we could not find out" while the kubelet knew.

const REF = "ghcr.io/acme/task:latest";
const DIGEST = `sha256:${"a".repeat(64)}`;

const JOB: CaseJob = {
  harness: { id: "h", version: "1.0.0" },
  runId: "evd-run-r1",
  tenant: "acme",
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
    image: REF,
  },
};

const authority: ManagedDispatchAuthority = {
  async reserve(work: RuntimeWorkRef): Promise<PersistedWorkIntent> {
    return { attemptId: work.attemptId ?? `${work.runId}#g1`, work, persistedAt: "2026-08-26T00:00:00.000Z" };
  },
  async activate() {
    return { kind: "activate" as const };
  },
};

// The agent's own manifest, as the in-container LocalDriver reports it: era 2, no image provenance — it
// pulled nothing, the box was made by this lane. Exactly the gap `mergePlacedImage` exists to fill.
const sentinel = encodeResult({
  caseId: "c1",
  harness: "agent@1",
  trace: [],
  scores: [],
  snapshot: { kind: "prompt", output: "done" },
  execution: { os: "linux", osResolved: "declared", driver: "local", manifestVersion: 2 },
});

function api(observed: Array<{ image: string; imageID: string }> | undefined): K8sApi {
  return {
    async ensureNamespace() {},
    async applyJob() {},
    async resumeJob() {},
    async jobStatus() {
      return { succeeded: 1, failed: 0 };
    },
    async podLogs() {
      return sentinel;
    },
    async podImageIds() {
      return observed;
    },
    async deleteJob() {
      return { status: "stopped" as const };
    },
    async podFailureReason() {
      return undefined;
    },
    async podsForJob() {
      return [];
    },
  } as unknown as K8sApi;
}

const backend = (a: K8sApi) => new K8sBackend({ image: "runner:1", api: a, pollIntervalMs: 0 } as never);

describe("[TRACK-B COUNTEREXAMPLE] the K8s lane resolves a mutable tag from the kubelet's observation", () => {
  it("a placed :latest resolves to the digest the kubelet pulled, stamped as an orchestrator observation", async () => {
    const result = await backend(
      api([{ image: REF, imageID: `docker-pullable://ghcr.io/acme/task@${DIGEST}` }]),
    ).dispatch(JOB, { authority });
    const provenance = result.execution?.imageProvenance;
    expect(provenance?.kind, "the lane still cannot name the bytes it placed").toBe("resolved");
    if (provenance?.kind !== "resolved") throw new Error("unreachable");
    expect(provenance.by).toBe("orchestrator");
    expect(provenance.images).toEqual([{ ref: REF, digest: DIGEST }]);
  });

  it("an unavailable observation keeps the honest fallback — unresolved, never a fabricated digest", async () => {
    const result = await backend(api(undefined)).dispatch(JOB, { authority });
    const provenance = result.execution?.imageProvenance;
    expect(provenance?.kind).toBe("unresolved");
    if (provenance?.kind !== "unresolved") throw new Error("unreachable");
    expect(provenance.reason).toBe("lane_cannot_report");
  });
});
