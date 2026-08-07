import { BadRequestError, InternalError, OOM_KILLED, UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { classifyFailure, stageForError } from "./case-failure.js";

describe("classifyFailure (failure taxonomy: where it died × whose fault)", () => {
  it("an upstream/backend error is retryable infra (placement blips, log races, network)", () => {
    const f = classifyFailure(new UpstreamError("UPSTREAM_ERROR", {}, "Nomad job submission failed"), "dispatch");
    expect(f).toMatchObject({ stage: "dispatch", class: "infra", code: "UPSTREAM_ERROR", retryable: true });
  });

  it("carries the self-hosted runnerId from a no_runner dispatch failure so the result links to that runner", () => {
    const err = new UpstreamError(
      "UPSTREAM_ERROR",
      { runnerId: "laptop", reason: "no_runner" },
      "No self-hosted runner activity — no runner is connected, or it is idle/dead.",
    );
    const f = classifyFailure(err, "dispatch");
    expect(f).toMatchObject({ stage: "dispatch", class: "infra", code: "UPSTREAM_ERROR", runnerId: "laptop" });
  });

  it("omits runnerId for a managed-backend failure that names no runner", () => {
    const f = classifyFailure(new UpstreamError("UPSTREAM_ERROR", {}, "Nomad job submission failed"), "dispatch");
    expect(f.runnerId).toBeUndefined();
  });

  it("an OOM-killed alloc is FATAL infra — retrying with the same limits fails again", () => {
    const err = new UpstreamError("UPSTREAM_ERROR", { signal: OOM_KILLED }, "task OOM-killed (raise resources)");
    const f = classifyFailure(err, "run");
    expect(f).toMatchObject({ class: "infra", code: OOM_KILLED, retryable: false });
  });

  it("a missing secret / bad pin is config — retrying changes nothing", () => {
    const f = classifyFailure(new BadRequestError("BAD_REQUEST", {}, "secret OPENAI_API_KEY is not set"), "dispatch");
    expect(f).toMatchObject({ class: "config", retryable: false });
  });

  it("a harness install/run failure is the harness's own fault — same input, same failure", () => {
    const f = classifyFailure(new InternalError("HARNESS_RUN_FAILED", {}, "command exit 127"), "run");
    expect(f).toMatchObject({ class: "harness", code: "HARNESS_RUN_FAILED", retryable: false });
  });

  it("an unknown raw throw defaults to retryable infra (the previous every-throw-retries behavior)", () => {
    const f = classifyFailure(new Error("socket hang up"), "dispatch");
    expect(f).toMatchObject({ class: "infra", code: "INTERNAL", retryable: true });
  });

  it("lifts the backend's failure evidence (extra.placement + extra.logTail) onto the CaseFailure", () => {
    // Regression: only signal/runnerId used to survive out of extra — the alloc/pod identity, events, and the
    // log tail (captured before the job vanished) were dropped at this boundary.
    const err = new UpstreamError(
      "UPSTREAM_ERROR",
      {
        alloc: "a1",
        placement: { unit: "a1", node: "worker-2", events: ["Driver Failure: Failed to pull image"] },
        logTail: "panic: boom",
      },
      "alloc failed — Driver Failure: Failed to pull image",
    );
    const f = classifyFailure(err, "dispatch");
    expect(f.placement).toEqual({ unit: "a1", node: "worker-2", events: ["Driver Failure: Failed to pull image"] });
    expect(f.logTail).toBe("panic: boom");
  });

  it("ignores a malformed evidence extra (never breaks classification)", () => {
    const err = new UpstreamError("UPSTREAM_ERROR", { placement: "not-an-object", logTail: 42 }, "alloc failed");
    const f = classifyFailure(err, "dispatch");
    expect(f.placement).toBeUndefined();
    expect(f.logTail).toBeUndefined();
    expect(f).toMatchObject({ class: "infra", retryable: true });
  });
});

describe("stageForError (which pipeline stage an error code names)", () => {
  it("harness codes name their own stage; driver provisioning is dispatch-side", () => {
    expect(stageForError(new InternalError("HARNESS_INSTALL_FAILED", {}, "pip failed"))).toBe("install");
    expect(stageForError(new InternalError("HARNESS_RUN_FAILED", {}, "exit 127"))).toBe("run");
    expect(stageForError(new InternalError("GRADER_FAILED", {}, "cmd"))).toBe("grade");
    expect(stageForError(new InternalError("DRIVER_PROVISION_FAILED", {}, "no docker"))).toBe("dispatch");
    expect(stageForError(new Error("raw"))).toBe("run");
  });
});

describe("collect-stage classification", () => {
  it("a trace-collection failure is retryable COLLECT-stage infra", () => {
    const err = new UpstreamError("TRACE_COLLECT_FAILED", { runId: "r1" }, "trace collection failed: 502");
    expect(stageForError(err)).toBe("collect");
    expect(classifyFailure(err, stageForError(err))).toMatchObject({
      stage: "collect",
      class: "infra",
      retryable: true,
    });
  });
});

describe("classifyFailure — a deliberate stop is never retryable", () => {
  it("classifies a CANCELLED error as non-retryable infra (a retry would un-stop a stop)", () => {
    // Pre-fix: CANCELLED matched no set and fell to the unknown-throw default (retryable infra), so a
    // batch's inner retry loop re-dispatched a case the user had just cancelled.
    const failure = classifyFailure(
      new UpstreamError("CANCELLED", { runId: "r1" }, "Run cancelled — the batch was stopped."),
      "run",
    );
    expect(failure.code).toBe("CANCELLED");
    expect(failure.retryable).toBe(false);
  });
});
