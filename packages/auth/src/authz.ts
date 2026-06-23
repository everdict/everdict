import { ForbiddenError } from "@assay/core";
import type { Principal } from "./principal.js";

// 워크스페이스 내 역할 → 액션 권한. 컨트롤플레인이 엔드포인트마다 강제(authZ).
// harnesses:register(인스턴스)·templates:write(템플릿 대분류)는 누구나(viewer+) — 하니스는 협업 eval
// 콘텐츠라 역할 게이트 없음(권한 상관없이 동등 사용).
export type Action =
  | "runs:read"
  | "runs:submit"
  | "harnesses:read"
  | "harnesses:register"
  | "templates:write"
  | "datasets:read"
  | "datasets:write"
  | "datasets:delete"
  | "scorecards:read"
  | "scorecards:run"
  | "judges:read"
  | "judges:write"
  | "models:read"
  | "models:write"
  | "metrics:read"
  | "metrics:write"
  | "runtimes:read"
  | "runtimes:write"
  | "secrets:read"
  | "secrets:write"
  | "connections:read"
  | "connections:write"
  | "keys:read"
  | "keys:write"
  | "members:read"
  | "members:write"
  | "settings:read"
  | "settings:write";

export const ASSAY_ROLES = ["viewer", "member", "admin"] as const;
export type AssayRole = (typeof ASSAY_ROLES)[number];

const ROLE_PERMISSIONS: Record<string, ReadonlySet<Action>> = {
  viewer: new Set<Action>([
    "runs:read",
    "harnesses:read",
    "harnesses:register", // 누구나 등록 가능(역할 게이트 없음 — 협업 eval 콘텐츠)
    "templates:write", // 템플릿(대분류) 정의도 동일 — 누구나(권한 상관없이 동등)
    "datasets:read",
    "scorecards:read",
    "judges:read",
    "models:read",
    "metrics:read",
    "runtimes:read",
    "runtimes:write", // 런타임 등록(+validate/probe)은 role 무관 — 모든 멤버가 자기 워크스페이스 실행 인프라를 등록(harnesses:register 와 동일)
    "members:read", // 팀(워크스페이스 멤버) 조회는 양성 → viewer+
  ]),
  member: new Set<Action>([
    "runs:read",
    "runs:submit",
    "harnesses:read",
    "harnesses:register",
    "templates:write",
    "datasets:read",
    "datasets:write",
    "scorecards:read",
    "scorecards:run",
    "judges:read",
    "judges:write",
    "models:read",
    "models:write", // 모델 정의 = eval 콘텐츠(누구로 돌렸나) → judges/datasets 와 동일하게 member 가능
    "metrics:read",
    "metrics:write", // 메트릭 정의 = eval 콘텐츠(무엇으로 합격 판정하나) → member 가능
    "runtimes:read",
    "runtimes:write", // 런타임 등록(+validate/probe)은 role 무관
    "members:read",
  ]),
  admin: new Set<Action>([
    "runs:read",
    "runs:submit",
    "harnesses:read",
    "harnesses:register",
    "templates:write",
    "datasets:read",
    "datasets:write",
    "datasets:delete", // 데이터셋 버전 소프트 삭제 — admin 전용(생성자 본인은 서비스에서 별도 override). member/viewer 는 미보유
    "scorecards:read",
    "scorecards:run",
    "judges:read",
    "judges:write",
    "models:read",
    "models:write",
    "metrics:read",
    "metrics:write",
    "runtimes:read",
    "runtimes:write", // 런타임 등록은 role 무관(viewer/member 도 보유) — 자격증명 '값'은 secrets:write(admin)로 분리 보호
    "secrets:read", // 시크릿(프로바이더 키)은 강력 → admin 전용
    "secrets:write",
    "connections:read", // 외부 계정 연결(OAuth 토큰)은 강력 → admin 전용(secrets 와 동일 근거)
    "connections:write",
    "keys:read", // API 키는 발급 시 워크스페이스 admin 권한을 가짐 → 발급/취소는 admin 전용(secrets 와 동일 근거)
    "keys:write",
    "members:read",
    "members:write", // 멤버 역할변경/제거/초대 발급 = 거버넌스(admin 초대 발급 포함) → admin 전용
    "settings:read", // 워크스페이스 정책(계측 등) = admin 전용 설정
    "settings:write",
  ]),
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
