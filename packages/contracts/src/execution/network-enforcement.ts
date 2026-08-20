import { BadRequestError } from "../errors.js";
import { type NetworkPolicy, isDefaultNetwork } from "../infra/world.js";

// ── AN AXIS A LANE CANNOT ENFORCE IS REFUSED BEFORE IT SPENDS ANYTHING (arch-review 58, W5) ──────────
//
// `EvalCase.network` is part of what a benchmark MEASURES, not an ops knob: an offline reasoning task that
// quietly ran with internet access measured retrieval instead, and its score is not comparable to one that
// did not. So the contract is enforce-or-refuse, and the refusal already existed — at
// `LocalDriver.provision`, where the world proof is CHECKED, inside the container the lane had already
// placed. Right decision, wrong moment: a scheduling slot, an image pull and a container start were spent
// first, and the operator saw a failure attributed to the run rather than to the lane's capability.
//
// This is that decision where it costs nothing. The managed job SPEC builders are pure, and they already
// refuse a millicore CPU declaration a cluster cannot convert; a network declaration nothing on the way
// enforces is the same answer on a second axis.
//
// Enforcement is deliberately NOT what this provides. CNI policies on K8s and per-task network config on
// Nomad are deployment-shaped work; what belongs here is that a lane which does not do them says so before
// it acts, rather than after.
export function refuseUnenforceableNetwork(network: NetworkPolicy | undefined, lane: string): void {
  // `public` with no hosts is what every workload got before this axis existed — the one shape a lane
  // satisfies by doing nothing, and the one whose absence and presence mean the same thing.
  if (isDefaultNetwork(network)) return;
  throw new BadRequestError(
    "BAD_REQUEST",
    { lane, mode: network?.mode },
    `this case declares a '${network?.mode}' network world and the ${lane} lane cannot enforce it, so placing it would run the case in a world it did not ask for and report the score as if nothing had changed. Enforce it on the cluster (a K8s NetworkPolicy / a Nomad task network block) or submit the case without a network declaration.`,
  );
}
