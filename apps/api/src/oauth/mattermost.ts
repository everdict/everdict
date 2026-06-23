import { BadRequestError } from "@assay/core";
import { z } from "zod";
import { type OAuthAccount, type OAuthExchangeResult, type OAuthProvider, oauthFetchJson } from "./provider.js";

// Mattermost OAuth2 provider — stateless host-aware kind. self-hosted 전용(글로벌 default 없음 → host 필수).
// authorize: /oauth/authorize, token: /oauth/access_token(form-encoded, access+refresh+expires_in),
// whoami: /api/v4/users/me. refresh 토큰/만료를 보존(ConnectionStore 가 컬럼 보유).
const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(), // 초
  scope: z.string().optional(),
});

const UserResponse = z.object({ username: z.string() });

function base(host?: string): string {
  if (!host) throw new BadRequestError("BAD_REQUEST", {}, "Mattermost 연결은 host(서버 URL)가 필요합니다.");
  return host.endsWith("/") ? host.slice(0, -1) : host;
}

export function mattermostProvider(now: () => Date = () => new Date()): OAuthProvider {
  return {
    defaultScopes: [], // Mattermost OAuth 는 scope 를 요구하지 않는다(앱 권한으로 결정)
    authorizeUrl({ config, state, redirectUri }) {
      const u = new URL(`${base(config.host)}/oauth/authorize`);
      u.searchParams.set("client_id", config.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("state", state);
      return u.toString();
    },
    async exchange({ config, code, redirectUri }): Promise<OAuthExchangeResult> {
      // Mattermost 토큰 엔드포인트는 application/x-www-form-urlencoded 를 받는다(github 의 JSON 과 다름).
      const form = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });
      const body = await oauthFetchJson(`${base(config.host)}/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
      });
      const tok = TokenResponse.parse(body);
      return {
        accessToken: tok.access_token,
        scopes: tok.scope ? tok.scope.split(/\s+/).filter(Boolean) : [],
        ...(tok.refresh_token !== undefined ? { refreshToken: tok.refresh_token } : {}),
        ...(tok.expires_in !== undefined
          ? { expiresAt: new Date(now().getTime() + tok.expires_in * 1000).toISOString() }
          : {}),
      };
    },
    async whoami({ config, accessToken }): Promise<OAuthAccount> {
      const body = await oauthFetchJson(`${base(config.host)}/api/v4/users/me`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
      return { label: UserResponse.parse(body).username };
    },
  };
}
