import { type Principal, can } from "@everdict/auth";
import { ForbiddenError } from "@everdict/core";
import type { DatasetRegistry } from "@everdict/registry";

// 데이터셋 버전 소프트 삭제의 공유 코어 — HTTP 라우트(server.ts)와 MCP 도구(mcp.ts)가 같은 로직을 쓴다(BFF↔MCP parity).
// 권한: 그 버전을 등록한 생성자 본인(createdBy === subject) 또는 워크스페이스 admin(datasets:delete) 만.
// 그 외에는 ForbiddenError(403/isError). 없는·이미 삭제된·_shared·타 워크스페이스 버전은 registry 가 NotFound(404).
export async function deleteDatasetVersion(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  const ws = principal.workspace;
  const creator = await registry.creatorOf(ws, id, version); // 비소유/삭제/부재 → NotFound
  const isAdmin = can(principal, "datasets:delete"); // admin 전용 액션
  const isCreator = creator !== undefined && creator === principal.subject;
  if (!isAdmin && !isCreator) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: ws, id, version, action: "datasets:delete" },
      "이 데이터셋 버전을 삭제할 권한이 없습니다(버전 생성자 또는 워크스페이스 admin 만).",
    );
  }
  await registry.softDelete(ws, id, version);
  return { workspace: ws, id, version, deleted: true };
}
