import type { AssayRole } from "@assay/auth";
import { BadRequestError, ConflictError, NotFoundError } from "@assay/core";
import type { MemberRecord, WorkspaceInviteMeta, WorkspaceInviteStore, WorkspaceStore } from "@assay/db";
import { generateInviteToken, hashKey } from "@assay/db";

// 멤버십 관리 서비스 — HTTP 라우트와 MCP 도구가 공유하는 단일 코어(패리티). 도메인 규칙(마지막 admin 보호 등)을 여기서 강제.
// 멤버 = 워크스페이스 사용자 그래프. 초대 = 토큰/링크 redemption(가입). 워크스페이스 스코프는 호출부(principal.workspace)가 전달.
export class MembershipService {
  constructor(
    private readonly members: WorkspaceStore,
    private readonly invites: WorkspaceInviteStore,
  ) {}

  // --- 멤버 ---
  listMembers(workspace: string): Promise<MemberRecord[]> {
    return this.members.listMembers(workspace);
  }

  // 기존 멤버의 역할 변경. 멤버가 아니면 404. 마지막 admin 강등 금지(409).
  // NOTE: listMembers→setRole 사이 race(동시 두 admin 강등 → 0 admin) 가능 — admin 수가 적어 v1 허용. 추후 원자적 가드로 강화.
  async setRole(workspace: string, subject: string, role: AssayRole): Promise<void> {
    const all = await this.members.listMembers(workspace);
    const target = all.find((m) => m.subject === subject);
    if (!target) throw new NotFoundError("NOT_FOUND", { subject }, "멤버를 찾을 수 없습니다.");
    if (target.role === "admin" && role !== "admin" && adminCount(all) === 1)
      throw new ConflictError("CONFLICT", { workspace }, "마지막 admin 은 강등할 수 없습니다.");
    await this.members.setRole(workspace, subject, role);
  }

  // 멤버 제거(멱등 — 없으면 no-op, 존재 누출 없음). 마지막 admin 제거 금지(409).
  async removeMember(workspace: string, subject: string): Promise<void> {
    const all = await this.members.listMembers(workspace);
    const target = all.find((m) => m.subject === subject);
    if (!target) return;
    if (target.role === "admin" && adminCount(all) === 1)
      throw new ConflictError("CONFLICT", { workspace }, "마지막 admin 은 제거할 수 없습니다.");
    await this.members.removeMember(workspace, subject);
  }

  // --- 초대 ---
  // 초대 생성 — 평문 토큰을 1회만 반환(링크에 담음). 저장은 해시만(스토어).
  async createInvite(input: {
    workspace: string;
    role: AssayRole;
    createdBy: string;
    expiresInHours?: number;
  }): Promise<{ token: string; meta: WorkspaceInviteMeta }> {
    const token = generateInviteToken();
    const expiresAt =
      input.expiresInHours !== undefined
        ? new Date(Date.now() + input.expiresInHours * 3_600_000).toISOString()
        : undefined;
    const meta = await this.invites.createInvite({
      workspace: input.workspace,
      role: input.role,
      createdBy: input.createdBy,
      tokenHash: hashKey(token),
      prefix: token.slice(0, 12),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
    return { token, meta };
  }

  listInvites(workspace: string): Promise<WorkspaceInviteMeta[]> {
    return this.invites.listInvites(workspace);
  }

  revokeInvite(workspace: string, id: string): Promise<void> {
    return this.invites.revokeInvite(workspace, id);
  }

  // 초대 수락 — 워크스페이스-역할 게이트 없음(가입 전이므로). 인증된 사람(OIDC) subject 만. 머신 키(via!=='oidc')는 거부.
  async acceptInvite(
    principal: { subject: string; via: "oidc" | "api-key"; email?: string },
    token: string,
  ): Promise<{ workspace: string; role: string }> {
    if (principal.via !== "oidc")
      throw new BadRequestError("BAD_REQUEST", undefined, "사람 계정(OIDC)으로 로그인해 초대를 수락하세요.");
    const r = await this.invites.consumeInvite(hashKey(token), principal.subject, principal.email);
    if (r.ok) return r.result;
    if (r.reason === "accepted") throw new ConflictError("CONFLICT", undefined, "이미 사용된 초대입니다.");
    if (r.reason === "expired") throw new BadRequestError("BAD_REQUEST", undefined, "만료된 초대입니다.");
    throw new NotFoundError("NOT_FOUND", undefined, "유효하지 않은 초대입니다."); // unknown == 취소됨(존재 누출 없음)
  }
}

function adminCount(members: MemberRecord[]): number {
  return members.filter((m) => m.role === "admin").length;
}
