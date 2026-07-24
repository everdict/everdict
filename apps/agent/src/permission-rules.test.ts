import { describe, expect, it } from "vitest";
import { PermissionRules } from "./permission-rules.js";

describe("PermissionRules", () => {
  it("returns undefined until a rule is set, then the standing decision", () => {
    const r = new PermissionRules();
    expect(r.get("acme", "s1", "do_write")).toBeUndefined();
    r.set("acme", "s1", "do_write", "allow");
    expect(r.get("acme", "s1", "do_write")).toBe("allow");
    r.set("acme", "s1", "do_write", "deny"); // replace
    expect(r.get("acme", "s1", "do_write")).toBe("deny");
  });

  it("clears a rule so the tool asks again", () => {
    const r = new PermissionRules();
    r.set("acme", "s1", "do_write", "allow");
    r.clear("acme", "s1", "do_write");
    expect(r.get("acme", "s1", "do_write")).toBeUndefined();
    expect(() => r.clear("acme", "s1", "missing")).not.toThrow();
  });

  it("isolates rules by workspace and session", () => {
    const r = new PermissionRules();
    r.set("acme", "s1", "t", "allow");
    r.set("acme", "s2", "t", "deny");
    r.set("other", "s1", "t", "deny");
    expect(r.get("acme", "s1", "t")).toBe("allow");
    expect(r.get("acme", "s2", "t")).toBe("deny");
    expect(r.get("other", "s1", "t")).toBe("deny");
    expect(r.list("acme", "s1")).toEqual({ t: "allow" });
  });
});
