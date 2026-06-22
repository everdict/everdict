import { describe, expect, it } from "vitest";
import { hashKey } from "./tenant-auth.js";
import { InMemoryWorkspaceInviteStore, generateInviteToken } from "./workspace-invites.js";
import { InMemoryWorkspaceStore } from "./workspace-store.js";

function setup() {
  const members = new InMemoryWorkspaceStore();
  const invites = new InMemoryWorkspaceInviteStore(members);
  return { members, invites };
}

// admin 이 발급하는 흐름을 모사: 평문 토큰 생성 → 해시만 저장.
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

describe("WorkspaceInviteStore — 초대 토큰(redemption)", () => {
  it("생성 → 목록은 메타만(token_hash/평문 없음, prefix 식별)", async () => {
    const { invites } = setup();
    const { token } = await issue(invites, { workspace: "acme", role: "member", createdBy: "alice" });
    const [m] = await invites.listInvites("acme");
    expect(m?.prefix).toBe(token.slice(0, 12)); // inv_… 식별 힌트
    expect(m?.role).toBe("member");
    expect(m?.accepted).toBe(false);
    // 어떤 필드도 평문/해시와 같지 않다
    const values = Object.values(m ?? {});
    expect(values).not.toContain(token);
    expect(values).not.toContain(hashKey(token));
  });

  it("수락 → 멤버가 되고, 같은 토큰 재수락은 'accepted'(단일 사용)", async () => {
    const { members, invites } = setup();
    const { token } = await issue(invites, { workspace: "acme", role: "member", createdBy: "alice" });
    const r1 = await invites.consumeInvite(hashKey(token), "bob", "bob@corp.com");
    expect(r1).toEqual({ ok: true, result: { workspace: "acme", role: "member" } });
    expect(await members.roleFor("acme", "bob")).toBe("member");
    expect((await members.listMembers("acme")).find((m) => m.subject === "bob")?.email).toBe("bob@corp.com");
    // 재수락 불가
    expect(await invites.consumeInvite(hashKey(token), "carol")).toEqual({ ok: false, reason: "accepted" });
    expect(await members.roleFor("acme", "carol")).toBeUndefined();
  });

  it("만료된 토큰은 'expired', 알 수 없는/취소된 토큰은 'unknown'", async () => {
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
    expect(await invites.consumeInvite(hashKey(revoked), "bob")).toEqual({ ok: false, reason: "unknown" }); // 취소==unknown
  });

  it("기존 멤버가 수락해도 역할은 유지된다(공유 링크로 권한 변경 방지)", async () => {
    const { members, invites } = setup();
    await members.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = admin
    const { token } = await issue(invites, { workspace: "acme", role: "viewer", createdBy: "alice" });
    const r = await invites.consumeInvite(hashKey(token), "alice", "alice@corp.com");
    expect(r).toEqual({ ok: true, result: { workspace: "acme", role: "admin" } }); // viewer 초대지만 admin 유지
    expect(await members.roleFor("acme", "alice")).toBe("admin");
  });

  it("revoke 는 tenant 스코프 — 다른 워크스페이스 id 는 no-op", async () => {
    const { invites } = setup();
    const { meta } = await issue(invites, { workspace: "acme", role: "member", createdBy: "alice" });
    await invites.revokeInvite("globex", meta.id); // 남의 워크스페이스에서 취소 시도 → 무효
    expect((await invites.listInvites("acme")).length).toBe(1);
  });
});
