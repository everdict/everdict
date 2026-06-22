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

    // 멤버 조회는 viewer+, 멤버 관리(역할변경/제거/초대)는 admin 전용.
    expect(can(p(["viewer"]), "members:read")).toBe(true);
    expect(can(p(["viewer"]), "members:write")).toBe(false);
    expect(can(p(["member"]), "members:write")).toBe(false);
    expect(can(p(["admin"]), "members:write")).toBe(true);
  });
  it("authorize 는 권한 없으면 403", () => {
    expect(() => authorize(p(["viewer"]), "secrets:write")).toThrow(ForbiddenError); // 시크릿 값 = admin 전용
    expect(() => authorize(p(["member"]), "runtimes:write")).not.toThrow(); // 런타임 등록 = role 무관
    expect(() => authorize(p(["admin"]), "runtimes:write")).not.toThrow();
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
