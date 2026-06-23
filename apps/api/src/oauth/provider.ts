import { UpstreamError } from "@assay/core";

// 아웃바운드 OAuth 클라이언트 추상화 — Assay 가 외부 provider(GitHub/GHE/Mattermost)의 OAuth "클라이언트".
// (인바운드 Keycloak 과 반대 방향: 우리가 외부 계정에 권한을 요청한다.)
// provider 는 **stateless kind** — 자격증명/호스트는 호출 시 config 로 주입한다(github.com=env 기본,
// self-hosted=워크스페이스 SecretStore name-ref). 한 impl 이 host 유무로 github.com↔GHE 를 모두 처리.
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  host?: string; // self-hosted 베이스(GHE/Mattermost). github.com 은 생략.
}

export interface OAuthExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // access token 만료(있으면) — 갱신 판단용
  scopes: string[]; // 실제 승인된 scope
}

export interface OAuthAccount {
  label: string; // 표시용 계정 식별자(예: github login)
}

export interface OAuthProvider {
  readonly defaultScopes: string[]; // 요청 scope
  // 사용자 브라우저를 보낼 authorize URL(state + redirect_uri 포함).
  authorizeUrl(input: { config: OAuthProviderConfig; state: string; redirectUri: string }): string;
  // 콜백 code → 토큰 교환(server-to-server, client_secret). 실패는 AppError(UpstreamError)로 remap.
  exchange(input: { config: OAuthProviderConfig; code: string; redirectUri: string }): Promise<OAuthExchangeResult>;
  // 토큰으로 계정 식별자 조회(표시용 라벨).
  whoami(input: { config: OAuthProviderConfig; accessToken: string }): Promise<OAuthAccount>;
}

// JSON fetch + 외부 실패를 UpstreamError 로 remap(원시 에러를 호출자에게 전파하지 않는다 — digo 이디엄).
// github/mattermost provider 가 공유. fetch 실패/파싱 실패/비-2xx 모두 UpstreamError.
export async function oauthFetchJson(url: string, init: Parameters<typeof fetch>[1]): Promise<unknown> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new UpstreamError("UPSTREAM_ERROR", { url }, `외부 요청 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { url, status: res.status },
        `외부 응답 파싱 실패(status ${res.status})`,
      );
    }
  }
  if (!res.ok)
    throw new UpstreamError("UPSTREAM_ERROR", { url, status: res.status }, `외부 요청 실패(status ${res.status})`);
  return json;
}
