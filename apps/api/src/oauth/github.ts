import { UpstreamError } from "@assay/core";
import { z } from "zod";
import { type OAuthAccount, type OAuthExchangeResult, type OAuthProvider, oauthFetchJson } from "./provider.js";

// GitHub OAuth App provider — stateless host-aware kind. host 없으면 github.com, 있으면 GHE(self-hosted).
// 클래식 OAuth App = 비만료 user access token(refresh 없음). 자격증명/호스트는 config 로 주입.
const TokenResponse = z.object({
  access_token: z.string(),
  scope: z.string().default(""), // 승인 scope, 콤마 구분
  token_type: z.string().optional(),
});
// GitHub 토큰 엔드포인트는 실패도 HTTP 200 + {error} 로 준다 → 본문으로 분기.
const TokenError = z.object({ error: z.string(), error_description: z.string().optional() });
const UserResponse = z.object({ login: z.string() });

const DEFAULT_SCOPES = ["repo", "read:packages"];
// 상향(옵트인) scope — org 러너 등록(POST /orgs/{org}/actions/runners/registration-token)에 필요한 admin:org.
// 기본 연결엔 요청하지 않는다(과요청 방지) — 사용자가 명시적으로 상향 연결할 때만.
const ELEVATED_SCOPES = ["admin:org"];

// host="https://ghe.acme.io" → web base = host, api base = host/api/v3. 없으면 github.com / api.github.com.
function bases(host?: string): { web: string; api: string } {
  if (!host) return { web: "https://github.com", api: "https://api.github.com" };
  const trimmed = host.endsWith("/") ? host.slice(0, -1) : host;
  return { web: trimmed, api: `${trimmed}/api/v3` };
}

export function githubProvider(): OAuthProvider {
  return {
    defaultScopes: DEFAULT_SCOPES,
    elevatedScopes: ELEVATED_SCOPES,
    authorizeUrl({ config, state, redirectUri, scopes }) {
      const u = new URL(`${bases(config.host).web}/login/oauth/authorize`);
      u.searchParams.set("client_id", config.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", (scopes ?? DEFAULT_SCOPES).join(" "));
      u.searchParams.set("state", state);
      return u.toString();
    },
    async exchange({ config, code, redirectUri }): Promise<OAuthExchangeResult> {
      const body = await oauthFetchJson(`${bases(config.host).web}/login/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const err = TokenError.safeParse(body);
      if (err.success)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { provider: "github", error: err.data.error },
          `GitHub 토큰 교환 실패: ${err.data.error_description ?? err.data.error}`,
        );
      const tok = TokenResponse.parse(body);
      return {
        accessToken: tok.access_token,
        scopes: tok.scope
          ? tok.scope
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      };
    },
    async whoami({ config, accessToken }): Promise<OAuthAccount> {
      const body = await oauthFetchJson(`${bases(config.host).api}/user`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "assay", // GitHub API 는 User-Agent 필수
        },
      });
      return { label: UserResponse.parse(body).login };
    },
  };
}
