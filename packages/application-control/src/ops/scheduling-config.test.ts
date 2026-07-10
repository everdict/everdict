import { BadRequestError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { parseAutoscale, parseTenantMap } from "./scheduling-config.js";

describe("parseTenantMap (operator fairness dials)", () => {
  it("parses tenant=value pairs with a '*' default for unlisted tenants", () => {
    const map = parseTenantMap("acme=8, beta=4 ,*=16", "EVERDICT_TENANT_QUOTAS");
    expect(map?.get("acme")).toBe(8);
    expect(map?.get("beta")).toBe(4);
    expect(map?.get("gamma")).toBe(16); // falls to "*"
  });

  it("without a '*' default, unlisted tenants resolve to undefined (caller applies its own default)", () => {
    const map = parseTenantMap("acme=3", "EVERDICT_TENANT_WEIGHTS");
    expect(map?.get("acme")).toBe(3);
    expect(map?.get("other")).toBeUndefined();
  });

  it("unset/empty env → undefined (the dial is simply off)", () => {
    expect(parseTenantMap(undefined, "E")).toBeUndefined();
    expect(parseTenantMap("  ", "E")).toBeUndefined();
  });

  it("malformed entries fail the boot loudly instead of running unfair for weeks", () => {
    expect(() => parseTenantMap("acme=abc", "E")).toThrow(BadRequestError);
    expect(() => parseTenantMap("acme", "E")).toThrow(BadRequestError);
    expect(() => parseTenantMap("=5", "E")).toThrow(BadRequestError);
    expect(() => parseTenantMap("acme=0", "E")).toThrow(BadRequestError); // zero quota = a typo, not a policy
  });
});

describe("parseAutoscale (EVERDICT_AUTOSCALE)", () => {
  it('parses "min:max" and "min:max:intervalMs"', () => {
    expect(parseAutoscale("1:8")).toEqual({ min: 1, max: 8 });
    expect(parseAutoscale("0:16:2000")).toEqual({ min: 0, max: 16, intervalMs: 2000 });
  });

  it("unset/empty → undefined (autoscaling off)", () => {
    expect(parseAutoscale(undefined)).toBeUndefined();
    expect(parseAutoscale(" ")).toBeUndefined();
  });

  it("malformed values fail the boot loudly", () => {
    expect(() => parseAutoscale("8")).toThrow(BadRequestError);
    expect(() => parseAutoscale("8:1")).toThrow(BadRequestError); // min > max
    expect(() => parseAutoscale("1:abc")).toThrow(BadRequestError);
    expect(() => parseAutoscale("1:8:50")).toThrow(BadRequestError); // sub-100ms tick = a typo
  });
});
