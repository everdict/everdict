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

  it("listMembers 는 멤버를 역할·email 과 함께 가입순으로 돌려준다", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "member", "bob@corp.com");
    const members = await store.listMembers("acme");
    expect(members.map((m) => m.subject)).toEqual(["alice", "bob"]); // 가입순
    expect(members.find((m) => m.subject === "bob")).toMatchObject({ role: "member", email: "bob@corp.com" });
    expect(members.find((m) => m.subject === "alice")?.email).toBeUndefined();
  });

  it("ensureMembership 의 email 은 COALESCE — null 로 기존값을 덮어쓰지 않고 role 도 안 건드린다", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.ensureMembership("acme", "bob", "member", "bob@corp.com");
    await store.ensureMembership("acme", "bob", "admin"); // email 없음 + role 변경 시도
    const [bob] = await store.listMembers("acme");
    expect(bob?.email).toBe("bob@corp.com"); // 기존 email 보존
    expect(bob?.role).toBe("member"); // role 은 부트스트랩으로 안 바뀜
  });

  it("setRole 은 기존 멤버만 변경(없으면 false), removeMember 는 멱등", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "viewer");
    expect(await store.setRole("acme", "bob", "member")).toBe(true);
    expect(await store.roleFor("acme", "bob")).toBe("member");
    expect(await store.setRole("acme", "stranger", "admin")).toBe(false); // 비멤버 → 생성 안 함
    expect(await store.roleFor("acme", "stranger")).toBeUndefined();
    await store.removeMember("acme", "bob");
    expect(await store.roleFor("acme", "bob")).toBeUndefined();
    await store.removeMember("acme", "bob"); // 멱등 — 다시 호출해도 무탈
  });

  it("update 는 이름/로고를 갱신하고 listForSubject 에도 로고가 실린다", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    const updated = await store.update("acme", { name: "Acme Inc", logoUrl: "https://x/logo.png" });
    expect(updated).toMatchObject({ id: "acme", name: "Acme Inc", logoUrl: "https://x/logo.png" });
    const [ws] = await store.listForSubject("alice");
    expect(ws).toMatchObject({ id: "acme", name: "Acme Inc", logoUrl: "https://x/logo.png" });
  });

  it("update 의 logoUrl=null 은 로고를 제거하고, name 미지정은 유지한다", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.update("acme", { logoUrl: "https://x/logo.png" });
    const cleared = await store.update("acme", { logoUrl: null });
    expect(cleared?.logoUrl).toBeUndefined();
    expect(cleared?.name).toBe("Acme"); // name 미지정 → 유지
  });

  it("update 는 없는 워크스페이스에 undefined 를 돌려준다", async () => {
    const store = new InMemoryWorkspaceStore();
    expect(await store.update("ghost", { name: "X" })).toBeUndefined();
  });

  it("delete 는 워크스페이스와 멤버십을 지운다(멱등)", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "member");
    await store.delete("acme");
    expect(await store.get("acme")).toBeUndefined();
    expect(await store.listForSubject("alice")).toEqual([]);
    expect(await store.roleFor("acme", "bob")).toBeUndefined();
    await store.delete("acme"); // 멱등 — 다시 호출해도 무탈
  });
});
