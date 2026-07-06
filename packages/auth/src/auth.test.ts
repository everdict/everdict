import { ForbiddenError } from "@assay/core";
import { InMemoryRunnerStore, InMemoryTenantKeyStore, hashKey } from "@assay/db";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { apiKeyAuthenticator } from "./api-key.js";
import { authorize, can } from "./authz.js";
import {
  GITHUB_ACTIONS_ISSUER,
  type GithubActionsClaims,
  githubActionsAuthenticator,
  githubEnterpriseIssuer,
} from "./github-actions.js";
import { oidcAuthenticator } from "./oidc.js";
import { type Principal, compositeAuthenticator } from "./principal.js";
import { runnerAuthenticator } from "./runner.js";

const p = (roles: string[]): Principal => ({ subject: "u", workspace: "acme", roles, via: "oidc" });

describe("authz", () => {
  it("역할별 권한 매트릭스", () => {
    expect(can(p(["viewer"]), "runs:read")).toBe(true);
    expect(can(p(["viewer"]), "runs:submit")).toBe(false);
    expect(can(p(["member"]), "runs:submit")).toBe(true);
    // 하니스 등록(인스턴스)·템플릿(대분류) 정의는 누구나(viewer+) — 협업 eval 콘텐츠, 역할 게이트 없음.
    expect(can(p(["viewer"]), "harnesses:register")).toBe(true);
    expect(can(p(["member"]), "harnesses:register")).toBe(true);
    expect(can(p(["admin"]), "harnesses:register")).toBe(true);
    expect(can(p(["viewer"]), "templates:write")).toBe(true);
    expect(can(p(["member"]), "templates:write")).toBe(true);
    expect(can(p(["admin"]), "templates:write")).toBe(true);
    // datasets: 읽기는 viewer+, 쓰기는 member+
    expect(can(p(["viewer"]), "datasets:read")).toBe(true);
    expect(can(p(["viewer"]), "datasets:write")).toBe(false);
    expect(can(p(["member"]), "datasets:write")).toBe(true);
    // scorecards: 읽기는 viewer+, 실행(배치 평가)은 member+
    expect(can(p(["viewer"]), "scorecards:read")).toBe(true);
    expect(can(p(["viewer"]), "scorecards:run")).toBe(false);
    expect(can(p(["member"]), "scorecards:run")).toBe(true);
    // judges: 읽기는 viewer+, 등록은 member+(유저가 자기 judge 를 직접 등록)
    expect(can(p(["viewer"]), "judges:read")).toBe(true);
    expect(can(p(["viewer"]), "judges:write")).toBe(false);
    expect(can(p(["member"]), "judges:write")).toBe(true);
    // runtimes: 읽기·쓰기 모두 role 무관(등록은 누구나 — 자격증명 '값'은 secrets:write 로 분리 보호)
    expect(can(p(["viewer"]), "runtimes:read")).toBe(true);
    expect(can(p(["viewer"]), "runtimes:write")).toBe(true);
    expect(can(p(["member"]), "runtimes:write")).toBe(true);
    expect(can(p(["admin"]), "runtimes:write")).toBe(true);

    // 외부 계정 연결(Connected accounts)은 개인 소유 — authz 매트릭스에 없다(subject 로 self-scoped, 라우트가 직접 스코프).

    // 멤버 조회는 viewer+, 멤버 관리(역할변경/제거/초대)는 admin 전용.
    expect(can(p(["viewer"]), "members:read")).toBe(true);
    expect(can(p(["viewer"]), "members:write")).toBe(false);
    expect(can(p(["member"]), "members:write")).toBe(false);
    expect(can(p(["admin"]), "members:write")).toBe(true);
  });
  it("ci 역할(GitHub Actions 페더레이션)은 발사/폴링/diff + 재핀만 — 거버넌스/시크릿/멤버는 없다", () => {
    expect(can(p(["ci"]), "scorecards:run")).toBe(true);
    expect(can(p(["ci"]), "scorecards:read")).toBe(true); // 폴링 + diff
    expect(can(p(["ci"]), "harnesses:register")).toBe(true); // durable 재핀(POST /harnesses/:id/pins)
    expect(can(p(["ci"]), "harnesses:read")).toBe(true); // 기준 인스턴스 조회
    expect(can(p(["ci"]), "datasets:write")).toBe(false);
    expect(can(p(["ci"]), "runs:submit")).toBe(false);
    expect(can(p(["ci"]), "secrets:read")).toBe(false);
    expect(can(p(["ci"]), "members:read")).toBe(false);
    expect(can(p(["ci"]), "settings:write")).toBe(false);
    expect(can(p(["ci"]), "keys:write")).toBe(false);
  });

  it("authorize 는 권한 없으면 403", () => {
    expect(() => authorize(p(["viewer"]), "secrets:write")).toThrow(ForbiddenError); // 시크릿 값 = admin 전용
    expect(() => authorize(p(["member"]), "runtimes:write")).not.toThrow(); // 런타임 등록 = role 무관
    expect(() => authorize(p(["admin"]), "runtimes:write")).not.toThrow();
  });

  it("api-key scope 는 role 권한과 교집합으로 키를 좁힌다(read⊂write⊂admin, admin=Full Access)", () => {
    const key = (scopes: string[]): Principal => ({
      subject: "key:acme",
      workspace: "acme",
      roles: ["admin"], // 키는 admin role 로 발급되지만 scope 가 더 좁힌다
      via: "api-key",
      scopes,
    });
    // read scope: 데이터 조회만, 쓰기·민감 조회 불가
    expect(can(key(["read"]), "datasets:read")).toBe(true);
    expect(can(key(["read"]), "datasets:write")).toBe(false);
    expect(can(key(["read"]), "secrets:read")).toBe(false); // 민감 조회는 admin scope 필요
    expect(can(key(["read"]), "keys:read")).toBe(false);
    // write scope: read ∪ 콘텐츠 mutation, 거버넌스(secrets/members/keys)는 불가
    expect(can(key(["write"]), "datasets:read")).toBe(true);
    expect(can(key(["write"]), "datasets:write")).toBe(true);
    expect(can(key(["write"]), "runs:submit")).toBe(true);
    expect(can(key(["write"]), "secrets:write")).toBe(false);
    expect(can(key(["write"]), "members:write")).toBe(false);
    expect(can(key(["write"]), "keys:write")).toBe(false);
    // admin scope(=Full Access): 전부
    expect(can(key(["admin"]), "datasets:write")).toBe(true);
    expect(can(key(["admin"]), "secrets:write")).toBe(true);
    expect(can(key(["admin"]), "keys:write")).toBe(true);
    // 교집합: scope 가 admin 이어도 role 이 viewer 면 viewer 권한을 넘지 못한다
    const viewerKey: Principal = {
      subject: "key:acme",
      workspace: "acme",
      roles: ["viewer"],
      via: "api-key",
      scopes: ["admin"],
    };
    expect(can(viewerKey, "datasets:read")).toBe(true);
    expect(can(viewerKey, "datasets:write")).toBe(false);
    // scope 없는(레거시/full) 키는 무제한(role 그대로)
    const legacy: Principal = { subject: "key:acme", workspace: "acme", roles: ["admin"], via: "api-key" };
    expect(can(legacy, "secrets:write")).toBe(true);
  });
});

