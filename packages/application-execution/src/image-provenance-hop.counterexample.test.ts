import type { ComputeHandle, ComputeSpec, Driver, Environment, EvalCase, EvaluableHarness } from "@everdict/contracts";
import { CURRENT_EXECUTION_MANIFEST_ERA, imageResolved } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

// ── THE MANIFEST RECORDS THE DRIVER'S ANSWER, NOT THE CASE'S REQUEST ─────────────────────────────────
//
// The drivers' own tests build the handle themselves, so they cannot see this hop; the manifest's schema
// tests build the manifest by hand, so neither can they. A value dropped HERE looks exactly like a value
// never produced — the same seam the declared-world change had to pin separately, for the same reason.
//
// RED as of 760098e6: `runCase` wrote `...(evalCase.image !== undefined ? { image: evalCase.image } : {})`,
// so the manifest carried the string the case ASKED for. Against a driver that resolved a different
// digest, the assertion below failed as:
//   AssertionError: expected undefined to deeply equal { kind: 'resolved', by: 'driver', … }
// — the request travelled and the read-back answer did not.

const RESOLVED = imageResolved([{ ref: "acme/agent:latest", digest: "sha256:aaaa" }], "driver");

const handle: ComputeHandle = {
  image: RESOLVED,
  exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  writeFile: async () => {},
  readFile: async () => "",
  dispose: async () => {},
};

// A driver that reports bytes DIFFERENT from what the case asked for — so a manifest built from the
// request and one built from the answer cannot look the same.
const driver: Driver = { id: "fake", provision: async (_spec: ComputeSpec) => handle };

const environment: Environment = {
  kind: "prompt",
  seed: async () => {},
  snapshot: async () => ({ kind: "prompt", output: "" }),
};

const harness: EvaluableHarness = {
  id: "fake",
  version: "0",
  install: async () => {},
  async *run() {},
};

const evalCase = {
  id: "c1",
  env: { kind: "prompt" },
  task: "do it",
  image: "acme/agent:latest", // the REQUEST — a mutable tag, which is the whole problem
  graders: [],
  timeoutSec: 60,
  tags: [],
} as EvalCase;

describe("runCase — the execution manifest carries the world the driver provisioned", () => {
  it("records the digest the driver read back, not the mutable tag the case declared", async () => {
    // Given: a case asking for `acme/agent:latest`, and a driver whose handle resolved it to sha256:aaaa
    // When: the case runs
    const result = await runCase(evalCase, {
      driver,
      environment,
      harness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    // Then: the manifest states the BYTES, and declares the era that makes its absence readable
    expect(result.execution?.imageProvenance).toEqual(RESOLVED);
    expect(result.execution?.manifestVersion).toBe(CURRENT_EXECUTION_MANIFEST_ERA);
    // And: the request is no longer copied into the manifest — a reference nobody resolved is not a world
    expect(result.execution?.image).toBeUndefined();
  });
});
