import { AppError } from "@assay/core";
import { InMemoryWorkspaceInviteStore, InMemoryWorkspaceStore } from "@assay/db";
import { describe, expect, it } from "vitest";
import { MembershipService } from "./membership-service.js";

async function seed() {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = admin
  const svc = new MembershipService(store, new InMemoryWorkspaceInviteStore(store));
  return { store, svc };
}

describe("MembershipService.leaveWorkspace", () => {
  it("멤버가 아니면 멱등 no-op(에러 없음)", async () => {
    const { svc } = await seed();
    await expect(svc.leaveWorkspace("acme", "stranger")).resolves.toBeUndefined();
  });

  it("일반 멤버는 나갈 수 있다", async () => {
    const { store, svc } = await seed();
    await store.ensureMembership("acme", "bob", "member");
    await svc.leaveWorkspace("acme", "bob");
    expect((await store.listMembers("acme")).map((m) => m.subject)).toEqual(["alice"]);
  });

  it("마지막 admin 은 나갈 수 없다(409 CONFLICT)", async () => {
    const { svc } = await seed();
    await expect(svc.leaveWorkspace("acme", "alice")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(svc.leaveWorkspace("acme", "alice")).rejects.toBeInstanceOf(AppError);
  });

  it("admin 이 둘이면 한 명은 나갈 수 있다", async () => {
    const { store, svc } = await seed();
    await store.ensureMembership("acme", "carol", "admin");
    await svc.leaveWorkspace("acme", "alice");
    const left = await store.listMembers("acme");
    expect(left.map((m) => m.subject)).toEqual(["carol"]);
  });
});