describe("apiKeyAuthenticator", () => {
  it("키 해시 → 워크스페이스(기본 admin 역할)", async () => {
    const store = new InMemoryTenantKeyStore();
    await store.add("acme", hashKey("ak_secret"));
    const auth = apiKeyAuthenticator({ keyStore: store });
    expect(await auth.authenticate("ak_secret")).toMatchObject({ workspace: "acme", roles: ["admin"], via: "api-key" });
    expect(await auth.authenticate("ak_wrong")).toBeUndefined();
    expect(await auth.authenticate("eyJ.a.b")).toBeUndefined(); // JWT 는 무시
  });

  it("scope 있는 키는 Principal.scopes 로 흐른다(없으면 무제한)", async () => {
    const store = new InMemoryTenantKeyStore();
    await store.add("acme", hashKey("ak_scoped"), { scopes: ["read"] });
    await store.add("acme", hashKey("ak_full"));
    const auth = apiKeyAuthenticator({ keyStore: store });
    expect((await auth.authenticate("ak_scoped"))?.scopes).toEqual(["read"]);
    expect((await auth.authenticate("ak_full"))?.scopes).toBeUndefined();
  });
});

describe("runnerAuthenticator (셀프호스티드 러너 페어링 토큰)", () => {
  it("rnr_ 토큰 → {owner, workspace, runnerId} + roles=['runner'], via='runner'", async () => {
    const store = new InMemoryRunnerStore();
    const paired = await store.pair({ owner: "u-alice", workspace: "acme", label: "laptop" });
    const auth = runnerAuthenticator({ runnerStore: store });
    expect(await auth.authenticate(paired.token)).toMatchObject({
      subject: "u-alice",
      workspace: "acme",
      roles: ["runner"],
      via: "runner",
      runnerId: paired.meta.id,
    });
    expect(await auth.authenticate("rnr_wrong")).toBeUndefined();
    expect(await auth.authenticate("ak_x")).toBeUndefined(); // 비-rnr 은 무시(다음 인증기로)
  });
});

