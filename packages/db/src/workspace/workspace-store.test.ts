import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore } from "./workspace-store.js";

describe("InMemoryWorkspaceStore — membership", () => {
  it("create makes the creator an admin member, and an id collision returns undefined", async () => {
    const store = new InMemoryWorkspaceStore();
    const created = await store.create({ id: "acme", name: "Acme", owner: "alice" });
    expect(created).toMatchObject({ id: "acme", name: "Acme", owner: "alice" });
    expect(await store.roleFor("acme", "alice")).toBe("admin");
    // Recreating the same id → undefined (collision; the service maps it to 409).
    expect(await store.create({ id: "acme", name: "Other", owner: "bob" })).toBeUndefined();
  });

  it("listForSubject returns only the workspaces I belong to, with role, in creation order", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "a", name: "A", owner: "alice" });
    await store.create({ id: "b", name: "B", owner: "alice" });
    await store.create({ id: "c", name: "C", owner: "bob" }); // alice is not a member
    const list = await store.listForSubject("alice");
    expect(list.map((w) => w.id)).toEqual(["a", "b"]);
    expect(list.every((w) => w.role === "admin")).toBe(true);
    expect(await store.listForSubject("bob")).toEqual([{ id: "c", name: "C", role: "admin" }]);
  });

  it("ensureMembership creates the workspace+membership only when absent (bootstrap), and doesn't overwrite an existing role", async () => {
    const store = new InMemoryWorkspaceStore();
    // Promote a workspace with no record to a membership (the token-claim bootstrap scenario).
    await store.ensureMembership("acme", "alice", "member");
    expect(await store.roleFor("acme", "alice")).toBe("member");
    expect(await store.get("acme")).toMatchObject({ id: "acme", name: "acme" });
    // Idempotent: calling again preserves the existing role.
    await store.ensureMembership("acme", "alice", "admin");
    expect(await store.roleFor("acme", "alice")).toBe("member");
  });

  it("roleFor is undefined for a non-member", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "a", name: "A", owner: "alice" });
    expect(await store.roleFor("a", "stranger")).toBeUndefined();
    expect(await store.roleFor("nope", "alice")).toBeUndefined();
  });

  it("listMembers returns members with role·email in join order", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "member", "bob@corp.com");
    const members = await store.listMembers("acme");
    expect(members.map((m) => m.subject)).toEqual(["alice", "bob"]); // join order
    expect(members.find((m) => m.subject === "bob")).toMatchObject({ role: "member", email: "bob@corp.com" });
    expect(members.find((m) => m.subject === "alice")?.email).toBeUndefined();
  });

  it("ensureMembership's email is COALESCE — doesn't overwrite the existing value with null and doesn't touch role", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.ensureMembership("acme", "bob", "member", "bob@corp.com");
    await store.ensureMembership("acme", "bob", "admin"); // no email + attempts a role change
    const [bob] = await store.listMembers("acme");
    expect(bob?.email).toBe("bob@corp.com"); // preserves the existing email
    expect(bob?.role).toBe("member"); // role isn't changed by bootstrap
  });

  it("setRole changes only an existing member (false if absent), removeMember is idempotent", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "viewer");
    expect(await store.setRole("acme", "bob", "member")).toBe(true);
    expect(await store.roleFor("acme", "bob")).toBe("member");
    expect(await store.setRole("acme", "stranger", "admin")).toBe(false); // non-member → nothing created
    expect(await store.roleFor("acme", "stranger")).toBeUndefined();
    await store.removeMember("acme", "bob");
    expect(await store.roleFor("acme", "bob")).toBeUndefined();
    await store.removeMember("acme", "bob"); // idempotent — fine to call again
  });

  it("update refreshes name/logo and listForSubject also carries the logo", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    const updated = await store.update("acme", { name: "Acme Inc", logoUrl: "https://x/logo.png" });
    expect(updated).toMatchObject({ id: "acme", name: "Acme Inc", logoUrl: "https://x/logo.png" });
    const [ws] = await store.listForSubject("alice");
    expect(ws).toMatchObject({ id: "acme", name: "Acme Inc", logoUrl: "https://x/logo.png" });
  });

  it("update's logoUrl=null removes the logo, and an unset name is kept", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.update("acme", { logoUrl: "https://x/logo.png" });
    const cleared = await store.update("acme", { logoUrl: null });
    expect(cleared?.logoUrl).toBeUndefined();
    expect(cleared?.name).toBe("Acme"); // name unset → kept
  });

  it("update returns undefined for a nonexistent workspace", async () => {
    const store = new InMemoryWorkspaceStore();
    expect(await store.update("ghost", { name: "X" })).toBeUndefined();
  });

  it("delete removes the workspace and membership (idempotent)", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.create({ id: "acme", name: "Acme", owner: "alice" });
    await store.ensureMembership("acme", "bob", "member");
    await store.delete("acme");
    expect(await store.get("acme")).toBeUndefined();
    expect(await store.listForSubject("alice")).toEqual([]);
    expect(await store.roleFor("acme", "bob")).toBeUndefined();
    await store.delete("acme"); // idempotent — fine to call again
  });
});
