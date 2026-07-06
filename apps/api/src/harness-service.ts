import { type Principal, can } from "@assay/auth";
import { ForbiddenError, referencesUserSecret } from "@assay/core";
import type { HarnessInstanceRegistry } from "@assay/registry";

// 비공개(개인 시크릿 참조) 하니스는 createdBy 만 볼 수 있다 — 최신 버전을 resolve 해 판정.
// resolve 실패는 가시성 판단 불가로 보고 막지 않는다(호출부의 다른 404 경로가 처리).
// HTTP 라우트(server.ts)와 MCP 도구(mcp.ts)가 공유한다(BFF↔MCP parity).
export async function harnessVisibleTo(
  registry: HarnessInstanceRegistry,
  principal: Principal,
  id: string,
): Promise<boolean> {
  try {
    const resolved = await registry.get(principal.workspace, id);
    if (!referencesUserSecret(resolved)) return true;
    return (await registry.creatorOf(principal.workspace, id)) === principal.subject;
  } catch {
    return true;
  }
}

// 하니스(인스턴스) 버전 소프트 삭제의 공유 코어 — HTTP 라우트(server.ts)와 MCP 도구(mcp.ts)가 같은 로직을
// 쓴다(BFF↔MCP parity). 데이터셋 삭제(dataset-service.deleteDatasetVersion)와 동일 패턴.
// 권한: 그 버전을 등록한 생성자 본인(createdBy === subject) 또는 워크스페이스 admin(harnesses:delete) 만.
// 삭제는 tombstone — 데이터 보존(과거 스코어카드는 harness 좌표를 스냅샷으로 들고 있어 이력·집계 무영향),
// read 에서만 제외. 그 하니스를 참조하는 "미래" 실행(재실행/예약/CI)은 해석 실패한다.
// 없는·이미 삭제된·_shared·타 워크스페이스 버전은 registry 가 NotFound(404).
export async function deleteHarnessVersion(
  registry: HarnessInstanceRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  const ws = principal.workspace;
  const creator = await registry.creatorOfVersion(ws, id, version); // 비소유/삭제/부재 → NotFound
  const isAdmin = can(principal, "harnesses:delete"); // admin 전용 액션
  const isCreator = creator !== undefined && creator === principal.subject;
  if (!isAdmin && !isCreator) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: ws, id, version, action: "harnesses:delete" },
      "이 하니스 버전을 삭제할 권한이 없습니다(버전 생성자 또는 워크스페이스 admin 만).",
    );
  }
  await registry.softDelete(ws, id, version);
  return { workspace: ws, id, version, deleted: true };
}
