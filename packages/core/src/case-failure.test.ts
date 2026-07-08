import { describe, expect, it } from "vitest";
import { OOM_KILLED, classifyFailure } from "./case-failure.js";
import { BadRequestError, InternalError, UpstreamError } from "./errors.js";

describe("classifyFailure (failure taxonomy: where it died × whose fault)", () => {
  it("an upstream/backend error is retryable infra (placement blips, log races, network)", () => {
    const f = classifyFailure(new UpstreamError("UPSTREAM_ERROR", {}, "Nomad job submission failed"), "dispatch");
    expect(f).toMatchObject({ stage: "dispatch", class: "infra", code: "UPSTREAM_ERROR", retryable: true });
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
});
