import { ForbiddenError } from "@assay/core";
import type { Principal } from "./principal.js";

// 워크스페이스 내 역할 → 액션 권한. 컨트롤플레인이 엔드포인트마다 강제(authZ).
// harnesses:register(인스턴스)·templates:write(템플릿 대분류)는 누구나(viewer+) — 하니스는 협업 eval
// 콘텐츠라 역할 게이트 없음(권한 상관없이 동등 사용).
// 외부 계정 연결(Connected accounts)은 이 매트릭스에 없다 — 프로필처럼 개인 소유(owner=subject)라 역할이 아니라
// subject 로 self-scoped(라우트가 principal.subject 로 직접 스코프; connections:* 액션 없음).
export type Action =
  | "runs:read"
  | "runs:submit"
  | "harnesses:read"
  | "harnesses:register"
  | "templates:write"
  | "datasets:read"
  | "datasets:write"
  | "datasets:delete"
  | "harnesses:delete"
  | "scorecards:read"
  | "scorecards:run"
  | "schedules:read"
  | "schedules:write"
  | "judges:read"
  | "judges:write"
  | "models:read"
  | "models:write"
  | "runtimes:read"
  | "runtimes:write"
  | "secrets:read"
  | "secrets:write"
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
    "schedules:read", // 예약 조회는 양성(스코어카드 조회와 동일) → viewer+
    "judges:read",
    "models:read",
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
    "schedules:read",
    "schedules:write", // 예약 생성 = 반복 실행 약속(예산 소비) → scorecards:run 과 동일하게 member+
    "judges:read",
    "judges:write",
    "models:read",
    "models:write", // 모델 정의 = eval 콘텐츠(누구로 돌렸나) → judges/datasets 와 동일하게 member 가능
    "runtimes:read",
    "runtimes:write", // 런타임 등록(+validate/probe)은 role 무관
    "members:read",
  ]),
  // GitHub Actions OIDC 페더레이션(via=github-actions) 전용 — CI 가 필요한 최소만:
  // 발사/폴링/diff(scorecards) + 재핀(harnesses:register)/기준 조회(harnesses:read). 거버넌스/시크릿/멤버는 없음.
  ci: new Set<Action>(["scorecards:read", "scorecards:run", "harnesses:read", "harnesses:register"]),
  admin: new Set<Action>([
    "runs:read",
    "runs:submit",
    "harnesses:read",
    "harnesses:register",
    "templates:write",
    "datasets:read",
    "datasets:write",
    "datasets:delete", // 데이터셋 버전 소프트 삭제 — admin 전용(생성자 본인은 서비스에서 별도 override). member/viewer 는 미보유
    "harnesses:delete", // 하니스 버전 소프트 삭제 — 동일 패턴(admin 전용 + 생성자 예외는 서비스 계층)
    "scorecards:read",
    "scorecards:run",
    "schedules:read",
    "schedules:write",
    "judges:read",
    "judges:write",
    "models:read",
    "models:write",
    "runtimes:read",
    "runtimes:write", // 런타임 등록은 role 무관(viewer/member 도 보유) — 자격증명 '값'은 secrets:write(admin)로 분리 보호
    "secrets:read", // 시크릿(프로바이더 키)은 강력 → admin 전용
    "secrets:write",
    "keys:read", // API 키는 발급 시 워크스페이스 admin 권한을 가짐 → 발급/취소는 admin 전용(secrets 와 동일 근거)
    "keys:write",
    "members:read",
    "members:write", // 멤버 역할변경/제거/초대 발급 = 거버넌스(admin 초대 발급 포함) → admin 전용
    "settings:read", // 워크스페이스 정책(계측 등) = admin 전용 설정
    "settings:write",
  ]),
};

// --- API 키별 권한 범위(scope) — Linear 식 "Full Access vs 선택 권한" ---
// 키는 발급 시 워크스페이스 admin role 을 갖지만, scope 로 그 키의 권한을 더 좁힐 수 있다.
// scope 는 role 권한과 "교집합"으로 적용된다(can 참고) — scope 있는 키는 자기 role 을 절대 초과하지 못한다.
// 누적(cumulative): admin ⊃ write ⊃ read. admin scope = Full Access. authz 매트릭스가 scope→action 의 SSOT.
export const API_KEY_SCOPES = ["read", "write", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// read scope = "워크스페이스 데이터 조회" — 민감 조회(secrets/keys/settings)는 제외(admin scope 필요).
const SCOPE_READ_ACTIONS: readonly Action[] = [
  "runs:read",
  "harnesses:read",
  "datasets:read",
  "scorecards:read",
  "schedules:read",
  "judges:read",
  "models:read",
  "runtimes:read",
  "members:read",
];
// write scope = read ∪ 콘텐츠 mutation(run 제출·등록·버전 생성·실행). 거버넌스(secrets/members/settings/keys write, datasets:delete)는 admin scope 전용.
const SCOPE_WRITE_ACTIONS: readonly Action[] = [
  ...SCOPE_READ_ACTIONS,
  "runs:submit",
  "harnesses:register",
  "templates:write",
  "datasets:write",
  "scorecards:run",
  "schedules:write",
  "judges:write",
  "models:write",
  "runtimes:write",
];
// admin scope(=Full Access) = 모든 action. role 매트릭스의 합집합(admin role 이 전체를 보유)에서 도출.
const ALL_ACTIONS = new Set<Action>(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]));

const SCOPE_PERMISSIONS: Record<string, ReadonlySet<Action>> = {
  read: new Set<Action>(SCOPE_READ_ACTIONS),
  write: new Set<Action>(SCOPE_WRITE_ACTIONS),
  admin: ALL_ACTIONS,
};

export function can(principal: Principal, action: Action): boolean {
  const roleOk = principal.roles.some((r) => ROLE_PERMISSIONS[r]?.has(action) ?? false);
  if (!roleOk) return false;
  // scope 없는 주체(OIDC 사용자 / 레거시 키)는 role 권한 그대로(무제한). scope 있으면 교집합으로 좁힌다.
  if (!principal.scopes || principal.scopes.length === 0) return true;
  return principal.scopes.some((s) => SCOPE_PERMISSIONS[s]?.has(action) ?? false);
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
