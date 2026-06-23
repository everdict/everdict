import { BadRequestError } from "@assay/core";
import { InMemoryConnectionStore, InMemoryOAuthStateStore, aesGcmCipher } from "@assay/db";
import { describe, expect, it } from "vitest";
import { ConnectionService, type ProviderEntry } from "./connection-service.js";
import type { OAuthProvider } from "./oauth/provider.js";

// config-based stateless impl(실제 HTTP 없음). host 를 authorizeUrl 에 echo 해 self-hosted 분기를 관찰.
const okImpl: OAuthProvider = {
  defaultScopes: ["repo"],
  authorizeUrl: ({ config, state, redirectUri }) =>
    `https://gh.test/auth?state=${state}&redirect_uri=${redirectUri}&host=${config.host ?? ""}&cid=${config.clientId}`,
  exchange: async () => ({ accessToken: "tok", scopes: ["repo"] }),
  whoami: async () => ({ label: "octocat" }),
};
const failingImpl: OAuthProvider = {
  ...okImpl,
  exchange: async () => {
    throw new Error("boom");
  },
};

const githubEntry: ProviderEntry = {
  impl: okImpl,
  selfHosted: false,
  default: { clientId: "cid", clientSecret: "csec" },
};

function build(providers: Map<string, ProviderEntry>, secrets: Record<string, string> = {}) {
  return new ConnectionService({
    store: new InMemoryConnectionStore(aesGcmCipher(Buffer.alloc(32, 1))),
    states: new InMemoryOAuthStateStore(),
    providers,
    secretsFor: async () => secrets,
    config: { webBaseUrl: "http://web.test", apiPublicUrl: "http://api.test", stateTtlSec: 600 },
  });
}

describe("ConnectionService", () => {
  it("providerInfos: github.com 은 default 있을 때만, self-hosted 는 항상", () => {
    const both = build(
      new Map([
        ["github", githubEntry],
        ["github-enterprise", { impl: okImpl, selfHosted: true }],
      ]),
    );
    expect(both.providerInfos()).toEqual([
      { id: "github", selfHosted: false },
      { id: "github-enterprise", selfHosted: true },
    ]);
    // github.com default 없으면 미노출.
    expect(build(new Map([["github", { impl: okImpl, selfHosted: false }]])).providerInfos()).toEqual([]);
  });

  it("미설정 provider start 는 BadRequestError", async () => {
    await expect(
      build(new Map([["github", githubEntry]])).start({ workspace: "acme", createdBy: "u", provider: "gitlab" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("github.com start → callback 왕복으로 연결 저장 + 성공 리다이렉트", async () => {
    const s = build(new Map([["github", githubEntry]]));
    const { authorizeUrl } = await s.start({ workspace: "acme", createdBy: "u", provider: "github" });
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    const { redirectTo } = await s.callback({ code: "c", state });
    expect(redirectTo).toBe("http://web.test/acme/settings?tab=connections&connected=github");
    expect(await s.list("acme")).toHaveLength(1);
  });

  it("state 없는 콜백 → missing_state (워크스페이스 모름 → 루트 에러)", async () => {
    expect((await build(new Map([["github", githubEntry]])).callback({ code: "c" })).redirectTo).toBe(
      "http://web.test/?connection_error=missing_state",
    );
  });

  it("provider 가 error 를 돌려주면 워크스페이스 설정으로 에러 리다이렉트(저장 안 됨)", async () => {
    const s = build(new Map([["github", githubEntry]]));
    const { authorizeUrl } = await s.start({ workspace: "acme", createdBy: "u", provider: "github" });
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    expect((await s.callback({ state, error: "access_denied" })).redirectTo).toBe(
      "http://web.test/acme/settings?tab=connections&error=access_denied",
    );
    expect(await s.list("acme")).toHaveLength(0);
  });

  it("토큰 교환 실패는 5xx 없이 exchange_failed 로 리다이렉트", async () => {
    const s = build(
      new Map([["github", { impl: failingImpl, selfHosted: false, default: { clientId: "c", clientSecret: "s" } }]]),
    );
    const { authorizeUrl } = await s.start({ workspace: "acme", createdBy: "u", provider: "github" });
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    expect((await s.callback({ code: "c", state })).redirectTo).toBe(
      "http://web.test/acme/settings?tab=connections&error=exchange_failed",
    );
    expect(await s.list("acme")).toHaveLength(0);
  });

  it("apiPublicUrl 없고 requestBaseUrl 없으면 start BadRequest (redirect_uri 결정 불가)", async () => {
    const s = new ConnectionService({
      store: new InMemoryConnectionStore(aesGcmCipher(Buffer.alloc(32, 1))),
      states: new InMemoryOAuthStateStore(),
      providers: new Map([["github", githubEntry]]),
      secretsFor: async () => ({}),
      config: { webBaseUrl: "http://web.test" },
    });
    await expect(s.start({ workspace: "acme", createdBy: "u", provider: "github" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  // ── self-hosted (GHE/Mattermost) ──────────────────────────────────────
  it("self-hosted start: host/clientId/clientSecretName 누락이면 BadRequest", async () => {
    const s = build(new Map([["github-enterprise", { impl: okImpl, selfHosted: true }]]));
    await expect(
      s.start({ workspace: "acme", createdBy: "u", provider: "github-enterprise", host: "https://ghe.acme.io" }),
    ).rejects.toBeInstanceOf(BadRequestError); // clientId/clientSecretName 없음
  });

  it("self-hosted: SecretStore 에 client_secret 없으면 start BadRequest", async () => {
    const s = build(new Map([["github-enterprise", { impl: okImpl, selfHosted: true }]]), {}); // secrets 비어있음
    await expect(
      s.start({
        workspace: "acme",
        createdBy: "u",
        provider: "github-enterprise",
        host: "https://ghe.acme.io",
        clientId: "Iv1.cafe",
        clientSecretName: "GHE_SECRET",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("self-hosted 왕복: SecretStore name-ref 로 client_secret resolve → host 포함 저장", async () => {
    const s = build(new Map([["github-enterprise", { impl: okImpl, selfHosted: true }]]), { GHE_SECRET: "ghs_real" });
    const { authorizeUrl } = await s.start({
      workspace: "acme",
      createdBy: "u",
      provider: "github-enterprise",
      host: "https://ghe.acme.io",
      clientId: "Iv1.cafe",
      clientSecretName: "GHE_SECRET",
    });
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("host")).toBe("https://ghe.acme.io"); // impl 이 config.host 를 받았다
    expect(u.searchParams.get("cid")).toBe("Iv1.cafe");
    const state = u.searchParams.get("state") as string;
    const { redirectTo } = await s.callback({ code: "c", state });
    expect(redirectTo).toBe("http://web.test/acme/settings?tab=connections&connected=github-enterprise");
    const list = await s.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "github-enterprise", host: "https://ghe.acme.io" });
  });
});
