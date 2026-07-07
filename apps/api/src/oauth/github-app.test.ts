import { generateKeyPairSync, verify } from "node:crypto";
import { UpstreamError } from "@everdict/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstallation, githubAppJwt, mintInstallationToken } from "./github-app.js";

// 테스트용 RSA 키페어(App 개인키 대역). PEM 으로 뽑아 서명/검증에 사용.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// fetch stub — (url, init) 를 캡처해 요청 검증까지 가능하게 한다.
function mockFetch(
  handler: (url: string) => { status?: number; body: unknown },
): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const { status = 200, body } = handler(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

describe("githubAppJwt", () => {
  it("RS256 헤더 + iss/iat/exp 클레임을 담고 개인키로 서명된다", () => {
    const jwt = githubAppJwt({ appId: "12345", privateKeyPem: privateKey, nowSec: 1_000_000 });
    const [h, p, sig] = jwt.split(".");
    if (h === undefined || p === undefined || sig === undefined) throw new Error("JWT 형식 불량(3-파트 아님)");
    expect(decodeSegment(h)).toEqual({ alg: "RS256", typ: "JWT" });
    // iat 는 시계오차 흡수로 60초 당김, exp 는 10분 이내.
    expect(decodeSegment(p)).toEqual({ iss: "12345", iat: 999_940, exp: 1_000_540 });
    // 공개키로 서명 검증(위조 아님).
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("mintInstallationToken (github.com)", () => {
  const base = { appId: "12345", privateKeyPem: privateKey, installationId: 42, nowSec: 1_000_000 };

  it("선택 repo + 권한으로 좁혀 installation access token 을 요청하고 파싱한다", async () => {
    const calls = mockFetch(() => ({ body: { token: "ghs_abc", expires_at: "2026-07-05T12:00:00Z" } }));
    const tok = await mintInstallationToken({
      ...base,
      repositories: ["api"],
      permissions: { contents: "read" },
    });
    expect(tok).toEqual({ token: "ghs_abc", expiresAt: "2026-07-05T12:00:00Z" });

    const call = calls[0];
    expect(call?.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(call?.init?.method).toBe("POST");
    // App JWT 를 Bearer 로 실어 인증.
    const auth = (call?.init?.headers as Record<string, string>).authorization;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    // 몸통에 선택 repo + 권한이 그대로 실린다(GitHub 이 이 범위로 토큰을 제한).
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      repositories: ["api"],
      permissions: { contents: "read" },
    });
  });

  it("외부 실패(비-2xx)는 UpstreamError 로 remap 된다", async () => {
    mockFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    await expect(mintInstallationToken({ ...base, repositories: ["api"] })).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("getInstallation", () => {
  it("App JWT 로 installation 을 조회해 account(org login)를 뽑는다", async () => {
    const calls = mockFetch(() => ({ body: { id: 42, account: { login: "acme-org" } } }));
    const info = await getInstallation({
      appId: "12345",
      privateKeyPem: privateKey,
      installationId: 42,
      nowSec: 1_000_000,
    });
    expect(info).toEqual({ account: "acme-org" });
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/42");
  });
});

describe("mintInstallationToken (GHE — host 분기)", () => {
  it("host 가 있으면 api 베이스가 GHE(/api/v3)로 바뀐다", async () => {
    const calls = mockFetch(() => ({ body: { token: "ghs_ent", expires_at: "2026-07-05T12:00:00Z" } }));
    await mintInstallationToken({
      host: "https://ghe.acme.io",
      appId: "9",
      privateKeyPem: privateKey,
      installationId: 7,
      repositories: ["svc"],
      nowSec: 1_000_000,
    });
    expect(calls[0]?.url).toBe("https://ghe.acme.io/api/v3/app/installations/7/access_tokens");
  });
});
