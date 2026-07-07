import { type Action, type Principal, authorize } from "@everdict/auth";
import { BadRequestError } from "@everdict/core";
import { z } from "zod";

// 버전 태그 편집의 공유 코어 — HTTP 라우트(server.ts)와 MCP 도구(mcp.ts)가 같은 로직을 쓴다(BFF↔MCP parity).
// 태그 = 스펙 "밖"의 가변 레지스트리 메타데이터(자유 라벨) — 버전을 번호만으로 분간하기 어려울 때 붙인다.
// 스펙 내용이 아니므로 specsEqual/버전 불변성(SSOT 보장)에는 관여하지 않고, 등록 후에도 자유 편집된다.
// 게이트: 각 엔티티의 콘텐츠 mutation 액션 재사용(새 액션 없음) — harnesses:register / datasets:write /
// judges:write / runtimes:write. 대상은 테넌트 소유 버전만 — _shared/타 워크스페이스는 레지스트리가 NotFound(404).

// 라우트 body: { tags: [...] } — 전체 교체(PUT 의미). 빈 배열 = 모든 태그 제거.
export const VersionTagsBodySchema = z.object({
  tags: z.array(z.string().max(60, "태그는 60자 이하여야 합니다.")).max(20, "태그는 버전당 20개까지입니다."),
});

// 4개 레지스트리(harness/dataset/judge/runtime)가 공유하는 최소 계약 — 서비스는 이만큼만 본다.
export interface VersionTaggable {
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
}

// trim + 빈 태그 제거 + 순서 보존 dedupe. 정규화 후에도 개수/길이 상한을 넘으면 BadRequest.
export function normalizeVersionTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length > 0 && !out.includes(tag)) out.push(tag);
  }
  if (out.length > 20) throw new BadRequestError("BAD_REQUEST", { count: out.length }, "태그는 버전당 20개까지입니다.");
  return out;
}

export async function setVersionTags(
  registry: VersionTaggable,
  principal: Principal,
  action: Action,
  id: string,
  version: string,
  tags: string[],
): Promise<{ workspace: string; id: string; version: string; tags: string[] }> {
  authorize(principal, action);
  const normalized = normalizeVersionTags(tags);
  await registry.setVersionTags(principal.workspace, id, version, normalized);
  return { workspace: principal.workspace, id, version, tags: normalized };
}
