import { describe, expect, it } from "vitest";

import { type CapabilityAccess, canConsumeCapability, filterConsumableCapabilities } from "./capability-visibility.js";

const cap = (over: Partial<CapabilityAccess>): CapabilityAccess => ({
  tenant: "acme",
  visibility: "private",
  sharedWith: [],
  createdBy: "alice",
  ...over,
});

describe("canConsumeCapability", () => {
  it("makes a private capability readable only by its creator in the owning workspace", () => {
    const c = cap({ visibility: "private", tenant: "acme", createdBy: "alice" });
    expect(canConsumeCapability(c, { tenant: "acme", subject: "alice" })).toBe(true);
    expect(canConsumeCapability(c, { tenant: "acme", subject: "bob" })).toBe(false);
  });

  it("makes a workspace capability readable by any member of the owning workspace, no one outside", () => {
    const c = cap({ visibility: "workspace", tenant: "acme" });
    expect(canConsumeCapability(c, { tenant: "acme", subject: "bob" })).toBe(true);
    expect(canConsumeCapability(c, { tenant: "other", subject: "bob" })).toBe(false);
  });

  it("makes a subset capability readable by the owner and by workspaces explicitly in sharedWith", () => {
    const c = cap({ visibility: "subset", tenant: "acme", sharedWith: ["beta", "gamma"] });
    expect(canConsumeCapability(c, { tenant: "acme", subject: "alice" })).toBe(true); // the owner
    expect(canConsumeCapability(c, { tenant: "beta", subject: "carol" })).toBe(true); // a shared target's member
    expect(canConsumeCapability(c, { tenant: "delta", subject: "carol" })).toBe(false); // not in the subset
  });

  it("makes a public capability readable by any workspace member", () => {
    expect(canConsumeCapability(cap({ visibility: "public" }), { tenant: "anyone", subject: "x" })).toBe(true);
  });

  it("never leaks a private capability cross-tenant, even to a same-named subject in another workspace", () => {
    const c = cap({ visibility: "private", tenant: "acme", createdBy: "alice" });
    expect(canConsumeCapability(c, { tenant: "beta", subject: "alice" })).toBe(false);
  });

  it("never leaks a workspace capability to another workspace (only subset/public cross the boundary)", () => {
    const c = cap({ visibility: "workspace", tenant: "acme" });
    expect(canConsumeCapability(c, { tenant: "beta", subject: "bob" })).toBe(false);
  });
});

describe("filterConsumableCapabilities", () => {
  it("keeps only the capabilities the consumer may use", () => {
    const consumer = { tenant: "beta", subject: "carol" };
    const caps = [
      cap({ visibility: "public", tenant: "acme" }),
      cap({ visibility: "subset", tenant: "acme", sharedWith: ["beta"] }),
      cap({ visibility: "workspace", tenant: "acme" }), // not beta's → excluded
      cap({ visibility: "private", tenant: "beta", createdBy: "carol" }), // carol's own private
      cap({ visibility: "private", tenant: "beta", createdBy: "dave" }), // someone else's private → excluded
    ];
    expect(filterConsumableCapabilities(caps, consumer)).toHaveLength(3);
  });
});
