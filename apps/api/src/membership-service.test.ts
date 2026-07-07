import { NotFoundError } from "@everdict/core";
import {
  InMemoryUserProfileStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceStore,
  generateInviteToken,
  hashKey,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { MembershipService } from "./membership-service.js";

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

describe("MembershipService.previewInvite — 링크 랜딩(비소비)", () => {
  it("유효 토큰 → 워크스페이스 이름·로고·역할, 그리고 소비하지 않는다", async () => {
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
    // 비소비: 미리보기 후에도 초대는 여전히 유효(수락 가능).
    expect(await invites.previewInvite(hashKey(token))).toBeDefined();
  });

  it("로고가 없으면 logoUrl 을 생략한다", async () => {
    const { members, invites, svc } = setup();
    await members.create({ id: "globex", name: "Globex", owner: "alice" });
    const token = await issueToken(invites, "globex", "viewer");
    const preview = await svc.previewInvite(token);
    expect(preview).toEqual({ workspace: "globex", name: "Globex", role: "viewer" });
    expect("logoUrl" in preview).toBe(false);
  });

  it("무효/수락/취소 토큰 → NotFound(존재 누출 없음)", async () => {
    const { members, invites, svc } = setup();
    await members.create({ id: "acme", name: "Acme", owner: "alice" });
    await expect(svc.previewInvite("inv_nope")).rejects.toBeInstanceOf(NotFoundError);
    // 이미 수락된 토큰도 미리보기 불가.
    const token = await issueToken(invites, "acme", "member");
    await invites.consumeInvite(hashKey(token), "bob");
    await expect(svc.previewInvite(token)).rejects.toBeInstanceOf(NotFoundError);
  });
});
