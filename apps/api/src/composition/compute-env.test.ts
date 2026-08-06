import { describe, expect, it } from "vitest";
import { deploymentCompute } from "./compute-env.js";

// Agent worlds, the harness playground and "Run this file" all need the same thing: somewhere this control
// plane can hold a container open. These are the rules that keep that ONE answer.

describe("deploymentCompute — one place to run things", () => {
  it("is absent when the operator configured no compute at all", () => {
    expect(deploymentCompute({})).toBeUndefined();
  });

  it("EVERDICT_COMPUTE turns on every lane at once", () => {
    expect(deploymentCompute({ EVERDICT_COMPUTE: "nomad" })).toEqual({
      kind: "nomad",
      sandboxes: true,
      fileRuns: true,
    });
  });

  it("a per-lane name still enables only that lane — enabling worlds must not silently enable file runs", () => {
    expect(deploymentCompute({ EVERDICT_SANDBOX_DRIVER: "docker" })).toEqual({
      kind: "docker",
      sandboxes: true,
      fileRuns: false,
    });
    expect(deploymentCompute({ EVERDICT_FILE_EXECUTION_DRIVER: "docker" })).toEqual({
      kind: "docker",
      sandboxes: false,
      fileRuns: true,
    });
  });

  it("REFUSES TO BOOT when two lanes name different kinds — the deployment has one place to run things", () => {
    expect(() =>
      deploymentCompute({ EVERDICT_SANDBOX_DRIVER: "nomad", EVERDICT_FILE_EXECUTION_DRIVER: "docker" }),
    ).toThrow(/one place to run things/i);
  });

  it("REFUSES TO BOOT on an unknown kind — it used to warn and quietly disable what the operator asked for", () => {
    expect(() => deploymentCompute({ EVERDICT_SANDBOX_DRIVER: "kubernetes" })).toThrow(/not a compute kind/i);
  });
});
