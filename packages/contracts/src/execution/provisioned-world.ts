import { z } from "zod";
import {
  type NetworkPolicy,
  NetworkPolicySchema,
  type ResourceRequest,
  ResourceRequestSchema,
} from "../infra/world.js";

// ── WHAT THE OUTER LAYER ACTUALLY BUILT (arch-review 57 P1-high) ─────────────────────────────────────
//
// A managed case runs two layers deep, and the case's declared world was visible to both while being
// enforced by neither. The outer backend reads `harnessSpec.resources` and never `evalCase.resources`, so a
// case's declaration reached no container manifest; the inner `LocalDriver` REFUSES a declared cpu/memory or
// network policy, correctly, because a host process cannot enforce one. Net effect: a case that declares a
// world does not run on a managed lane at all — and the container-task corpora declare one routinely.
//
// The repair that suggests itself is the dangerous one. Strip the declaration on the way in and the inner
// driver stops objecting while the outer layer still enforces nothing: the case runs in a world nobody
// provided and reports an ordinary result. An offline-declared task with host network access measures a
// different task and passes.
//
// So the inner driver keeps refusing, and gains something it can accept instead: a PROOF from the layer that
// made the box. Not a request and not a courtesy copy of the declaration — a claim about what was enforced,
// by whom. The inner side's job is to check the claim COVERS what the case asked for; anything short of
// that, including a proof silent on one axis, is refused exactly as today.
export const ProvisionedWorldProofSchema = z.object({
  os: z.enum(["linux", "windows", "macos"]),
  // Named so the claim is attributable. A proof is only worth what its author enforces, and "the local
  // process says it enforced a cgroup" is a claim worth refusing on sight.
  enforcedBy: z.enum(["k8s", "nomad", "docker"]),
  // Present ONLY for an axis this placement really constrained. Absent means "I did not enforce this", which
  // is why a partial proof cannot cover a full declaration.
  resources: ResourceRequestSchema.optional(),
  network: NetworkPolicySchema.optional(),
});
export type ProvisionedWorldProof = z.infer<typeof ProvisionedWorldProofSchema>;

// Exact equality, per axis. Not "at least as much": a box with MORE cpu than the case asked for is still a
// different world from the one the comparison baseline ran in, and a benchmark whose numbers are compared
// across runs cannot absorb that quietly. A lane that wants to run a case in a bigger box changes the case.
function sameResources(a: ResourceRequest | undefined, b: ResourceRequest | undefined): boolean {
  return a?.cpu === b?.cpu && a?.memoryMb === b?.memoryMb && a?.gpu === b?.gpu;
}

function sameNetwork(a: NetworkPolicy | undefined, b: NetworkPolicy | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.mode !== b.mode) return false;
  const [x, y] = [[...a.allowedHosts].sort(), [...b.allowedHosts].sort()];
  return x.length === y.length && x.every((h, i) => h === y[i]);
}

// Does this placement's claim cover what the case declared?
//
// A case that declared nothing is covered by anything, including no proof at all — the rule is a condition on
// declarations, not a tax on the ordinary case. A case that declared something and has no proof is NOT
// covered: nobody said they enforced it, which is the state every managed lane was in.
export function worldProofCovers(
  proof: ProvisionedWorldProof | undefined,
  resources: ResourceRequest | undefined,
  network: NetworkPolicy | undefined,
): boolean {
  const wantsResources = resources !== undefined;
  const wantsNetwork = network !== undefined;
  if (!wantsResources && !wantsNetwork) return true;
  if (proof === undefined) return false;
  if (wantsResources && !sameResources(proof.resources, resources)) return false;
  if (wantsNetwork && !sameNetwork(proof.network, network)) return false;
  return true;
}
