import { MembershipService } from "@everdict/application-control";
import { NotFoundError } from "@everdict/core";
import {
  InMemoryUserProfileStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceStore,
  generateInviteToken,
  hashKey,
} from "@everdict/db";
import { describe, expect, it } from "vitest";

function setup() {
  const members = new InMemoryWorkspaceStore();
  const invites = new InMemoryWorkspaceInviteStore(members);
  const svc = new MembershipService(members, invites, new InMemoryUserProfileStore());
  return { members, invites, svc };
}

async function issueToken(invites: InMemoryWorkspaceInviteStore, workspace: string, role: string): Promise<string> {
  const token = generateInviteToken();
  await invites.createInvite({
    workspace,
    role,
    createdBy: "alice",
    tokenHash: hashKey(token),
    prefix: token.slice(0, 12),
  });
  return token;
}

describe("MembershipService.previewInvite — link landing (non-consuming)", () => {
  it("valid token → workspace name/logo/role, and does not consume it", async () => {
    const { members, invites, svc } = setup();
    await members.create({ id: "acme", name: "Acme Inc", owner: "alice" });
    await members.update("acme", { logoUrl: "data:image/png;base64,AAAA" });
    const token = await issueToken(invites, "acme", "member");

    expect(await svc.previewInvite(token)).toEqual({
      workspace: "acme",
      name: "Acme Inc",
      logoUrl: "data:image/png;base64,AAAA",
      role: "member",
    });
    // non-consuming: after preview the invite is still valid (acceptable).
    expect(await invites.previewInvite(hashKey(token))).toBeDefined();
  });

  it("omits logoUrl when there is no logo", async () => {
    const { members, invites, svc } = setup();
    await members.create({ id: "globex", name: "Globex", owner: "alice" });
    const token = await issueToken(invites, "globex", "viewer");
    const preview = await svc.previewInvite(token);
    expect(preview).toEqual({ workspace: "globex", name: "Globex", role: "viewer" });
    expect("logoUrl" in preview).toBe(false);
  });

  it("invalid/accepted/revoked token → NotFound (no existence leak)", async () => {
    const { members, invites, svc } = setup();
    await members.create({ id: "acme", name: "Acme", owner: "alice" });
    await expect(svc.previewInvite("inv_nope")).rejects.toBeInstanceOf(NotFoundError);
    // an already-accepted token cannot be previewed either.
    const token = await issueToken(invites, "acme", "member");
    await invites.consumeInvite(hashKey(token), "bob");
    await expect(svc.previewInvite(token)).rejects.toBeInstanceOf(NotFoundError);
  });
});
