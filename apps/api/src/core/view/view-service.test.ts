import { ViewService } from "@everdict/application-control";
import { ForbiddenError, NotFoundError } from "@everdict/core";
import { InMemoryViewStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

function svc(): ViewService {
  let n = 0;
  return new ViewService({
    store: new InMemoryViewStore(),
    newId: () => `view-${++n}`,
    now: () => "2026-07-03T00:00:00.000Z",
  });
}

const base = { tenant: "acme", createdBy: "alice", name: "harness trend", config: { groupBy: "harness" } };

describe("ViewService", () => {
  it("creating a view defaults visibility to private and is retrievable", async () => {
    const s = svc();
    const created = await s.create(base);
    expect(created).toMatchObject({ id: "view-1", tenant: "acme", visibility: "private", createdBy: "alice" });
    expect(await s.get("acme", "view-1", "alice")).toEqual(created);
  });

  it("someone else's private view is NotFound (404) — no existence leak", async () => {
    const s = svc();
    await s.create(base); // alice's private view
    await expect(s.get("acme", "view-1", "bob")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a shared (workspace) view is readable by anyone in the workspace", async () => {
    const s = svc();
    await s.create({ ...base, visibility: "workspace" });
    expect(await s.get("acme", "view-1", "bob")).toMatchObject({ id: "view-1", visibility: "workspace" });
  });

  it("listVisible = workspace-shared + my private (excluding others' private)", async () => {
    const s = svc();
    await s.create(base); // view-1 alice private
    await s.create({ ...base, createdBy: "bob", visibility: "workspace" }); // view-2 shared
    await s.create({ ...base, createdBy: "bob" }); // view-3 bob private
    expect((await s.list("acme", "alice")).map((v) => v.id).sort()).toEqual(["view-1", "view-2"]);
  });

  it("not the owner and not an admin → cannot update — Forbidden (403)", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.update("acme", "view-1", { name: "x" }, { subject: "bob", isAdmin: false })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("the owner can update, and an admin can update others' views too", async () => {
    const s = svc();
    await s.create(base);
    expect(
      await s.update("acme", "view-1", { name: "owner-edit" }, { subject: "alice", isAdmin: false }),
    ).toMatchObject({ name: "owner-edit" });
    expect(
      await s.update("acme", "view-1", { visibility: "workspace" }, { subject: "carol", isAdmin: true }),
    ).toMatchObject({ visibility: "workspace" });
  });

  it("not the owner and not an admin → cannot delete — Forbidden (403)", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.remove("acme", "view-1", { subject: "bob", isAdmin: false })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await s.get("acme", "view-1", "alice")).toBeDefined();
  });

  it("another workspace's view is NotFound (404) on edit/delete", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.update("beta", "view-1", { name: "x" }, { subject: "alice", isAdmin: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.remove("beta", "view-1", { subject: "alice", isAdmin: true })).rejects.toBeInstanceOf(NotFoundError);
  });
});
