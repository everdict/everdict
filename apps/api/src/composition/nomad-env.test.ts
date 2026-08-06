import { describe, expect, it } from "vitest";
import { deploymentNomad } from "./nomad-env.js";

// The eval lane and the sandbox lane share ONE Nomad. These are the rules that make that structural rather
// than a convention two composition functions are each trusted to remember.

describe("deploymentNomad — one cluster for both lanes", () => {
  it("is absent when no address is configured (a deployment with no cluster at all)", () => {
    expect(deploymentNomad({})).toBeUndefined();
  });

  it("reads the standard Nomad env, credential and namespace included", () => {
    expect(
      deploymentNomad({
        NOMAD_ADDR: "http://nomad:4646",
        NOMAD_TOKEN: "acl-token",
        EVERDICT_NOMAD_NAMESPACE: "evals",
      }),
    ).toEqual({ addr: "http://nomad:4646", apiToken: "acl-token", namespace: "evals" });
  });

  it("accepts the sandbox-era alias alone — an existing deployment keeps booting", () => {
    expect(
      deploymentNomad({ EVERDICT_SANDBOX_NOMAD_ADDR: "http://nomad:4646", EVERDICT_SANDBOX_NOMAD_TOKEN: "t" }),
    ).toEqual({ addr: "http://nomad:4646", apiToken: "t" });
  });

  it("REFUSES TO BOOT when the two names disagree — that is a split deployment, not a preference", () => {
    // The failure this prevents is silent: sessions run on a cluster the scheduler never looks at, and its
    // capacity is counted against a cluster holding none of them. A typo in either name used to do it.
    expect(() =>
      deploymentNomad({ NOMAD_ADDR: "http://a:4646", EVERDICT_SANDBOX_NOMAD_ADDR: "http://b:4646" }),
    ).toThrow(/cannot point at two/i);
    expect(() =>
      deploymentNomad({ NOMAD_ADDR: "http://a:4646", EVERDICT_SANDBOX_NOMAD_ADDR: "http://a:4646" }),
    ).not.toThrow();
  });

  it("refuses a disagreeing credential or namespace for the same reason", () => {
    const addr = { NOMAD_ADDR: "http://nomad:4646" };
    expect(() => deploymentNomad({ ...addr, NOMAD_TOKEN: "a", EVERDICT_SANDBOX_NOMAD_TOKEN: "b" })).toThrow(
      /NOMAD_TOKEN/,
    );
    expect(() =>
      deploymentNomad({ ...addr, EVERDICT_NOMAD_NAMESPACE: "x", EVERDICT_SANDBOX_NOMAD_NAMESPACE: "y" }),
    ).toThrow(/NAMESPACE/);
  });
});
