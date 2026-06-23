import { AppError } from "@assay/core";
import { InMemoryWorkspaceStore } from "@assay/db";
import { describe, expect, it } from "vitest";
import { WorkspaceService } from "./workspace-service.js";

async function seeded(): Promise<{ svc: WorkspaceService; store: InMemoryWorkspaceStore }> {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" });
  return { svc: new WorkspaceService(store), store };
}

describe("WorkspaceService — 메타 수정/삭제", () => {
  it("get 은 워크스페이스 레코드를 돌려주고, 없으면 NOT_FOUND", async () => {
    const { svc } = await seeded();
    expect(await svc.get("acme")).toMatchObject({ id: "acme", name: "Acme", owner: "alice" });
    await expect(svc.get("ghost")).rejects.toBeInstanceOf(AppError);
  });

  it("update 는 이름과 로고(data URL)를 갱신한다", async () => {
    const { svc } = await seeded();
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const r = await svc.update("acme", { name: "Acme Inc", logoUrl: dataUrl });
    expect(r).toMatchObject({ name: "Acme Inc", logoUrl: dataUrl });
  });

  it("update 의 빈 문자열 logoUrl 은 로고를 제거한다", async () => {
    const { svc } = await seeded();
    await svc.update("acme", { logoUrl: "https://x/logo.png" });
    const r = await svc.update("acme", { logoUrl: "  " });
    expect(r.logoUrl).toBeUndefined();
    expect(r.name).toBe("Acme"); // name 미지정 → 유지
  });

  it("update 는 빈 이름/너무 긴 이름/잘못된 로고를 400 으로 거부", async () => {
    const { svc } = await seeded();
    await expect(svc.update("acme", { name: "   " })).rejects.toBeInstanceOf(AppError);
    await expect(svc.update("acme", { name: "a".repeat(81) })).rejects.toBeInstanceOf(AppError);
    await expect(svc.update("acme", { logoUrl: "ftp://x/a.png" })).rejects.toBeInstanceOf(AppError);
  });

  it("delete 는 owner(생성자)면 워크스페이스를 지운다", async () => {
    const { svc, store } = await seeded();
    await svc.delete("acme", "alice");
    expect(await store.get("acme")).toBeUndefined();
  });

  it("delete 는 owner 가 아니면 FORBIDDEN(다른 admin 도 불가)", async () => {
    const { svc, store } = await seeded();
    await store.ensureMembership("acme", "bob", "admin"); // bob 은 admin 이지만 owner 아님
    await expect(svc.delete("acme", "bob")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await store.get("acme")).toBeDefined(); // 삭제 안 됨
  });

  it("delete 는 없는 워크스페이스에 NOT_FOUND", async () => {
    const { svc } = await seeded();
    await expect(svc.delete("ghost", "alice")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
