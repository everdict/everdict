import { AppError } from "@everdict/core";
import { InMemoryUserProfileStore, InMemoryWorkspaceInviteStore, InMemoryWorkspaceStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { MembershipService } from "../../core/member/membership-service.js";

async function seed() {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = admin
  const svc = new MembershipService(store, new InMemoryWorkspaceInviteStore(store), new InMemoryUserProfileStore());
  return { store, svc };
}

describe("MembershipService.leaveWorkspace", () => {
  it("no-op idempotent if not a member (no error)", async () => {
    const { svc } = await seed();
    await expect(svc.leaveWorkspace("acme", "stranger")).resolves.toBeUndefined();
  });

  it("a regular member can leave", async () => {
    const { store, svc } = await seed();
    await store.ensureMembership("acme", "bob", "member");
    await svc.leaveWorkspace("acme", "bob");
    expect((await store.listMembers("acme")).map((m) => m.subject)).toEqual(["alice"]);
  });

  it("the last admin cannot leave (409 CONFLICT)", async () => {
    const { svc } = await seed();
    await expect(svc.leaveWorkspace("acme", "alice")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(svc.leaveWorkspace("acme", "alice")).rejects.toBeInstanceOf(AppError);
  });

  it("with two admins, one can leave", async () => {
    const { store, svc } = await seed();
    await store.ensureMembership("acme", "carol", "admin");
    await svc.leaveWorkspace("acme", "alice");
    const left = await store.listMembers("acme");
    expect(left.map((m) => m.subject)).toEqual(["carol"]);
  });
});

describe("MembershipService — member-removal hook (onMemberRemoved, auto-disable scheduled evals)", () => {
  it("calls the hook on a successful leave/remove; not called on no-op (not a member) or blocked (last admin)", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "member");
    const calls: Array<{ ws: string; sub: string }> = [];
    const svc = new MembershipService(
      store,
      new InMemoryWorkspaceInviteStore(store),
      new InMemoryUserProfileStore(),
      async (ws, sub) => {
        calls.push({ ws, sub });
      },
    );
    await svc.leaveWorkspace("acme", "stranger"); // not a member → no-op
    expect(calls).toEqual([]);
    await svc.leaveWorkspace("acme", "bob"); // success → hook
    expect(calls).toEqual([{ ws: "acme", sub: "bob" }]);
    await expect(svc.removeMember("acme", "alice")).rejects.toMatchObject({ code: "CONFLICT" }); // last admin
    expect(calls).toEqual([{ ws: "acme", sub: "bob" }]); // not called when blocked
  });

  it("member removal succeeds even if the hook throws (best-effort)", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "member");
    const svc = new MembershipService(
      store,
      new InMemoryWorkspaceInviteStore(store),
      new InMemoryUserProfileStore(),
      async () => {
        throw new Error("hook boom");
      },
    );
    await expect(svc.leaveWorkspace("acme", "bob")).resolves.toBeUndefined();
    expect((await store.listMembers("acme")).map((m) => m.subject)).toEqual(["alice"]);
  });
});
