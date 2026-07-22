import { UpstreamError } from "@everdict/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpOfflineTokenMinter } from "./offline-token-minter.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Stub the global fetch (oauthFetchJson calls it) with a fixed response; capture the requests for assertion.
function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => JSON.stringify(response.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const GRANT = {
  tokenUrl: "https://id.example.com/oauth/token",
  clientId: "client-1",
  clientSecret: "secret-1",
  refreshToken: "refresh-abc",
  scope: "offline_access",
};

describe("httpOfflineTokenMinter", () => {
  it("POSTs a form-encoded refresh_token grant and computes the access-token expiry from expires_in", async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { access_token: "at-1", expires_in: 3600 } });
    const minter = httpOfflineTokenMinter(() => 1_000_000);

    const res = await minter.mint(GRANT);
    expect(res.accessToken).toBe("at-1");
    expect(res.expiresAt).toBe(new Date(1_000_000 + 3_600_000).toISOString());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GRANT.tokenUrl);
    expect(calls[0]?.init.method).toBe("POST");
    const body = String(calls[0]?.init.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-abc");
    expect(body).toContain("client_id=client-1");
    expect(body).toContain("client_secret=secret-1");
    expect(body).toContain("scope=offline_access");
  });

  it("surfaces a rotated refresh token so the store can replace the stored one", async () => {
    stubFetch({ ok: true, status: 200, body: { access_token: "at-1", expires_in: 60, refresh_token: "rotated-rt" } });
    const res = await httpOfflineTokenMinter(() => 0).mint(GRANT);
    expect(res.refreshToken).toBe("rotated-rt");
  });

  it("falls back to a short TTL when the provider omits expires_in", async () => {
    stubFetch({ ok: true, status: 200, body: { access_token: "at-1" } });
    const res = await httpOfflineTokenMinter(() => 0).mint(GRANT);
    expect(res.expiresAt).toBe(new Date(300_000).toISOString()); // 300s default
    expect(res.refreshToken).toBeUndefined();
  });

  it("remaps a rejected grant (non-2xx) to UpstreamError", async () => {
    stubFetch({ ok: false, status: 400, body: { error: "invalid_grant" } });
    await expect(httpOfflineTokenMinter().mint(GRANT)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("remaps a 2xx response with no access_token to UpstreamError", async () => {
    stubFetch({ ok: true, status: 200, body: { token_type: "bearer" } });
    await expect(httpOfflineTokenMinter().mint(GRANT)).rejects.toBeInstanceOf(UpstreamError);
  });
});
