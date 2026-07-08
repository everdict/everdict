import { BadRequestError } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { parseTenantMap } from "./scheduling-config.js";

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
