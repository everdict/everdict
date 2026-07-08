import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("stays closed below the threshold and opens at it", () => {
    const t = 0;
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => t });
    breaker.failure("acme:nomad");
    breaker.failure("acme:nomad");
    expect(breaker.isOpen("acme:nomad")).toBe(false);
    breaker.failure("acme:nomad");
    expect(breaker.isOpen("acme:nomad")).toBe(true);
  });

  it("success resets the circuit completely", () => {
    const t = 0;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => t });
    breaker.failure("k");
    breaker.failure("k");
    expect(breaker.isOpen("k")).toBe(true);
    breaker.success("k");
    expect(breaker.isOpen("k")).toBe(false);
    // fresh count: one failure doesn't reopen
    breaker.failure("k");
    expect(breaker.isOpen("k")).toBe(false);
  });

  it("half-open after cooldown: one probe allowed, a failure re-opens for a fresh cooldown", () => {
    let t = 0;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => t });
    breaker.failure("k");
    breaker.failure("k");
    expect(breaker.isOpen("k")).toBe(true);
    t = 1000; // cooldown elapsed → half-open probe allowed
    expect(breaker.isOpen("k")).toBe(false);
    breaker.failure("k"); // probe failed → re-open with a fresh cooldown
    expect(breaker.isOpen("k")).toBe(true);
    t = 1999;
    expect(breaker.isOpen("k")).toBe(true);
    t = 2000;
    expect(breaker.isOpen("k")).toBe(false);
  });

  it("keys are independent", () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, now: () => 0 });
    breaker.failure("a");
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
  });

  it("stats reports consecutive counts and open state", () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => 0 });
    breaker.failure("a");
    breaker.failure("a");
    breaker.failure("b");
    expect(breaker.stats()).toEqual({
      a: { consecutive: 2, open: true },
      b: { consecutive: 1, open: false },
    });
  });
});
