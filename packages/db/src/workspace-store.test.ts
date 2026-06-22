import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore } from "./workspace-store.js";

describe("InMemoryWorkspaceStore — 멤버십", () => {
  it("create 는 생성자를 admin 멤버로 만들고, id 충돌은 undefined 를 돌려준다", async () => {
    const store = new InMemoryWorkspaceStore();
    const created = await store.create({ id: "acme", name: "Acme", owner: "alice" });
    expect(created).toMatchObject({ id: "acme", name: "Acme", owner: "alice" });
    expect(await store.roleFor("acme", "alice")).toBe("admin");
    // 같은 id 재생성 → undefined(충돌; 서비스가 409 로 매핑).
    expect(await store.create({ id: "acme", name: "Other", owner: "bob" })).toBeUndefined();
  });

  it("listForSubject 는 내가 속한 워크스페이스만 역할과 함께, 생성 순으로 돌려준다", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "a", name: "A", owner: "alice" });
    await store.create({ id: "b", name: "B", owner: "alice" });
    await store.create({ id: "c", name: "C", owner: "bob" }); // alice 는 비멤버
    const list = await store.listForSubject("alice");
    expect(list.map((w) => w.id)).toEqual(["a", "b"]);
    expect(list.every((w) => w.role === "admin")).toBe(true);
    expect(await store.listForSubject("bob")).toEqual([{ id: "c", name: "C", role: "admin" }]);
  });

  it("ensureMembership 는 없을 때만 워크스페이스+멤버십을 만들고(부트스트랩), 기존 역할은 덮어쓰지 않는다", async () => {
    const store = new InMemoryWorkspaceStore();
    // 레코드가 없던 워크스페이스를 멤버십으로 승격(토큰 클레임 부트스트랩 시나리오).
    await store.ensureMembership("acme", "alice", "member");
    expect(await store.roleFor("acme", "alice")).toBe("member");
    expect(await store.get("acme")).toMatchObject({ id: "acme", name: "acme" });
    // 멱등: 다시 호출해도 기존 역할 보존.
    await store.ensureMembership("acme", "alice", "admin");
    expect(await store.roleFor("acme", "alice")).toBe("member");
  });

  it("roleFor 는 멤버가 아니면 undefined", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "a", name: "A", owner: "alice" });
    expect(await store.roleFor("a", "stranger")).toBeUndefined();
    expect(await store.roleFor("nope", "alice")).toBeUndefined();
  });
});
