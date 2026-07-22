import { type CaseJob, type CaseResult, UpstreamError } from "@everdict/contracts";
import { CircuitBreaker } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { executeWithSpillover } from "./runtime-spillover.js";

const jobOn = (target: string): CaseJob => ({
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
    placement: { target },
  },
  harness: { id: "h", version: "1" },
  tenant: "acme",
});

const okResult: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [{ graderId: "g", metric: "ok", value: 1, pass: true }],
};

const infraDown = new UpstreamError("UPSTREAM_ERROR", {}, "cluster unreachable");

describe("executeWithSpillover", () => {
  it("passes through untouched when the batch has a single runtime", async () => {
    const breaker = new CircuitBreaker({ now: () => 0 });
    const seen: string[] = [];
    await expect(
      executeWithSpillover(
        async (j) => {
          seen.push(j.evalCase.placement?.target ?? "?");
          throw infraDown;
        },
        jobOn("nomad"),
        { targets: ["nomad"], tenant: "acme", breaker },
      ),
    ).rejects.toThrow("cluster unreachable");
    expect(seen).toEqual(["nomad"]); // no second attempt — the outer transient retry owns single-runtime batches
  });

  it("spills a retryable infra failure to the next runtime in the shard list", async () => {
    const breaker = new CircuitBreaker({ now: () => 0 });
    const seen: string[] = [];
    const spills: string[] = [];
    const outcome = await executeWithSpillover(
      async (j) => {
        const t = j.evalCase.placement?.target ?? "?";
        seen.push(t);
        if (t === "nomad") throw infraDown;
        return okResult;
      },
      jobOn("nomad"),
      {
        targets: ["nomad", "kind"],
        tenant: "acme",
        breaker,
        onSpill: (caseId, from, to) => spills.push(`${caseId}:${from}->${to}`),
      },
    );
    expect(seen).toEqual(["nomad", "kind"]);
    expect(outcome.target).toBe("kind");
    expect(spills).toEqual(["c1:nomad->kind"]);
  });

  it("skips a runtime whose circuit is open and goes straight to a healthy one", async () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: () => 0 });
    breaker.failure("acme:nomad"); // open
    const seen: string[] = [];
    const outcome = await executeWithSpillover(
      async (j) => {
        seen.push(j.evalCase.placement?.target ?? "?");
        return okResult;
      },
      jobOn("nomad"),
      { targets: ["nomad", "kind"], tenant: "acme", breaker },
    );
    expect(seen).toEqual(["kind"]); // no timeout burned against the open circuit
    expect(outcome.target).toBe("kind");
  });

  it("still probes when every runtime's circuit is open", async () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: () => 0 });
    breaker.failure("acme:nomad");
    breaker.failure("acme:kind");
    const seen: string[] = [];
    const outcome = await executeWithSpillover(
      async (j) => {
        seen.push(j.evalCase.placement?.target ?? "?");
        return okResult;
      },
      jobOn("nomad"),
      { targets: ["nomad", "kind"], tenant: "acme", breaker },
    );
    expect(seen).toEqual(["nomad"]); // assigned-first order kept among open circuits
    expect(outcome.target).toBe("nomad");
    expect(breaker.isOpen("acme:nomad")).toBe(false); // probe success closed the circuit
  });

  it("does not spill fatal infra (OOM) — rethrows immediately", async () => {
    const breaker = new CircuitBreaker({ now: () => 0 });
    const oom = new UpstreamError("UPSTREAM_ERROR", { signal: "OOM_KILLED" }, "task OOM-killed");
    const seen: string[] = [];
    await expect(
      executeWithSpillover(
        async (j) => {
          seen.push(j.evalCase.placement?.target ?? "?");
          throw oom;
        },
        jobOn("nomad"),
        { targets: ["nomad", "kind"], tenant: "acme", breaker },
      ),
    ).rejects.toThrow("OOM-killed");
    expect(seen).toEqual(["nomad"]); // the same resources would die on kind too
  });

  it("throws the last error when every runtime fails, and opens circuits along the way", async () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: () => 0 });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await expect(
        executeWithSpillover(
          async (j) => {
            seen.push(j.evalCase.placement?.target ?? "?");
            throw infraDown;
          },
          jobOn("nomad"),
          { targets: ["nomad", "kind"], tenant: "acme", breaker },
        ),
      ).rejects.toThrow("cluster unreachable");
    }
    expect(seen).toEqual(["nomad", "kind", "nomad", "kind", "nomad", "kind"]);
    expect(breaker.isOpen("acme:nomad")).toBe(true);
    expect(breaker.isOpen("acme:kind")).toBe(true);
  });

  it("records breaker success on the runtime that actually ran the case", async () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: () => 0 });
    breaker.failure("acme:kind");
    breaker.failure("acme:kind");
    await executeWithSpillover(
      async (j) => {
        if (j.evalCase.placement?.target === "nomad") throw infraDown;
        return okResult;
      },
      jobOn("nomad"),
      { targets: ["nomad", "kind"], tenant: "acme", breaker },
    );
    expect(breaker.stats()["acme:kind"]).toBeUndefined(); // success cleared the pending count
    expect(breaker.stats()["acme:nomad"]?.consecutive).toBe(1);
  });
});
