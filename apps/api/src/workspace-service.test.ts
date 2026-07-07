import { AppError } from "@everdict/core";
import { InMemoryWorkspaceStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { WorkspaceService } from "./workspace-service.js";

async function seeded(): Promise<{ svc: WorkspaceService; store: InMemoryWorkspaceStore }> {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" });
  return { svc: new WorkspaceService(store), store };
}

describe("WorkspaceService — meta edit/delete", () => {
  it("get returns the workspace record, NOT_FOUND if absent", async () => {
    const { svc } = await seeded();
    expect(await svc.get("acme")).toMatchObject({ id: "acme", name: "Acme", owner: "alice" });
    await expect(svc.get("ghost")).rejects.toBeInstanceOf(AppError);
  });

  it("update changes the name and logo (data URL)", async () => {
    const { svc } = await seeded();
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const r = await svc.update("acme", { name: "Acme Inc", logoUrl: dataUrl });
    expect(r).toMatchObject({ name: "Acme Inc", logoUrl: dataUrl });
  });

  it("an empty-string logoUrl in update removes the logo", async () => {
    const { svc } = await seeded();
    await svc.update("acme", { logoUrl: "https://x/logo.png" });
    const r = await svc.update("acme", { logoUrl: "  " });
    expect(r.logoUrl).toBeUndefined();
    expect(r.name).toBe("Acme"); // name unset → kept
  });

  it("update rejects an empty name / too-long name / invalid logo with 400", async () => {
    const { svc } = await seeded();
    await expect(svc.update("acme", { name: "   " })).rejects.toBeInstanceOf(AppError);
    await expect(svc.update("acme", { name: "a".repeat(81) })).rejects.toBeInstanceOf(AppError);
    await expect(svc.update("acme", { logoUrl: "ftp://x/a.png" })).rejects.toBeInstanceOf(AppError);
  });

  it("delete deletes the workspace when called by the owner (creator)", async () => {
    const { svc, store } = await seeded();
    await svc.delete("acme", "alice");
    expect(await store.get("acme")).toBeUndefined();
  });

  it("delete is FORBIDDEN for a non-owner (even another admin can't)", async () => {
    const { svc, store } = await seeded();
    await store.ensureMembership("acme", "bob", "admin"); // bob is admin but not the owner
    await expect(svc.delete("acme", "bob")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await store.get("acme")).toBeDefined(); // not deleted
  });

  it("delete is NOT_FOUND for a missing workspace", async () => {
    const { svc } = await seeded();
    await expect(svc.delete("ghost", "alice")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
