import { sign } from "node:crypto";
import { z } from "zod";
import { oauthFetchJson } from "./provider.js";

// GitHub App(installation) 토큰 발급 — 워크스페이스 소유 통합의 코어(개인 OAuth 연결 대체).
// OAuth App 의 `repo` 스코프(전 repo all-or-nothing)와 달리, App 은 설치 시 고른 repo + 지정 권한으로
// GitHub 이 직접 제한한 단기(~1h) installation access token 을 준다. host 유무로 github.com↔GHE 동시 처리.
// 설계: docs/architecture/workspace-scoped-integrations.md

// host="https://ghe.acme.io" → api base = host/api/v3. 없으면 api.github.com(github.com).
function apiBase(host?: string): string {
  if (!host) return "https://api.github.com";
  const trimmed = host.endsWith("/") ? host.slice(0, -1) : host;
  return `${trimmed}/api/v3`;
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

// App JWT(RS256) — iss=appId, 만료 10분 이내. PEM 개인키로 서명(Node 내장 crypto — 외부 의존성 없음).
// iat 를 60초 당겨 컨트롤플레인↔GitHub 시계 오차를 흡수한다(GitHub 권장). nowSec 주입 → 결정적 테스트.
export function githubAppJwt(input: { appId: string; privateKeyPem: string; nowSec: number }): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: input.nowSec - 60, exp: input.nowSec + 540, iss: input.appId }));
  const data = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(data), input.privateKeyPem).toString("base64url");
  return `${data}.${signature}`;
}

// installation token 응답 — 필요한 두 필드만(나머지 무시). 실패 시 oauthFetchJson 이 UpstreamError 로 remap.
const InstallationTokenResponse = z.object({ token: z.string(), expires_at: z.string() });

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO — 이 토큰 만료(약 1시간 뒤)
}

// installation access token 발급 — App JWT 로 인증하고 repositories/permissions 로 좁혀 요청한다.
// repositories: 소유 계정 기준 repo **name** 배열(owner 제외 — installation 이 이미 그 계정 소유). 미지정이면 설치 전체.
// permissions: 예 { contents: "read" }(clone). 미지정이면 App 이 승인받은 기본 권한.
export async function mintInstallationToken(input: {
  host?: string;
  appId: string;
  privateKeyPem: string;
  installationId: number;
  repositories?: string[];
  permissions?: Record<string, string>;
  nowSec: number;
}): Promise<InstallationToken> {
  const jwt = githubAppJwt({ appId: input.appId, privateKeyPem: input.privateKeyPem, nowSec: input.nowSec });
  const body = await oauthFetchJson(`${apiBase(input.host)}/app/installations/${input.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "assay", // GitHub API 는 User-Agent 필수
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...(input.repositories ? { repositories: input.repositories } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
    }),
  });
  const parsed = InstallationTokenResponse.parse(body);
  return { token: parsed.token, expiresAt: parsed.expires_at };
}
