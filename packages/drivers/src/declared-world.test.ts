import type { ComputeSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { dockerWorldArgs } from "./docker.js";
import { LocalDriver } from "./local.js";

// ── A DECLARED WORLD IS ENFORCED OR REFUSED, NEVER IGNORED ──────────────────────────────────────────
//
// `EvalCase.resources` / `EvalCase.network` exist because a benchmark task's box size and network reach are
// part of what it MEASURES: an under-provisioned case reads as an agent that failed, and an offline task
// that ran online answered a different question. The failure mode both share is silence — the result has
// the same shape either way — so the rule is the one `ComputeSpec.os` already follows: an execution site
// that cannot provide the declared world refuses BEFORE execution.
//
// These tests are the counterexamples for that rule. Dropping the enforcement (returning [] from
// dockerWorldArgs, or deleting a guard in LocalDriver.provision) makes them red.

const spec = (over: Partial<ComputeSpec>): ComputeSpec => ({ os: "linux", needs: ["shell"], ...over });

describe("dockerWorldArgs — the declared world becomes docker flags", () => {
  it("asks for nothing when the case declared nothing (absence keeps meaning what it meant)", () => {
    expect(dockerWorldArgs(spec({}), "DockerDriver")).toEqual([]);
    expect(dockerWorldArgs(spec({ resources: {} }), "DockerDriver")).toEqual([]);
    expect(dockerWorldArgs(spec({ network: { mode: "public", allowedHosts: [] } }), "DockerDriver")).toEqual([]);
  });

  it("translates cpu millicores, memory and gpu into the flags docker enforces", () => {
    const args = dockerWorldArgs(spec({ resources: { cpu: 2000, memoryMb: 4096, gpu: 1 } }), "DockerDriver");
    expect(args).toEqual(["--cpus", "2", "--memory", "4096m", "--gpus", "1"]);
  });

  it("carries a fractional cpu ask through instead of rounding it away", () => {
    expect(dockerWorldArgs(spec({ resources: { cpu: 500 } }), "DockerDriver")).toEqual(["--cpus", "0.5"]);
  });

  it("isolates a case that declared no network", () => {
    expect(dockerWorldArgs(spec({ network: { mode: "none", allowedHosts: [] } }), "DockerDriver")).toEqual([
      "--network",
      "none",
    ]);
  });

  // THE REFUSAL. Docker has no egress filter here, so the only two honest outcomes are "refuse" and
  // "enforce". Running the case with full internet and reporting the score is the third one, and it is the
  // one that silently changes what the benchmark measured.
  it("refuses an egress allowlist it cannot enforce, rather than running the case with full network", () => {
    expect(() =>
      dockerWorldArgs(spec({ network: { mode: "allowlist", allowedHosts: ["pypi.org"] } }), "DockerDriver"),
    ).toThrow(/cannot enforce an egress allowlist/);
  });
});

describe("LocalDriver — a host process is not a box with a size or a network of its own", () => {
  it("refuses a case that declared a resource limit", async () => {
    await expect(new LocalDriver().provision(spec({ resources: { memoryMb: 2048 } }))).rejects.toThrow(
      /cannot enforce a cpu\/memory\/gpu limit/,
    );
  });

  it("refuses a case that declared an offline world", async () => {
    await expect(new LocalDriver().provision(spec({ network: { mode: "none", allowedHosts: [] } }))).rejects.toThrow(
      /cannot enforce a network policy/,
    );
  });

  it("still runs a case that declared nothing, and one whose declaration asks for nothing", async () => {
    for (const over of [{}, { resources: {} }, { network: { mode: "public" as const, allowedHosts: [] } }]) {
      const handle = await new LocalDriver().provision(spec(over));
      await handle.dispose();
    }
  });
});
