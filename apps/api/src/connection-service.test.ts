import { BadRequestError } from "@assay/core";
import {
  InMemoryConnectionStore,
  InMemoryOAuthStateStore,
  InMemoryWorkspaceSettingsStore,
  aesGcmCipher,
} from "@assay/db";
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
const gheEntry: ProviderEntry = { impl: okImpl, selfHosted: true };
const GHE = { host: "https://ghe.acme.io", clientId: "Iv1.cafe", clientSecretName: "GHE_SECRET" };

function build(
  providers: Map<string, ProviderEntry>,
  opts: { secrets?: Record<string, string>; settings?: InMemoryWorkspaceSettingsStore } = {},
) {
  return new ConnectionService({
    store: new InMemoryConnectionStore(aesGcmCipher(Buffer.alloc(32, 1))),
    states: new InMemoryOAuthStateStore(),
    providers,
    secretsFor: async () => opts.secrets ?? {},
    settings: opts.settings ?? new InMemoryWorkspaceSettingsStore(),
    config: { webBaseUrl: "http://web.test", apiPublicUrl: "http://api.test", stateTtlSec: 600 },
  });
}

describe("ConnectionService", () => {
  it("providerCatalog: 3종 전부 항상 노출 — github.com 은 default 있을 때, self-hosted 는 통합 설정 시 connectable=true", async () => {
    const s = build(
      new Map([
        ["github", githubEntry],
        ["github-enterprise", gheEntry],
      ]),
      {
        secrets: { GHE_SECRET: "x" },
      },
    );
    // 통합 미설정 — 둘 다 노출되지만(숨기지 않음) github.com 만 connectable. self-hosted 는 설정 안내 대상.
    expect(await s.providerCatalog("acme")).toEqual([
      { id: "github", selfHosted: false, connectable: true },
      { id: "github-enterprise", selfHosted: true, connectable: false },
    ]);
    // 관리자가 통합 등록 → self-hosted 도 connectable=true
    await s.setIntegration("acme", "github-enterprise", { ...GHE, clientId: "c" });
    expect(await s.providerCatalog("acme")).toEqual([
      { id: "github", selfHosted: false, connectable: true },
      { id: "github-enterprise", selfHosted: true, connectable: true },
    ]);
    // github.com default(env OAuth 앱) 없으면 노출은 되되 connectable=false
    expect(await build(new Map([["github", { impl: okImpl, selfHosted: false }]])).providerCatalog("acme")).toEqual([
      { id: "github", selfHosted: false, connectable: false },
    ]);
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
    expect(redirectTo).toBe("http://web.test/acme/account?tab=connections&connected=github");
    expect(await s.list("u")).toHaveLength(1); // 개인 소유: owner=createdBy("u")
    expect(await s.listForWorkspace("acme")).toHaveLength(1); // 만들어진 워크스페이스 로스터에도 노출
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
      "http://web.test/acme/account?tab=connections&error=access_denied",
    );
    expect(await s.list("u")).toHaveLength(0);
  });

  it("토큰 교환 실패는 5xx 없이 exchange_failed 로 리다이렉트", async () => {
    const s = build(
      new Map([["github", { impl: failingImpl, selfHosted: false, default: { clientId: "c", clientSecret: "s" } }]]),
    );
    const { authorizeUrl } = await s.start({ workspace: "acme", createdBy: "u", provider: "github" });
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    expect((await s.callback({ code: "c", state })).redirectTo).toBe(
      "http://web.test/acme/account?tab=connections&error=exchange_failed",
    );
    expect(await s.list("u")).toHaveLength(0);
  });

  it("apiPublicUrl 없고 requestBaseUrl 없으면 start BadRequest (redirect_uri 결정 불가)", async () => {
    const s = new ConnectionService({
      store: new InMemoryConnectionStore(aesGcmCipher(Buffer.alloc(32, 1))),
      states: new InMemoryOAuthStateStore(),
      providers: new Map([["github", githubEntry]]),
      secretsFor: async () => ({}),
      settings: new InMemoryWorkspaceSettingsStore(),
      config: { webBaseUrl: "http://web.test" },
    });
    await expect(s.start({ workspace: "acme", createdBy: "u", provider: "github" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  // ── self-hosted (GHE/Mattermost): 관리자 통합 1회 등록 → 멤버 원클릭 ──────────────────
  it("self-hosted start: 워크스페이스 통합 미설정이면 BadRequest(자격증명을 받지 않는다)", async () => {
    const s = build(new Map([["github-enterprise", gheEntry]]));
    await expect(s.start({ workspace: "acme", createdBy: "u", provider: "github-enterprise" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("self-hosted: 통합은 있으나 SecretStore 에 client_secret 없으면 start BadRequest", async () => {
    const s = build(new Map([["github-enterprise", gheEntry]]), {}); // secrets 비어있음
    await s.setIntegration("acme", "github-enterprise", GHE);
    await expect(s.start({ workspace: "acme", createdBy: "u", provider: "github-enterprise" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("self-hosted 왕복: 관리자 통합 등록 → 멤버 원클릭 start → SecretStore name-ref resolve → host 포함 저장", async () => {
    const s = build(new Map([["github-enterprise", gheEntry]]), { secrets: { GHE_SECRET: "ghs_real" } });
    await s.setIntegration("acme", "github-enterprise", GHE);
    // 멤버는 자격증명 없이 provider 만으로 start
    const { authorizeUrl } = await s.start({ workspace: "acme", createdBy: "u", provider: "github-enterprise" });
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("host")).toBe("https://ghe.acme.io"); // impl 이 통합의 config.host 를 받았다
    expect(u.searchParams.get("cid")).toBe("Iv1.cafe");
    const state = u.searchParams.get("state") as string;
    const { redirectTo } = await s.callback({ code: "c", state });
    expect(redirectTo).toBe("http://web.test/acme/account?tab=connections&connected=github-enterprise");
    const list = await s.list("u");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "github-enterprise", host: "https://ghe.acme.io" });
  });

  // ── 통합 관리(관리자) ─────────────────────────────────────────────────
  it("setIntegration: self-hosted 가 아닌 provider 면 BadRequest", async () => {
    const s = build(new Map([["github", githubEntry]]));
    await expect(
      s.setIntegration("acme", "github", { host: "https://x.io", clientId: "c", clientSecretName: "n" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("listIntegrations/remove: provider별 read-merge-write(다른 통합 보존) + 해제 + 시크릿값 미반환", async () => {
    const s = build(
      new Map([
        ["github-enterprise", gheEntry],
        ["mattermost", { impl: okImpl, selfHosted: true }],
      ]),
    );
    await s.setIntegration("acme", "github-enterprise", {
      host: "https://ghe.acme.io",
      clientId: "g",
      clientSecretName: "GHE",
    });
    await s.setIntegration("acme", "mattermost", { host: "https://mm.acme.io", clientId: "m", clientSecretName: "MM" });
    expect(await s.listIntegrations("acme")).toEqual([
      {
        id: "github-enterprise",
        selfHosted: true,
        configured: true,
        host: "https://ghe.acme.io",
        clientId: "g",
        clientSecretName: "GHE",
      },
      {
        id: "mattermost",
        selfHosted: true,
        configured: true,
        host: "https://mm.acme.io",
        clientId: "m",
        clientSecretName: "MM",
      },
    ]);
    await s.removeIntegration("acme", "github-enterprise");
    const after = await s.listIntegrations("acme");
    expect(after.find((p) => p.id === "github-enterprise")?.configured).toBe(false);
    expect(after.find((p) => p.id === "mattermost")?.configured).toBe(true); // 다른 통합 보존
  });

  it("elevated=true: provider elevatedScopes 를 기본에 더해 요청(github admin:org, org 러너용); 미지정=기본만", async () => {
    // scope 를 authorize URL 에 echo 하는 impl 로 상향 여부를 관찰(실 HTTP 없음).
    const echoScopes: OAuthProvider = {
      defaultScopes: ["repo", "read:packages"],
      elevatedScopes: ["admin:org"],
      authorizeUrl: ({ state, scopes }) =>
        `https://gh.test/auth?state=${state}&scope=${encodeURIComponent((scopes ?? ["repo", "read:packages"]).join(" "))}`,
      exchange: async () => ({ accessToken: "t", scopes: ["repo", "read:packages", "admin:org"] }),
      whoami: async () => ({ label: "octocat" }),
    };
    const s = build(
      new Map([["github", { impl: echoScopes, selfHosted: false, default: { clientId: "c", clientSecret: "s" } }]]),
    );
    const normal = await s.start({ workspace: "acme", createdBy: "u", provider: "github" });
    expect(new URL(normal.authorizeUrl).searchParams.get("scope")).toBe("repo read:packages"); // 기본(과요청 없음)
    const elevated = await s.start({ workspace: "acme", createdBy: "u", provider: "github", elevated: true });
    expect(new URL(elevated.authorizeUrl).searchParams.get("scope")).toContain("admin:org"); // 상향
  });

  it("elevated=true 인데 provider 가 상향 scope 없으면 no-op(기본 scope) — 조용히 무해", async () => {
    const noElevated: OAuthProvider = {
      defaultScopes: ["read"],
      authorizeUrl: ({ state, scopes }) => `https://mm.test/auth?state=${state}&scope=${(scopes ?? ["read"]).join(" ")}`,
      exchange: async () => ({ accessToken: "t", scopes: ["read"] }),
      whoami: async () => ({ label: "u" }),
    };
    const s = build(
      new Map([["mattermost", { impl: noElevated, selfHosted: false, default: { clientId: "c", clientSecret: "s" } }]]),
    );
    const r = await s.start({ workspace: "acme", createdBy: "u", provider: "mattermost", elevated: true });
    expect(new URL(r.authorizeUrl).searchParams.get("scope")).toBe("read"); // 상향 scope 없음 → 기본
  });
});
