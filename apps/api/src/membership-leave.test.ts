import { AppError } from "@everdict/core";
import { InMemoryUserProfileStore, InMemoryWorkspaceInviteStore, InMemoryWorkspaceStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { MembershipService } from "./membership-service.js";

async function seed() {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = admin
  const svc = new MembershipService(store, new InMemoryWorkspaceInviteStore(store), new InMemoryUserProfileStore());
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

describe("MembershipService — 멤버 제거 훅(onMemberRemoved, 예약 자동 비활성)", () => {
  it("성공한 leave/remove 시 훅 호출; no-op(멤버 아님)·차단(마지막 admin) 시 미호출", async () => {
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
    await svc.leaveWorkspace("acme", "stranger"); // 멤버 아님 → no-op
    expect(calls).toEqual([]);
    await svc.leaveWorkspace("acme", "bob"); // 성공 → 훅
    expect(calls).toEqual([{ ws: "acme", sub: "bob" }]);
    await expect(svc.removeMember("acme", "alice")).rejects.toMatchObject({ code: "CONFLICT" }); // 마지막 admin
    expect(calls).toEqual([{ ws: "acme", sub: "bob" }]); // 차단 시 미호출
  });

  it("훅이 throw 해도 멤버 제거는 성공한다(best-effort)", async () => {
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
