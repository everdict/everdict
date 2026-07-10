import { ConflictError } from "@everdict/contracts";
import type { MemberRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { MembershipPolicy } from "./membership-policy.js";

function member(subject: string, role: string): MemberRecord {
  return { subject, role, addedAt: "2026-07-10T00:00:00.000Z" };
}

const policy = new MembershipPolicy();

describe("MembershipPolicy — the last-admin invariant (one owner, three guards)", () => {
  describe("assertNotLastAdminDemotion (role change)", () => {
    it("rejects demoting the sole admin with the exact 409 surface", () => {
      const alice = member("alice", "admin");
      const members = [alice, member("bob", "member")];
      let thrown: unknown;
      try {
        policy.assertNotLastAdminDemotion("acme", members, alice, "member");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConflictError);
      const err = thrown as ConflictError;
      expect(err.toEnvelope()).toEqual({
        code: "CONFLICT",
        message: "The last admin cannot be demoted.",
        data: { workspace: "acme" },
      });
    });

    it("allows re-affirming admin on the sole admin (not a demotion)", () => {
      const alice = member("alice", "admin");
      expect(() => policy.assertNotLastAdminDemotion("acme", [alice], alice, "admin")).not.toThrow();
    });

    it("allows demoting an admin when another admin remains", () => {
      const alice = member("alice", "admin");
      const members = [alice, member("carol", "admin")];
      expect(() => policy.assertNotLastAdminDemotion("acme", members, alice, "viewer")).not.toThrow();
    });

    it("allows changing a non-admin member's role even with a single admin present", () => {
      const bob = member("bob", "member");
      const members = [member("alice", "admin"), bob];
      expect(() => policy.assertNotLastAdminDemotion("acme", members, bob, "viewer")).not.toThrow();
    });
  });

  describe("assertNotLastAdminRemoval (removal by an admin)", () => {
    it("rejects removing the sole admin with the exact 409 surface", () => {
      const alice = member("alice", "admin");
      const members = [alice, member("bob", "member")];
      let thrown: unknown;
      try {
        policy.assertNotLastAdminRemoval("acme", members, alice);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConflictError);
      const err = thrown as ConflictError;
      expect(err.toEnvelope()).toEqual({
        code: "CONFLICT",
        message: "The last admin cannot be removed.",
        data: { workspace: "acme" },
      });
    });

    it("allows removing an admin when another admin remains", () => {
      const alice = member("alice", "admin");
      const members = [alice, member("carol", "admin")];
      expect(() => policy.assertNotLastAdminRemoval("acme", members, alice)).not.toThrow();
    });

    it("allows removing a regular member", () => {
      const bob = member("bob", "member");
      const members = [member("alice", "admin"), bob];
      expect(() => policy.assertNotLastAdminRemoval("acme", members, bob)).not.toThrow();
    });
  });

  describe("assertCanLeave (self-serve leave)", () => {
    it("rejects the sole admin leaving with the exact 409 surface (delegate-or-delete hint)", () => {
      const alice = member("alice", "admin");
      const members = [alice, member("bob", "member")];
      let thrown: unknown;
      try {
        policy.assertCanLeave("acme", members, alice);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConflictError);
      const err = thrown as ConflictError;
      expect(err.toEnvelope()).toEqual({
        code: "CONFLICT",
        message: "The last admin cannot leave. Delegate admin to another member or delete the workspace.",
        data: { workspace: "acme" },
      });
    });

    it("allows an admin to leave when another admin remains", () => {
      const alice = member("alice", "admin");
      const members = [alice, member("carol", "admin")];
      expect(() => policy.assertCanLeave("acme", members, alice)).not.toThrow();
    });

    it("allows a regular member to leave even with a single admin present", () => {
      const bob = member("bob", "member");
      const members = [member("alice", "admin"), bob];
      expect(() => policy.assertCanLeave("acme", members, bob)).not.toThrow();
    });
  });
});