describe("oidcAuthenticator (Keycloak JWT)", () => {
  const ISSUER = "https://kc.example/realms/assay";
  let keySet: ReturnType<typeof createLocalJWKSet>;
  let priv: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    priv = privateKey;
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    jwk.alg = "RS256";
    keySet = createLocalJWKSet({ keys: [jwk] });
  });

  const mint = (claims: Record<string, unknown>, issuer = ISSUER) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setSubject("user-1")
      .setExpirationTime("5m")
      .sign(priv);

  it("Keycloak 은 인증 전용 — realm_access.roles 는 무시한다(roles=[]; 인가는 멤버십 SSOT)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ workspace: "acme", realm_access: { roles: ["admin", "uma_authorization"] } });
    expect(await auth.authenticate(token)).toMatchObject({
      subject: "user-1",
      workspace: "acme",
      roles: [], // 토큰 역할은 인가에 쓰지 않는다 — realm 'admin' 도 무시
      via: "oidc",
    });
  });

  it("workspace 가 그룹(/workspaces/<ws>)에서 폴백된다 (역할은 토큰과 무관)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ groups: ["/workspaces/globex/eng"], realm_access: { roles: ["admin"] } });
    const principal = await auth.authenticate(token);
    expect(principal?.workspace).toBe("globex");
    expect(principal?.roles).toEqual([]); // Keycloak 역할 무시 — 멤버십이 SSOT
  });

  it("email 클레임을 캡처(멤버 목록 표시용); 없으면 preferred_username 폴백, 둘 다 없으면 미설정", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    expect((await auth.authenticate(await mint({ workspace: "acme", email: "alice@corp.com" })))?.email).toBe(
      "alice@corp.com",
    );
    expect((await auth.authenticate(await mint({ workspace: "acme", preferred_username: "alice" })))?.email).toBe(
      "alice",
    );
    expect((await auth.authenticate(await mint({ workspace: "acme" })))?.email).toBeUndefined();
  });

  it("issuer 불일치/위조 토큰은 거절(undefined)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const wrong = await mint({ workspace: "acme" }, "https://evil/realms/x");
    expect(await auth.authenticate(wrong)).toBeUndefined();
    expect(await auth.authenticate("ak_key")).toBeUndefined(); // 키는 무시
  });

  it("검증 실패 시 onError 로 사유(코드/기대 issuer/토큰 iss/claim 키)를 알린다 — 401 원인 진단용", async () => {
    const calls: Array<{ code: string; expectedIssuer: string; tokenIssuer?: string; claimKeys?: string[] }> = [];
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet, onError: (info) => calls.push(info) });
    // issuer 불일치 토큰: 거절되며, onError 에 기대 issuer 와 토큰의 실제 iss(검증 전 디코드)·claim 키가 담긴다.
    const wrong = await mint({ workspace: "acme", realm_access: { roles: ["member"] } }, "https://evil/realms/x");
    expect(await auth.authenticate(wrong)).toBeUndefined();
    expect(calls).toHaveLength(1);
    const info = calls[0];
    expect(info).toBeDefined();
    if (!info) return; // 타입 가드(non-null ! 금지)
    expect(info.expectedIssuer).toBe(ISSUER);
    expect(info.tokenIssuer).toBe("https://evil/realms/x");
    expect(info.claimKeys).toEqual(expect.arrayContaining(["workspace", "iss", "sub"]));
    expect(typeof info.code).toBe("string");
  });

  it("비-JWT(API 키 등)는 검증을 시도하지 않으므로 onError 를 호출하지 않는다", async () => {
    const calls: unknown[] = [];
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet, onError: () => calls.push(1) });
    expect(await auth.authenticate("ak_some_key")).toBeUndefined();
    expect(calls).toHaveLength(0); // "내 자격증명 아님"은 정상 — 잡음 로그 금지
  });

  it("workspace 클레임/그룹이 없어도 유효한 토큰은 인증한다(workspace=''; 멤버십이 SSOT)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ realm_access: { roles: ["member"] } }); // workspace 클레임 없음
    expect(await auth.authenticate(token)).toMatchObject({
      subject: "user-1",
      workspace: "", // 아직 워크스페이스 없음 → 온보딩(워크스페이스 생성) 대상(401 아님)
      roles: [], // Keycloak 역할 무시 — 생성 후 멤버십(생성자=admin)이 역할을 부여
      via: "oidc",
    });
  });
});

