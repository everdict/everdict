import { ForbiddenError } from "@assay/core";
import type { Principal } from "./principal.js";

// 워크스페이스 내 역할 → 액션 권한. 컨트롤플레인이 엔드포인트마다 강제(authZ).
export type Action = "runs:read" | "runs:submit" | "harnesses:read" | "harnesses:register";

export const ASSAY_ROLES = ["viewer", "member", "admin"] as const;
export type AssayRole = (typeof ASSAY_ROLES)[number];

const ROLE_PERMISSIONS: Record<string, ReadonlySet<Action>> = {
  viewer: new Set<Action>(["runs:read", "harnesses:read"]),
  member: new Set<Action>(["runs:read", "runs:submit", "harnesses:read"]),
  admin: new Set<Action>(["runs:read", "runs:submit", "harnesses:read", "harnesses:register"]),
};

export function can(principal: Principal, action: Action): boolean {
  return principal.roles.some((r) => ROLE_PERMISSIONS[r]?.has(action) ?? false);
}

// 권한 없으면 403. 호출부(API 라우트)가 핸들러 진입에서 호출한다.
export function authorize(principal: Principal, action: Action): void {
  if (!can(principal, action)) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: principal.workspace, roles: principal.roles, action },
      `이 작업(${action})에 대한 권한이 없습니다.`,
    );
  }
}
