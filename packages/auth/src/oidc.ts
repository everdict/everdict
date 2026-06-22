import { type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { ASSAY_ROLES } from "./authz.js";
import type { Authenticator } from "./principal.js";

// 검증 실패 진단 정보(상위 앱이 로그로 남긴다). 토큰을 신뢰하지 않고 사유 파악용으로만 디코드한 값.
export interface OidcVerifyErrorInfo {
  code: string; // jose 에러 코드(ERR_JWT_EXPIRED 등) | "JWKS_FETCH_FAILED"(네트워크/DNS/TLS) | "UNKNOWN"
  message: string; // 원본 에러 메시지(요약)
  expectedIssuer: string; // 컨트롤플레인이 기대하는 issuer(=KEYCLOAK_ISSUER)
  tokenIssuer?: string; // 토큰의 iss(검증 전 디코드) — issuer 불일치 진단용
  tokenAudience?: unknown; // 토큰의 aud — audience 불일치 진단용
  claimKeys?: string[]; // 토큰 최상위 claim 이름들 — workspaceClaim 존재 여부 진단용
}

export interface OidcAuthOptions {
  issuer: string; // 예: http://localhost:8080/realms/assay
  audience?: string;
  jwksUri?: string; // 기본 `${issuer}/protocol/openid-connect/certs`
  workspaceClaim?: string; // 기본 "workspace"
  groupPrefix?: string; // 폴백: groups 중 이 접두사 첫 그룹 → 워크스페이스. 기본 "/workspaces/"
  keySet?: JWTVerifyGetKey; // 테스트 주입(로컬 키셋)
  // JWT 검증 실패 사유를 상위(앱)가 로깅할 수 있게 알린다(401 원인 파악용). 정상적인 "내 자격증명 아님"
  // (ak_ API 키/비-JWT)은 호출하지 않는다 — 검증을 시도했다가 실패한 경우만. 콜백 예외는 인증을 깨지 않는다.
  onError?: (info: OidcVerifyErrorInfo) => void;
}

function looksLikeJwt(t: string): boolean {
  return !t.startsWith("ak_") && t.split(".").length === 3;
}

// jose/네트워크 에러 → 사람이 읽는 진단 정보. 검증 실패한 토큰이라도(신뢰하지 않고) iss/aud/claim 키를 디코드해 남긴다.
function describeVerifyError(err: unknown, bearer: string, expectedIssuer: string): OidcVerifyErrorInfo {
  const code =
    typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  // JWKS 미도달(컨트롤플레인이 Keycloak 에 못 닿음)은 jose 코드가 아니라 fetch 실패로 온다 — 따로 분류해 눈에 띄게.
  const isFetchFail =
    code === "ERR_JWKS_TIMEOUT" || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|socket/i.test(message);
  const info: OidcVerifyErrorInfo = { code: isFetchFail ? "JWKS_FETCH_FAILED" : code, message, expectedIssuer };
  try {
    const payload = decodeJwt(bearer);
    if (typeof payload.iss === "string") info.tokenIssuer = payload.iss;
    if (payload.aud !== undefined) info.tokenAudience = payload.aud;
    info.claimKeys = Object.keys(payload);
  } catch {
    // 디코드 불가(비정상 페이로드)는 무시 — 코드/메시지만으로도 사유 파악 가능.
  }
  return info;
}

// 워크스페이스 = 토큰의 claim(기본 workspace) 또는 그룹(/workspaces/<ws>/…)에서 파생.
function extractWorkspace(payload: Record<string, unknown>, claim: string, prefix: string): string | undefined {
  const direct = payload[claim];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const groups = payload.groups;
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (typeof g === "string" && g.startsWith(prefix)) {
        return g.slice(prefix.length).split("/")[0];
      }
    }
  }
  return undefined;
}

// 역할 = Keycloak realm_access.roles 중 Assay 역할만. 없으면 viewer.
function extractRoles(payload: Record<string, unknown>): string[] {
  const realm = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
  const all = Array.isArray(realm) ? realm.filter((r): r is string => typeof r === "string") : [];
  const known = all.filter((r) => (ASSAY_ROLES as readonly string[]).includes(r));
  return known.length > 0 ? known : ["viewer"];
}

// Keycloak(OIDC) JWT 검증 인증기 — JWKS 로 서명 검증, issuer/audience 확인, 워크스페이스/역할 추출.
export function oidcAuthenticator(opts: OidcAuthOptions): Authenticator {
  const jwks =
    opts.keySet ??
    createRemoteJWKSet(new URL(opts.jwksUri ?? `${opts.issuer.replace(/\/$/, "")}/protocol/openid-connect/certs`));
  const workspaceClaim = opts.workspaceClaim ?? "workspace";
  const groupPrefix = opts.groupPrefix ?? "/workspaces/";

  return {
    async authenticate(bearer) {
      if (!looksLikeJwt(bearer)) return undefined;
      try {
        const { payload } = await jwtVerify(bearer, jwks, {
          issuer: opts.issuer,
          ...(opts.audience ? { audience: opts.audience } : {}),
        });
        // workspace 클레임/그룹이 없어도(예: 외부 Keycloak 에 workspace 매퍼가 없는 경우) 토큰이 유효하면 인증한다.
        // 워크스페이스는 self-serve 멤버십이 SSOT 이므로, 클레임 없는 사용자는 workspace="" (아직 없음)로 두고
        // apps/api 의 멤버십 해석(부트스트랩) + 웹 온보딩(첫 워크스페이스 생성)이 채운다.
        // fail-closed 는 *검증 불가* 토큰(서명/issuer/audience/만료 실패)에만 적용 — 그건 아래 catch 가 undefined 로.
        const workspace = extractWorkspace(payload as Record<string, unknown>, workspaceClaim, groupPrefix) ?? "";
        return {
          subject: String(payload.sub ?? ""),
          workspace,
          roles: extractRoles(payload as Record<string, unknown>),
          via: "oidc",
        };
      } catch (err) {
        // 검증 실패 사유를 상위가 로깅할 수 있게 알린다(로깅 실패가 인증 흐름을 깨지 않도록 격리).
        try {
          opts.onError?.(describeVerifyError(err, bearer, opts.issuer));
        } catch {
          // 콜백 예외 무시.
        }
        return undefined; // 검증 실패 → 미인증
      }
    },
  };
}
