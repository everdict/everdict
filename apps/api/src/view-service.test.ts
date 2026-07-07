import { ForbiddenError, NotFoundError } from "@everdict/core";
import { InMemoryViewStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { ViewService } from "./view-service.js";

function svc(): ViewService {
  let n = 0;
  return new ViewService({
    store: new InMemoryViewStore(),
    newId: () => `view-${++n}`,
    now: () => "2026-07-03T00:00:00.000Z",
  });
}

const base = { tenant: "acme", createdBy: "alice", name: "하니스 추이", config: { groupBy: "harness" } };

describe("ViewService", () => {
  it("뷰를 생성하면 기본 가시성은 private, 조회된다", async () => {
    const s = svc();
    const created = await s.create(base);
    expect(created).toMatchObject({ id: "view-1", tenant: "acme", visibility: "private", createdBy: "alice" });
    expect(await s.get("acme", "view-1", "alice")).toEqual(created);
  });

  it("남의 비공개 뷰는 NotFound(404) — 존재 누출 금지", async () => {
    const s = svc();
    await s.create(base); // alice 의 비공개
    await expect(s.get("acme", "view-1", "bob")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("공유(workspace) 뷰는 워크스페이스 누구나 조회 가능", async () => {
    const s = svc();
    await s.create({ ...base, visibility: "workspace" });
    expect(await s.get("acme", "view-1", "bob")).toMatchObject({ id: "view-1", visibility: "workspace" });
  });

  it("listVisible = 워크스페이스 공유 + 내 비공개(남의 비공개 제외)", async () => {
    const s = svc();
    await s.create(base); // view-1 alice private
    await s.create({ ...base, createdBy: "bob", visibility: "workspace" }); // view-2 shared
    await s.create({ ...base, createdBy: "bob" }); // view-3 bob private
    expect((await s.list("acme", "alice")).map((v) => v.id).sort()).toEqual(["view-1", "view-2"]);
  });

  it("소유자가 아니고 admin 도 아니면 수정 불가 — Forbidden(403)", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.update("acme", "view-1", { name: "x" }, { subject: "bob", isAdmin: false })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("소유자는 수정 가능, admin 은 남의 뷰도 수정 가능", async () => {
    const s = svc();
    await s.create(base);
    expect(
      await s.update("acme", "view-1", { name: "owner-edit" }, { subject: "alice", isAdmin: false }),
    ).toMatchObject({ name: "owner-edit" });
    expect(
      await s.update("acme", "view-1", { visibility: "workspace" }, { subject: "carol", isAdmin: true }),
    ).toMatchObject({ visibility: "workspace" });
  });

  it("소유자가 아니고 admin 도 아니면 삭제 불가 — Forbidden(403)", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.remove("acme", "view-1", { subject: "bob", isAdmin: false })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await s.get("acme", "view-1", "alice")).toBeDefined();
  });

  it("다른 워크스페이스의 뷰는 수정/삭제 시 NotFound(404)", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.update("beta", "view-1", { name: "x" }, { subject: "alice", isAdmin: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.remove("beta", "view-1", { subject: "alice", isAdmin: true })).rejects.toBeInstanceOf(NotFoundError);
  });
});
