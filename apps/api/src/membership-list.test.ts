import { InMemoryUserProfileStore, InMemoryWorkspaceInviteStore, InMemoryWorkspaceStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { MembershipService } from "./membership-service.js";

async function seed() {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = admin
  await store.ensureMembership("acme", "bob", "member", "bob@acme.io"); // email 캡처
  const profiles = new InMemoryUserProfileStore();
  const svc = new MembershipService(store, new InMemoryWorkspaceInviteStore(store), profiles);
  return { store, profiles, svc };
}

describe("MembershipService.listMembers (프로필 보강)", () => {
  it("프로필이 있으면 opaque subject 를 이름/아바타로 보강한다", async () => {
    const { profiles, svc } = await seed();
    await profiles.upsert("alice", { name: "Alice Kim", avatarUrl: "https://cdn/a.png" });

    const members = await svc.listMembers("acme");
    const alice = members.find((m) => m.subject === "alice");

    expect(alice).toMatchObject({ name: "Alice Kim", avatarUrl: "https://cdn/a.png", role: "admin" });
  });

  it("프로필이 없는 멤버는 name/avatarUrl 없이 그대로 반환한다(email 만 표시)", async () => {
    const { svc } = await seed();

    const members = await svc.listMembers("acme");
    const bob = members.find((m) => m.subject === "bob");

    expect(bob?.email).toBe("bob@acme.io");
    expect(bob?.name).toBeUndefined();
    expect(bob?.avatarUrl).toBeUndefined();
  });
});