describe("compositeAuthenticator", () => {
  it("JWT 와 API 키를 모두 처리", async () => {
    const store = new InMemoryTenantKeyStore();
    await store.add("acme", hashKey("ak_k"));
    const composite = compositeAuthenticator([apiKeyAuthenticator({ keyStore: store })]);
    expect((await composite.authenticate("ak_k"))?.workspace).toBe("acme");
    expect(await composite.authenticate("nope")).toBeUndefined();
  });
});

describe("githubActionsAuthenticator (GitHub Actions OIDC 페더레이션)", () => {
  let keySet: ReturnType<typeof createLocalJWKSet>;
  let priv: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    priv = privateKey;
    const jwk = await exportJWK(publicKey);
    jwk.kid = "gha";
    jwk.alg = "RS256";
    keySet = createLocalJWKSet({ keys: [jwk] });
  });

  const mint = (claims: Record<string, unknown>, issuer = GITHUB_ACTIONS_ISSUER, audience = "assay") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "gha" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("repo:acme/app:ref:refs/heads/main")
      .setExpirationTime("5m")
      .sign(priv);

  // 신뢰: 워크스페이스 acme 의 repo link 가 acme/app 만 신뢰(대소문자 무시).
  const trustAcmeApp = async (claims: { repository: string }, hint: string) =>
    hint === "acme" && claims.repository.toLowerCase() === "acme/app"
      ? { workspace: "acme", roles: ["ci"] }
      : undefined;

  it("신뢰된 레포의 유효 토큰 + workspaceHint → Principal(via=github-actions, roles=[ci])", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "acme/app", ref: "refs/pull/7/merge", event_name: "pull_request" });
    expect(await auth.authenticate(token, { workspaceHint: "acme" })).toEqual({
      subject: "gha:acme/app",
      workspace: "acme",
      roles: ["ci"],
      via: "github-actions",
    });
  });

  it("workspaceHint 없음 → 미인증(fail-closed) — 어느 워크스페이스의 link 와 대조할지 없다", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "acme/app" });
    expect(await auth.authenticate(token)).toBeUndefined();
  });

  it("link 에 없는 레포 → 미인증(401 — 존재 누출 없음)", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "evil/other" });
    expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
  });

  it("audience 불일치(aud≠assay) → 미인증", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "acme/app" }, GITHUB_ACTIONS_ISSUER, "sts.amazonaws.com");
    expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
  });

  it("다른 issuer(Keycloak 등)의 JWT 는 검증 시도 없이 패스 — resolveTrust 미호출(composite 소음 방지)", async () => {
    const calls: unknown[] = [];
    const auth = githubActionsAuthenticator({
      keySet,
      resolveTrust: async (c, h) => {
        calls.push([c, h]);
        return undefined;
      },
    });
    const keycloak = await mint({ repository: "acme/app" }, "https://kc.example/realms/assay");
    expect(await auth.authenticate(keycloak, { workspaceHint: "acme" })).toBeUndefined();
    expect(await auth.authenticate("ak_key", { workspaceHint: "acme" })).toBeUndefined(); // 비-JWT 도 패스
    expect(calls).toHaveLength(0);
  });

  describe("GHES 페더레이션(enterprise) — 워크스페이스가 신뢰하는 GHE host 의 issuer 만 동적으로 검증", () => {
    const GHE_HOST = "https://ghe.acme.io";
    const GHE_ISSUER = githubEnterpriseIssuer(GHE_HOST); // https://ghe.acme.io/_services/token

    it("신뢰 host 의 GHES 토큰 → claims.host 가 실려 resolveTrust 로 전달되고 Principal 발급", async () => {
      const seen: GithubActionsClaims[] = [];
      const auth = githubActionsAuthenticator({
        keySet,
        enterprise: { hostsFor: async (hint) => (hint === "acme" ? [GHE_HOST] : []), keySetFor: () => keySet },
        resolveTrust: async (claims) => {
          seen.push(claims);
          return claims.host === GHE_HOST && claims.repository === "acme/app"
            ? { workspace: "acme", roles: ["ci"] }
            : undefined;
        },
      });
      const token = await mint({ repository: "acme/app" }, GHE_ISSUER);
      expect(await auth.authenticate(token, { workspaceHint: "acme" })).toEqual({
        subject: "gha:acme/app",
        workspace: "acme",
        roles: ["ci"],
        via: "github-actions",
      });
      expect(seen[0]?.host).toBe(GHE_HOST);
    });

    it("hostsFor 에 없는 GHE issuer 는 검증 시도 없이 미인증(fail-closed) — resolveTrust 미호출", async () => {
      const calls: unknown[] = [];
      const auth = githubActionsAuthenticator({
        keySet,
        enterprise: { hostsFor: async () => ["https://other-ghe.example"], keySetFor: () => keySet },
        resolveTrust: async (c) => {
          calls.push(c);
          return { workspace: "acme", roles: ["ci"] };
        },
      });
      const token = await mint({ repository: "acme/app" }, GHE_ISSUER);
      expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it("enterprise 미설정이면 GHES 토큰은 종전대로 조용히 패스한다", async () => {
      const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
      const token = await mint({ repository: "acme/app" }, GHE_ISSUER);
      expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
    });

    it("github.com issuer 토큰의 claims.host 는 undefined — GHE link 와 구분된다", async () => {
      const seen: GithubActionsClaims[] = [];
      const auth = githubActionsAuthenticator({
        keySet,
        enterprise: { hostsFor: async () => [GHE_HOST], keySetFor: () => keySet },
        resolveTrust: async (claims) => {
          seen.push(claims);
          return { workspace: "acme", roles: ["ci"] };
        },
      });
      const token = await mint({ repository: "acme/app" });
      await auth.authenticate(token, { workspaceHint: "acme" });
      expect(seen[0]?.host).toBeUndefined();
    });
  });
});
