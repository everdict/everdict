import { BadRequestError, ForbiddenError, NotFoundError } from "@assay/core";
import type { CommentRecord, CommentStore } from "@assay/db";

// 댓글 서비스 — 리소스(데이터셋 등)에 대한 협업 논의. HTTP 라우트와 MCP 툴이 공유(BFF↔MCP 패리티).
// authZ: 조회=comments:read(라우트), 작성=comments:write(라우트), 삭제=작성자-or-admin(여기서 판정).
export const COMMENT_RESOURCE_TYPES = ["dataset"] as const;
export type CommentResourceType = (typeof COMMENT_RESOURCE_TYPES)[number];

const MAX_BODY = 10_000; // 과도한 본문 방지(리치 논의는 충분, DoS 는 차단)

export interface CommentServiceDeps {
  store: CommentStore;
  newId?: () => string;
  now?: () => string;
}

export class CommentService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: CommentServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private assertType(resourceType: string): void {
    if (!(COMMENT_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { resourceType },
        `지원하지 않는 댓글 대상입니다: ${resourceType}`,
      );
    }
  }

  // 리소스의 댓글(오래된→최신, 타임라인 순서). 워크스페이스 스코프.
  list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]> {
    this.assertType(resourceType);
    return this.deps.store.list(tenant, resourceType, resourceId);
  }

  // 댓글 작성. body 빈값/과길이는 400. author = 작성자 subject.
  async create(input: {
    tenant: string;
    resourceType: string;
    resourceId: string;
    author: string;
    body: string;
  }): Promise<CommentRecord> {
    this.assertType(input.resourceType);
    const body = input.body.trim();
    if (body.length === 0) throw new BadRequestError("BAD_REQUEST", undefined, "댓글 내용을 입력하세요.");
    if (body.length > MAX_BODY)
      throw new BadRequestError("BAD_REQUEST", { max: MAX_BODY }, `댓글은 ${MAX_BODY}자 이하여야 합니다.`);
    const ts = this.now();
    const record: CommentRecord = {
      id: this.newId(),
      tenant: input.tenant,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      author: input.author,
      body,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.add(record);
    return record;
  }

  // 삭제 — 작성자 본인 or 워크스페이스 admin 만. 없으면 404, 권한 없으면 403.
  async delete(input: { tenant: string; id: string; subject: string; isAdmin: boolean }): Promise<void> {
    const existing = await this.deps.store.get(input.tenant, input.id);
    if (!existing) throw new NotFoundError("NOT_FOUND", { id: input.id }, "댓글을 찾을 수 없습니다.");
    if (existing.author !== input.subject && !input.isAdmin) {
      throw new ForbiddenError(
        "FORBIDDEN",
        { id: input.id },
        "본인이 작성한 댓글 또는 관리자만 삭제할 수 있습니다.",
      );
    }
    await this.deps.store.remove(input.tenant, input.id);
  }
}
