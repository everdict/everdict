import { InMemoryUserProfileStore, InMemoryWorkspaceInviteStore, InMemoryWorkspaceStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { MembershipService } from "../../core/member/membership-service.js";

async function seed() {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = admin
  await store.ensureMembership("acme", "bob", "member", "bob@acme.io"); // capture email
  const profiles = new InMemoryUserProfileStore();
  const svc = new MembershipService(store, new InMemoryWorkspaceInviteStore(store), profiles);
  return { store, profiles, svc };
}

describe("MembershipService.listMembers (profile enrichment)", () => {
  it("enriches an opaque subject with name/avatar when a profile exists", async () => {
    const { profiles, svc } = await seed();
    await profiles.upsert("alice", { name: "Alice Kim", avatarUrl: "https://cdn/a.png" });

    const members = await svc.listMembers("acme");
    const alice = members.find((m) => m.subject === "alice");

    expect(alice).toMatchObject({ name: "Alice Kim", avatarUrl: "https://cdn/a.png", role: "admin" });
  });

  it("a member without a profile is returned as-is without name/avatarUrl (email only)", async () => {
    const { svc } = await seed();

    const members = await svc.listMembers("acme");
    const bob = members.find((m) => m.subject === "bob");

    expect(bob?.email).toBe("bob@acme.io");
    expect(bob?.name).toBeUndefined();
    expect(bob?.avatarUrl).toBeUndefined();
  });
});
