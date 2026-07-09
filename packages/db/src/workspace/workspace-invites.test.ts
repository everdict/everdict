import { describe, expect, it } from "vitest";
import { hashKey } from "./tenant-auth.js";
import { InMemoryWorkspaceInviteStore, generateInviteToken } from "./workspace-invites.js";
import { InMemoryWorkspaceStore } from "./workspace-store.js";

function setup() {
  const members = new InMemoryWorkspaceStore();
  const invites = new InMemoryWorkspaceInviteStore(members);
  return { members, invites };
}

// Simulates the admin-issuance flow: generate a plaintext token → store only the hash.
async function issue(
  invites: InMemoryWorkspaceInviteStore,
  opts: { workspace: string; role: string; createdBy: string; expiresAt?: string },
) {
  const token = generateInviteToken();
  const m = await invites.createInvite({
    workspace: opts.workspace,
    role: opts.role,
    createdBy: opts.createdBy,
    tokenHash: hashKey(token),
    prefix: token.slice(0, 12),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
  });
  return { token, meta: m };
}

describe("WorkspaceInviteStore — invite token (redemption)", () => {
  it("create → the list is meta only (no token_hash/plaintext, prefix for identification)", async () => {
    const { invites } = setup();
    const { token } = await issue(invites, { workspace: "acme", role: "member", createdBy: "alice" });
    const [m] = await invites.listInvites("acme");
    expect(m?.prefix).toBe(token.slice(0, 12)); // inv_… identification hint
    expect(m?.role).toBe("member");
    expect(m?.accepted).toBe(false);
    // no field equals the plaintext/hash
    const values = Object.values(m ?? {});
    expect(values).not.toContain(token);
    expect(values).not.toContain(hashKey(token));
  });

  it("accept → becomes a member, and re-accepting the same token is 'accepted' (single-use)", async () => {
    const { members, invites } = setup();
    const { token } = await issue(invites, { workspace: "acme", role: "member", createdBy: "alice" });
    const r1 = await invites.consumeInvite(hashKey(token), "bob", "bob@corp.com");
    expect(r1).toEqual({ ok: true, result: { workspace: "acme", role: "member" } });
    expect(await members.roleFor("acme", "bob")).toBe("member");
    expect((await members.listMembers("acme")).find((m) => m.subject === "bob")?.email).toBe("bob@corp.com");
    // can't re-accept
    expect(await invites.consumeInvite(hashKey(token), "carol")).toEqual({ ok: false, reason: "accepted" });
    expect(await members.roleFor("acme", "carol")).toBeUndefined();
  });

  it("an expired token is 'expired', an unknown/revoked token is 'unknown'", async () => {
    const { invites } = setup();
    const past = new Date(Date.now() - 1000).toISOString();
    const { token: expired } = await issue(invites, {
      workspace: "acme",
      role: "member",
      createdBy: "a",
      expiresAt: past,
    });
    expect(await invites.consumeInvite(hashKey(expired), "bob")).toEqual({ ok: false, reason: "expired" });

    expect(await invites.consumeInvite(hashKey("inv_nope"), "bob")).toEqual({ ok: false, reason: "unknown" });

    const { token: revoked, meta } = await issue(invites, { workspace: "acme", role: "member", createdBy: "a" });
    await invites.revokeInvite("acme", meta.id);
    expect(await invites.consumeInvite(hashKey(revoked), "bob")).toEqual({ ok: false, reason: "unknown" }); // revoked==unknown
  });

  it("an existing member's role is kept even when they accept (prevents a shared link from changing permissions)", async () => {
    const { members, invites } = setup();
    await members.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = admin
    const { token } = await issue(invites, { workspace: "acme", role: "viewer", createdBy: "alice" });
    const r = await invites.consumeInvite(hashKey(token), "alice", "alice@corp.com");
    expect(r).toEqual({ ok: true, result: { workspace: "acme", role: "admin" } }); // viewer invite but admin is kept
    expect(await members.roleFor("acme", "alice")).toBe("admin");
  });

  it("revoke is tenant-scoped — a different workspace id is a no-op", async () => {
    const { invites } = setup();
    const { meta } = await issue(invites, { workspace: "acme", role: "member", createdBy: "alice" });
    await invites.revokeInvite("globex", meta.id); // trying to revoke from another workspace → no effect
    expect((await invites.listInvites("acme")).length).toBe(1);
  });

  it("previewInvite: non-consuming, only workspace/role; expired·accepted·nonexistent are undefined", async () => {
    const { invites } = setup();
    const { token } = await issue(invites, { workspace: "acme", role: "member", createdBy: "alice" });
    // valid → workspace/role. Re-querying returns the same (it doesn't consume, so a later accept is still possible).
    expect(await invites.previewInvite(hashKey(token))).toEqual({ workspace: "acme", role: "member" });
    expect(await invites.previewInvite(hashKey(token))).toEqual({ workspace: "acme", role: "member" });
    expect(await invites.consumeInvite(hashKey(token), "bob")).toEqual({
      ok: true,
      result: { workspace: "acme", role: "member" },
    });
    // after acceptance → undefined
    expect(await invites.previewInvite(hashKey(token))).toBeUndefined();
    // expired → undefined
    const { token: expired } = await issue(invites, {
      workspace: "acme",
      role: "member",
      createdBy: "a",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await invites.previewInvite(hashKey(expired))).toBeUndefined();
    // nonexistent/revoked → undefined
    expect(await invites.previewInvite(hashKey("inv_nope"))).toBeUndefined();
  });
});
