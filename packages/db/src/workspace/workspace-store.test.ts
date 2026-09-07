import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, PgWorkspaceStore } from "./workspace-store.js";

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

// ── THE SWEEP IS DERIVED FROM THE SCHEMA, AND THIS IS THE SHAPE HALF ─────────────────────────────
//
// `PgWorkspaceStore.delete()` used to walk a hand-maintained list of 18 `[table, column]` pairs against a
// schema with 86 live tables, 55 of them tenant-scoped and unnamed — and one entry, `everdict_connections`,
// naming a table `0046_drop_connections.sql` removed, which made the whole delete REJECT on any migrated
// database. What actually happens is decided by an engine, so the real certification is TRUST-194 in
// `apps/api/src/trust/workspace-delete-sweep.trust.test.ts` against a live Postgres; rule `testing` says an
// adapter's decision is certified there or nowhere, and that the in-memory test proves only the shape.
//
// This is that shape, and it is worth having because the trust suite is env-gated: without it `pnpm test`
// says nothing at all about this store, which is exactly the state the defect lived in for 166 migrations.
describe("PgWorkspaceStore delete", () => {
  const fakeClient = (scoped: { table_name: string; column_name: string }[]) => {
    const statements: string[] = [];
    return {
      statements,
      client: {
        query: async <R>(text: string, _params?: unknown[]) => {
          statements.push(text.replace(/\s+/g, " ").trim());
          if (text.includes("information_schema")) return { rows: scoped as R[] };
          return { rows: [] as R[] };
        },
      },
    };
  };

  it("deletes every table the schema reported, and the workspace row last", async () => {
    const { client, statements } = fakeClient([
      { table_name: "everdict_agents", column_name: "tenant" },
      { table_name: "everdict_notifications", column_name: "workspace" },
    ]);
    await new PgWorkspaceStore(client).delete("acme");

    const deletes = statements.filter((s) => s.startsWith("DELETE FROM"));
    // Both derived tables, on the column the SCHEMA reported rather than on a spelling this file remembers.
    expect(deletes).toContain("DELETE FROM everdict_agents WHERE tenant = $1");
    expect(deletes).toContain("DELETE FROM everdict_notifications WHERE workspace = $1");
    // …and the row that makes the workspace exist goes last, so a partial failure is retryable.
    expect(deletes.at(-1)).toBe("DELETE FROM everdict_workspaces WHERE id = $1");
  });

  it("sweeps BOTH columns when one table carries both spellings", async () => {
    // The residue of the derivation, and the case a comment cannot hold. No table has both today; the first
    // version keyed the sweep by table name on the strength of that, so the day a migration adds one, the
    // second column silently replaced the first and half the rows survived a delete that reported success —
    // the defect this function exists to end, reintroduced by the repair.
    const { client, statements } = fakeClient([
      { table_name: "everdict_both", column_name: "workspace" },
      { table_name: "everdict_both", column_name: "tenant" },
    ]);
    await new PgWorkspaceStore(client).delete("acme");

    const deletes = statements.filter((s) => s.startsWith("DELETE FROM everdict_both"));
    expect(deletes, "one of the two scope columns was never swept").toEqual([
      "DELETE FROM everdict_both WHERE workspace = $1",
      "DELETE FROM everdict_both WHERE tenant = $1",
    ]);
  });

  it("refuses when the schema resolved no tenant-scoped tables at all", async () => {
    // An empty derived set is a read that answered nothing, not a workspace with no data — and removing the
    // workspace row on top of it would report success over data nobody looked for.
    const { client, statements } = fakeClient([]);
    await expect(new PgWorkspaceStore(client).delete("acme")).rejects.toThrow(/no tenant-scoped tables/);
    expect(
      statements.some((s) => s.startsWith("DELETE FROM")),
      "a delete ran over an enumeration that came back empty",
    ).toBe(false);
  });
});
