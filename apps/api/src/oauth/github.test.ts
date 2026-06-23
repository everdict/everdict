import { UpstreamError } from "@assay/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubProvider } from "./github.js";

const provider = githubProvider();
const cfg = { clientId: "cid", clientSecret: "csec" };
const redirectUri = "http://api.test/connections/callback";

afterEach(() => {
  vi.unstubAllGlobals();
});

// fetch 를 stub — (url) → {status, json} 핸들러로 결정적 응답.
function mockFetch(handler: (url: string) => { status?: number; body: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const { status = 200, body } = handler(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}

describe("githubProvider (github.com)", () => {
  it("authorizeUrl 은 client_id/redirect_uri/scope/state 를 담는다", () => {
    const u = new URL(provider.authorizeUrl({ config: cfg, state: "st123", redirectUri }));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(u.searchParams.get("scope")).toBe("repo read:packages");
    expect(u.searchParams.get("state")).toBe("st123");
  });

  it("exchange 성공 → accessToken + 콤마구분 scope 파싱", async () => {
    mockFetch(() => ({ body: { access_token: "gho_abc", token_type: "bearer", scope: "repo,read:packages" } }));
    expect(await provider.exchange({ config: cfg, code: "c", redirectUri })).toEqual({
      accessToken: "gho_abc",
      scopes: ["repo", "read:packages"],
    });
  });

  it("exchange 실패(GitHub 는 200+{error}) → UpstreamError 로 remap", async () => {
    mockFetch(() => ({ body: { error: "bad_verification_code", error_description: "코드 만료" } }));
    await expect(provider.exchange({ config: cfg, code: "bad", redirectUri })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("whoami → login 을 label 로", async () => {
    mockFetch((url) => {
      expect(url).toBe("https://api.github.com/user");
      return { body: { login: "octocat", id: 1 } };
    });
    expect(await provider.whoami({ config: cfg, accessToken: "gho_abc" })).toEqual({ label: "octocat" });
  });

  it("비-2xx 응답 → UpstreamError", async () => {
    mockFetch(() => ({ status: 401, body: { message: "Bad credentials" } }));
    await expect(provider.whoami({ config: cfg, accessToken: "nope" })).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("githubProvider (GHE — host 분기)", () => {
  const ghe = { clientId: "cid", clientSecret: "csec", host: "https://ghe.acme.io" };
  it("host 가 있으면 authorize/api 베이스가 GHE 로 바뀐다", async () => {
    const u = new URL(provider.authorizeUrl({ config: ghe, state: "s", redirectUri }));
    expect(u.origin + u.pathname).toBe("https://ghe.acme.io/login/oauth/authorize");
    mockFetch((url) => {
      expect(url).toBe("https://ghe.acme.io/api/v3/user"); // GHE 는 /api/v3
      return { body: { login: "enterprise-bot" } };
    });
    expect(await provider.whoami({ config: ghe, accessToken: "x" })).toEqual({ label: "enterprise-bot" });
  });
});
