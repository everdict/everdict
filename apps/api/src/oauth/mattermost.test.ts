import { BadRequestError, UpstreamError } from "@assay/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mattermostProvider } from "./mattermost.js";

const provider = mattermostProvider(() => new Date("2026-01-01T00:00:00Z"));
const cfg = { clientId: "cid", clientSecret: "csec", host: "https://mm.acme.io" };
const redirectUri = "http://api.test/connections/callback";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(handler: (url: string, init?: { body?: unknown }) => { status?: number; body: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
      const { status = 200, body } = handler(String(url), init);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}

describe("mattermostProvider", () => {
  it("host 없으면 BadRequestError", () => {
    expect(() =>
      provider.authorizeUrl({ config: { clientId: "c", clientSecret: "s" }, state: "x", redirectUri }),
    ).toThrow(BadRequestError);
  });

  it("authorizeUrl 은 response_type=code + client_id/redirect_uri/state", () => {
    const u = new URL(provider.authorizeUrl({ config: cfg, state: "st", redirectUri }));
    expect(u.origin + u.pathname).toBe("https://mm.acme.io/oauth/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("state")).toBe("st");
  });

  it("exchange → access+refresh+expiresAt(form-encoded 요청)", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("https://mm.acme.io/oauth/access_token");
      expect(String(init?.body)).toContain("grant_type=authorization_code"); // form-encoded
      return { body: { access_token: "mm_at", refresh_token: "mm_rt", expires_in: 3600 } };
    });
    expect(await provider.exchange({ config: cfg, code: "c", redirectUri })).toEqual({
      accessToken: "mm_at",
      refreshToken: "mm_rt",
      expiresAt: "2026-01-01T01:00:00.000Z", // now + 3600s
      scopes: [],
    });
  });

  it("whoami → username 을 label 로", async () => {
    mockFetch((url) => {
      expect(url).toBe("https://mm.acme.io/api/v4/users/me");
      return { body: { username: "alice", id: "u1" } };
    });
    expect(await provider.whoami({ config: cfg, accessToken: "mm_at" })).toEqual({ label: "alice" });
  });

  it("비-2xx → UpstreamError", async () => {
    mockFetch(() => ({ status: 401, body: { message: "invalid_token" } }));
    await expect(provider.whoami({ config: cfg, accessToken: "nope" })).rejects.toBeInstanceOf(UpstreamError);
  });
});
