import { BadRequestError } from "@assay/core";
import type { UserProfile, UserProfilePatch, UserProfileStore } from "@assay/db";
import { validateImageRef } from "./image-ref.js";

// 프로필 수정 코어 — HTTP 라우트(PATCH /me/profile)와 MCP 도구(update_profile)가 공유하는 단일 코어(패리티).
// 자기 프로필만 수정한다(subject = principal.subject) — 역할 게이트 없음(authz 무관, SSO 신원과 분리된 표시 정보).
// email 은 다루지 않는다 — Keycloak 클레임이라 읽기전용. 빈 문자열은 해당 필드 삭제로 해석한다.
export class ProfileService {
  constructor(private readonly store: UserProfileStore) {}

  get(subject: string): Promise<UserProfile | undefined> {
    return this.store.get(subject);
  }

  async update(subject: string, input: { name?: string; username?: string; avatarUrl?: string }): Promise<UserProfile> {
    const patch: UserProfilePatch = {};
    if (input.name !== undefined) patch.name = validateName(clean(input.name));
    if (input.username !== undefined) patch.username = validateUsername(clean(input.username));
    if (input.avatarUrl !== undefined) patch.avatarUrl = validateImageRef(clean(input.avatarUrl), "avatarUrl");
    return this.store.upsert(subject, patch);
  }
}

// 빈/공백 → null(삭제), 아니면 trim 한 값.
function clean(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

function validateName(v: string | null): string | null {
  if (v === null) return null;
  if (v.length > 80) throw new BadRequestError("BAD_REQUEST", { field: "name" }, "이름은 80자 이하여야 합니다.");
  return v;
}

// 유저네임: 영숫자 + _/- (2~39자). 유일성은 아직 강제하지 않는다(형식만 검증).
function validateUsername(v: string | null): string | null {
  if (v === null) return null;
  if (!/^[a-z0-9][a-z0-9_-]{1,38}$/i.test(v))
    throw new BadRequestError("BAD_REQUEST", { field: "username" }, "유저네임은 영숫자/_/- 2~39자여야 합니다.");
  return v;
}
