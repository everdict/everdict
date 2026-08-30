import { describe, expect, it } from "vitest";
import { BadRequestError } from "../errors.js";
import { NetworkPolicySchema } from "../infra/world.js";
import { refuseUnenforceableNetwork } from "./network-enforcement.js";

// ── ENFORCE OR REFUSE, AND SILENCE IS "DOES NOT ENFORCE" ─────────────────────────────────────────────
//
// `EvalCase.network` is part of what a benchmark MEASURES: an offline reasoning task that quietly ran with
// internet access measured retrieval instead, and its score is not comparable to one that did not. This
// function is the decision that keeps a lane from placing such a case, and it had no test — while being the
// gate on four call sites across two orchestrators.
//
// The property that matters is the DIRECTION it fails in. `enforcement` is optional, and every reason it can
// be absent (a lane with no network support, an operator who has not confirmed the cluster runs a policy
// controller, a caller that forgot the argument) has to mean "refuse", never "proceed unconstrained" — a lane
// that runs the case anyway reports a score as if nothing had changed.
const policy = (mode: "public" | "none" | "allowlist", allowedHosts: string[] = []) =>
  NetworkPolicySchema.parse({ mode, allowedHosts });

describe("a lane may not place a case whose network world it cannot enforce", () => {
  // `public` with no hosts is what every workload got before this axis existed — the one shape a lane
  // satisfies by doing nothing, so its absence and its presence mean the same thing.
  it("lets the do-nothing world through on a lane that enforces nothing", () => {
    expect(() => refuseUnenforceableNetwork(undefined, "nomad")).not.toThrow();
    expect(() => refuseUnenforceableNetwork(policy("public"), "nomad")).not.toThrow();
  });

  // The K8s lane's declaration when the operator has confirmed NetworkPolicy is enforced on the cluster.
  it("lets an offline world through on a lane that declares it enforces one", () => {
    expect(() => refuseUnenforceableNetwork(policy("none"), "k8s", { enforces: ["none"] })).not.toThrow();
  });

  // No declaration at all — the Nomad lane, and any caller that omits the argument.
  it("refuses an offline world on a lane that declares nothing", () => {
    expect(() => refuseUnenforceableNetwork(policy("none"), "nomad")).toThrow(BadRequestError);
  });

  // An EMPTY declaration is the same answer as no declaration. This is the arm a future lane reaches by
  // building its enforcement object from configuration that turned out to select nothing.
  it("refuses when the declaration enforces no mode at all", () => {
    expect(() => refuseUnenforceableNetwork(policy("none"), "k8s", { enforces: [] })).toThrow(BadRequestError);
  });

  // The mode is matched exactly. Declaring `none` does not buy `allowlist`: an egress allowlist needs a proxy
  // no lane here runs, and a deny-all policy applied to a case asking for two reachable hosts is a DIFFERENT
  // world, not a stricter reading of the same one.
  it("refuses a mode the declaration does not name, even on an enforcing lane", () => {
    expect(() =>
      refuseUnenforceableNetwork(policy("allowlist", ["example.com"]), "k8s", { enforces: ["none"] }),
    ).toThrow(BadRequestError);
  });

  // An allowlist with NO hosts denies everything, which is what `none` means — and it is still refused,
  // because the lane matches on the declared mode rather than on an interpretation of it. Deliberately
  // conservative: turning a case away is visible, and running it under a world nobody declared is not.
  it("refuses an empty allowlist rather than reinterpreting it as the offline mode", () => {
    expect(() => refuseUnenforceableNetwork(policy("allowlist"), "k8s", { enforces: ["none"] })).toThrow(
      BadRequestError,
    );
  });

  // The refusal is an operator's diagnosis: which lane could not do it, and which world was asked for. Without
  // both, the failure reads as a problem with the case rather than with the lane's capability.
  it("names the lane and the declared mode in the refusal", () => {
    try {
      refuseUnenforceableNetwork(policy("none"), "nomad");
      expect.unreachable("the lane enforces nothing, so this must refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      if (!(err instanceof BadRequestError)) throw err;
      expect(err.extra).toMatchObject({ lane: "nomad", mode: "none" });
      expect(err.message).toContain("nomad");
    }
  });
});
