import { ForbiddenError } from "@assay/core";
import { InMemoryTenantKeyStore, hashKey } from "@assay/db";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { apiKeyAuthenticator } from "./api-key.js";
import { authorize, can } from "./authz.js";
import { oidcAuthenticator } from "./oidc.js";
import { type Principal, compositeAuthenticator } from "./principal.js";

const p = (roles: string[]): Principal => ({ subject: "u", workspace: "acme", roles, via: "oidc" });

describe("authz", () => {
  it("역할별 권한 매트릭스", () => {
    expect(can(p(["viewer"]), "runs:read")).toBe(true);
    expect(can(p(["viewer"]), "runs:submit")).toBe(false);
    expect(can(p(["member"]), "runs:submit")).toBe(true);
    expect(can(p(["member"]), "harnesses:register")).toBe(false);
    expect(can(p(["admin"]), "harnesses:register")).toBe(true);
    // datasets: 읽기는 viewer+, 쓰기는 member+(harnesses:register 가 admin 인 것과 구분)
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
    // runtimes: 읽기는 viewer+, 쓰기는 admin(실행 인프라 = 실행/배치 결정)
    expect(can(p(["member"]), "runtimes:read")).toBe(true);
    expect(can(p(["member"]), "runtimes:write")).toBe(false);
    expect(can(p(["admin"]), "runtimes:write")).toBe(true);
  });
  it("authorize 는 권한 없으면 403", () => {
    expect(() => authorize(p(["member"]), "harnesses:register")).toThrow(ForbiddenError);
    expect(() => authorize(p(["admin"]), "harnesses:register")).not.toThrow();
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

  it("workspace claim + realm 역할을 추출한다", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ workspace: "acme", realm_access: { roles: ["member", "uma_authorization"] } });
    expect(await auth.authenticate(token)).toMatchObject({
      subject: "user-1",
      workspace: "acme",
      roles: ["member"], // assay 역할만
      via: "oidc",
    });
  });

  it("workspace 가 그룹(/workspaces/<ws>)에서 폴백된다", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ groups: ["/workspaces/globex/eng"], realm_access: { roles: [] } });
    const principal = await auth.authenticate(token);
    expect(principal?.workspace).toBe("globex");
    expect(principal?.roles).toEqual(["viewer"]); // 역할 없으면 viewer
  });

  it("issuer 불일치/위조 토큰은 거절(undefined)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const wrong = await mint({ workspace: "acme" }, "https://evil/realms/x");
    expect(await auth.authenticate(wrong)).toBeUndefined();
    expect(await auth.authenticate("ak_key")).toBeUndefined(); // 키는 무시
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
