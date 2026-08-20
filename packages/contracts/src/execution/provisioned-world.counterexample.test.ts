import { describe, expect, it } from "vitest";
import type { NetworkPolicy, ResourceRequest } from "../infra/world.js";
import { type ProvisionedWorldProof, worldProofCovers } from "./provisioned-world.js";

// ── A DECLARED WORLD IS ENFORCED BY SOMEBODY, OR THE RUN IS REFUSED (arch-review 57 P1-high) ─────────
//
// A managed case runs two layers deep, and both of them look at the case's declared world:
//
//   outer  K8s/Nomad   builds the container — and reads only `harnessSpec.resources`, never
//                      `evalCase.resources`, so the CASE's declaration reaches no manifest;
//   inner  LocalDriver runs the harness as a host process — and REFUSES a declared cpu/memory/network,
//                      correctly, because it cannot enforce one.
//
// So a case that declares a world cannot run on a managed lane at all. Not "runs unenforced": refused, after
// the container is already up. The container-task corpora declare cpu/memory on tens of thousands of tasks
// and a network policy on thousands more, which makes this the ordinary case rather than an edge.
//
// And the tempting repair is worse than the defect: strip the declaration before handing it inward, and the
// inner driver stops complaining while the outer layer still enforces nothing — a run measured in a world
// nobody provided, reported as an ordinary result. The refusal is the only honest half currently implemented.
//
// What is missing is the other half: the outer lane enforcing the declaration and SAYING SO, so the inner one
// has something to trust instead of something to strip. That is this proof. It is not a request or a
// courtesy copy — it is the outer layer's claim about the box it made, and the inner driver's job is to check
// that the claim covers what the case asked for. Anything less, and it refuses exactly as it does today.
//
// RED as of 2c4c3545, observed:
//   Cannot find module './provisioned-world.js'

const proof = (over: Partial<ProvisionedWorldProof> = {}): ProvisionedWorldProof => ({
  os: "linux",
  enforcedBy: "k8s",
  ...over,
});

const cpu = (millicores: number, memoryMb: number): ResourceRequest => ({ cpu: millicores, memoryMb });
const offline: NetworkPolicy = { mode: "none", allowedHosts: [] };

describe("[R57 COUNTEREXAMPLE] a declared world is covered by the placement's proof, or it is not covered", () => {
  it("a case that declared nothing is covered by any proof — the rule is not a tax on ordinary cases", () => {
    expect(worldProofCovers(proof(), undefined, undefined)).toBe(true);
  });

  it("REFUSES when there is no proof at all and the case declared a world", () => {
    // Today's state, named: nobody said they enforced it, so nobody did.
    expect(worldProofCovers(undefined, cpu(2000, 4096), undefined)).toBe(false);
    expect(worldProofCovers(undefined, undefined, offline)).toBe(false);
  });

  it("covers a resource declaration only when the proof carries the SAME one", () => {
    expect(worldProofCovers(proof({ resources: cpu(2000, 4096) }), cpu(2000, 4096), undefined)).toBe(true);
    // A box built to a different size is a different world, and "close enough" is how a benchmark's numbers
    // stop being comparable to the run it is compared against.
    expect(worldProofCovers(proof({ resources: cpu(1000, 4096) }), cpu(2000, 4096), undefined)).toBe(false);
    expect(worldProofCovers(proof({ resources: cpu(2000, 2048) }), cpu(2000, 4096), undefined)).toBe(false);
  });

  it("covers a network declaration only when the proof carries the SAME mode", () => {
    expect(worldProofCovers(proof({ network: offline }), undefined, offline)).toBe(true);
    // The one that matters most: an offline-declared task run with host network access measures a different
    // task, and looks like an ordinary pass. `public` is the default world — the one an unenforced lane gives.
    expect(worldProofCovers(proof({ network: { mode: "public", allowedHosts: [] } }), undefined, offline)).toBe(false);
  });

  it("REFUSES a proof that covers one axis and is silent on the other", () => {
    // Partial enforcement reported as enforcement is the shape this whole protocol exists to refuse.
    expect(worldProofCovers(proof({ resources: cpu(2000, 4096) }), cpu(2000, 4096), offline)).toBe(false);
    expect(worldProofCovers(proof({ network: offline }), cpu(2000, 4096), offline)).toBe(false);
  });
});
