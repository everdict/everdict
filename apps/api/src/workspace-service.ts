import { randomBytes } from "node:crypto";
import { BadRequestError, ConflictError } from "@assay/core";
import type { WorkspaceStore, WorkspaceWithRole } from "@assay/db";

// 워크스페이스 self-serve 멤버십의 서비스 코어 — HTTP 라우트와 MCP 툴이 공유한다(패리티: 로직 1개, 트랜스포트 2개).
// 인증된 subject 기준으로 동작(워크스페이스 내부 역할 게이트 없음 — 새 워크스페이스 생성은 누구나 가능한 self-serve).
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// 표시 이름 → URL-safe slug(워크스페이스 id = tenant 키). 영숫자 외는 하이픈으로, 최대 40자.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class WorkspaceService {
  constructor(private readonly store: WorkspaceStore) {}

  // 내가 멤버인 워크스페이스 목록(역할 포함).
  async listForSubject(subject: string): Promise<WorkspaceWithRole[]> {
    return this.store.listForSubject(subject);
  }

  // self-serve 생성: name(필수) + 선택 id(slug). 생성자는 그 워크스페이스의 admin.
  // 명시 id 충돌은 409. 이름에서 파생한 slug 충돌은 짧은 접미사로 유니크 보장(막다른 길 회피).
  async create(subject: string, input: { name: string; id?: string }): Promise<WorkspaceWithRole> {
    const name = input.name.trim();
    if (!name) throw new BadRequestError("BAD_REQUEST", undefined, "워크스페이스 이름이 필요합니다.");

    const explicit = typeof input.id === "string" && input.id.length > 0;
    let id = explicit ? (input.id as string).trim() : slugify(name);
    if (!id || !SLUG.test(id))
      throw new BadRequestError("BAD_REQUEST", undefined, "워크스페이스 ID 는 ^[a-z0-9][a-z0-9-]*$ 형식이어야 합니다.");

    let created = await this.store.create({ id, name, owner: subject });
    if (!created && explicit)
      throw new ConflictError("CONFLICT", { id }, `이미 존재하는 워크스페이스 ID 입니다: ${id}`);

    const stem = slugify(name) || "ws";
    for (let attempt = 0; !created && attempt < 6; attempt += 1) {
      id = `${stem}-${randomBytes(2).toString("hex")}`;
      created = await this.store.create({ id, name, owner: subject });
    }
    if (!created)
      throw new ConflictError(
        "CONFLICT",
        undefined,
        "유니크한 워크스페이스 ID 를 만들지 못했습니다. id 를 직접 지정해 보세요.",
      );

    return { id: created.id, name: created.name, role: "admin" };
  }
}
