import { describe, expect, it } from "vitest";
import { shouldBypassProxy } from "./no-proxy.js";

// The dialect an operator actually writes. Every case below is a form that curl, the Python requests stack,
// and the Go transport all honour — and that the dispatcher's previous matcher (exact host + dot suffix)
// silently ignored, sending the request through the corporate proxy while the operator's file said otherwise.
describe("shouldBypassProxy — the NO_PROXY grammar an operator writes", () => {
  it("honours CIDR, which is the form a private network is written in", () => {
    expect(shouldBypassProxy("10.4.2.9", "10.0.0.0/8")).toBe(true);
    expect(shouldBypassProxy("11.4.2.9", "10.0.0.0/8")).toBe(false);
    expect(shouldBypassProxy("192.168.1.7", "10.0.0.0/8,192.168.0.0/16")).toBe(true);
    expect(shouldBypassProxy("172.20.0.5", "172.16.0.0/12")).toBe(true);
    expect(shouldBypassProxy("172.32.0.5", "172.16.0.0/12")).toBe(false);
    expect(shouldBypassProxy("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(shouldBypassProxy("10.0.0.2", "10.0.0.1/32")).toBe(false);
  });

  it("honours a bare address prefix, which has no domain suffix to strip", () => {
    expect(shouldBypassProxy("10.4.2.9", "10.")).toBe(true);
    expect(shouldBypassProxy("192.168.1.7", "192.168.")).toBe(true);
    expect(shouldBypassProxy("193.168.1.7", "192.168.")).toBe(false);
  });

  it("honours both spellings of a domain suffix, and never matches a lookalike neighbour", () => {
    expect(shouldBypassProxy("mlflow.corp.internal", ".internal")).toBe(true);
    expect(shouldBypassProxy("mlflow.corp.internal", "internal")).toBe(true);
    expect(shouldBypassProxy("internal", "internal")).toBe(true);
    // `evil-internal.example.com` ends with the letters but is a different host — a suffix is a LABEL suffix.
    expect(shouldBypassProxy("evil-internal.example.com", ".internal")).toBe(false);
    expect(shouldBypassProxy("notmlflow.corp", "mlflow.corp")).toBe(false);
  });

  it("reads a host, a host:port, or a URL — a caller holding any of the three asks the same question", () => {
    expect(shouldBypassProxy("http://mlflow.internal:5000/api/3.0/traces", ".internal")).toBe(true);
    expect(shouldBypassProxy("10.4.2.9:8080", "10.0.0.0/8")).toBe(true);
    expect(shouldBypassProxy("MLflow.Internal", ".internal")).toBe(true);
    expect(shouldBypassProxy("[::1]", "::1")).toBe(true);
  });

  it("accepts comma OR whitespace separation, and `*` as everything", () => {
    expect(shouldBypassProxy("anything.example.com", "*")).toBe(true);
    expect(shouldBypassProxy("mlflow.internal", "localhost 127.0.0.1 .internal")).toBe(true);
    expect(shouldBypassProxy("mlflow.internal", "localhost, 127.0.0.1 , .internal")).toBe(true);
  });

  it("an entry nobody can evaluate matches NOTHING rather than widening the bypass", () => {
    // A typo must not become "bypass everything" (a leak of internal traffic past the inspecting proxy) —
    // it just fails to match, and the operator sees the request still going through the proxy.
    expect(shouldBypassProxy("10.0.0.1", "10.0.0.0/99")).toBe(false);
    expect(shouldBypassProxy("10.0.0.1", "10.0.0.0/")).toBe(false);
    expect(shouldBypassProxy("10.0.0.1", "300.0.0.0/8")).toBe(false);
    expect(shouldBypassProxy("fd00::1", "fd00::/8")).toBe(false); // IPv6 CIDR is not claimed, so it decides nothing
    expect(shouldBypassProxy("10.0.0.1", "")).toBe(false);
    expect(shouldBypassProxy("10.0.0.1", undefined)).toBe(false);
  });

  it("`0.0.0.0/0` is a whole-internet bypass, and says so", () => {
    expect(shouldBypassProxy("93.184.216.34", "0.0.0.0/0")).toBe(true);
  });
});
