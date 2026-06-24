import type { AssayRole } from "@assay/auth";
import { BadRequestError, ConflictError, NotFoundError } from "@assay/core";
import type {
  MemberRecord,
  UserProfileStore,
  WorkspaceInviteMeta,
  WorkspaceInviteStore,
  WorkspaceStore,
} from "@assay/db";
import { generateInviteToken, hashKey } from "@assay/db";

// 멤버십 관리 서비스 — HTTP 라우트와 MCP 도구가 공유하는 단일 코어(패리티). 도메인 규칙(마지막 admin 보호 등)을 여기서 강제.
// 멤버 = 워크스페이스 사용자 그래프. 초대 = 토큰/링크 redemption(가입). 워크스페이스 스코프는 호출부(principal.workspace)가 전달.
export class MembershipService {
  constructor(
    private readonly members: WorkspaceStore,
    private readonly invites: WorkspaceInviteStore,
    private readonly profiles: UserProfileStore,
  ) {}

  // --- 멤버 ---
  // opaque subject 를 사람이 읽는 프로필(이름/아바타)로 보강한다 — 멤버십과 프로필은 별도 스토어라 여기서 합친다.
  // BFF·MCP 공통 코어이므로 HTTP(GET /members)·MCP(list_members) 양쪽에 동일하게 이름/아바타가 실린다.
  async listMembers(workspace: string): Promise<MemberRecord[]> {
    const members = await this.members.listMembers(workspace);
    if (members.length === 0) return members;
    const profiles = await this.profiles.getMany(members.map((m) => m.subject));
    const bySubject = new Map(profiles.map((p) => [p.subject, p]));
    return members.map((m) => {
      const p = bySubject.get(m.subject);
      if (!p) return m;
      return {
        ...m,
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.avatarUrl !== undefined ? { avatarUrl: p.avatarUrl } : {}),
      };
    });
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

  // 내가 이 워크스페이스에서 나간다(self-serve — 역할 게이트 없음, 자기 멤버십만 제거). 멱등.
  // 마지막 admin 은 나갈 수 없다(409) — 먼저 다른 멤버에게 admin 을 위임하거나 워크스페이스를 삭제해야 한다.
  async leaveWorkspace(workspace: string, subject: string): Promise<void> {
    const all = await this.members.listMembers(workspace);
    const me = all.find((m) => m.subject === subject);
    if (!me) return; // 멤버 아님 — 멱등
    if (me.role === "admin" && adminCount(all) === 1)
      throw new ConflictError(
        "CONFLICT",
        { workspace },
        "마지막 admin 은 나갈 수 없습니다. 다른 멤버에게 admin 을 위임하거나 워크스페이스를 삭제하세요.",
      );
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
    principal: { subject: string; via: "oidc" | "api-key" | "runner"; email?: string },
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
