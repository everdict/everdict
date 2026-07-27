import { UpstreamError } from "@everdict/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dockerRegistryReader } from "./registry-reader.js";

afterEach(() => vi.unstubAllGlobals());

describe("dockerRegistryReader — Docker Registry v2 reads", () => {
  it("does the 401 → Bearer-token → retry handshake, then lists tags", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const s = String(url);
        seen.push(s);
        if (s.endsWith("/v2/acme/api/tags/list")) {
          const authz = (init?.headers as Record<string, string> | undefined)?.authorization;
          if (authz === "Bearer TOKEN")
            return new Response(JSON.stringify({ name: "acme/api", tags: ["v1", "v2"] }), { status: 200 });
          return new Response("", {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="https://auth.ghcr.io/token",service="ghcr.io",scope="repository:acme/api:pull"',
            },
          });
        }
        if (s.startsWith("https://auth.ghcr.io/token")) {
          expect((init?.headers as Record<string, string>).authorization).toMatch(/^Basic /); // creds forwarded to the realm
          return new Response(JSON.stringify({ token: "TOKEN" }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );
    const tags = await dockerRegistryReader().listTags(
      { host: "ghcr.io" },
      { host: "ghcr.io", username: "u", password: "p" },
      "acme/api",
    );
    expect(tags).toEqual(["v1", "v2"]);
    expect(seen.some((c) => c.includes("auth.ghcr.io/token") && c.includes("scope=repository"))).toBe(true);
  });

  it("inspectManifest returns the digest, media type, and layer count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith("/v2/acme/api/manifests/v1"))
          return new Response(JSON.stringify({ schemaVersion: 2, layers: [{}, {}] }), {
            status: 200,
            headers: {
              "docker-content-digest": "sha256:deadbeef",
              "content-type": "application/vnd.oci.image.manifest.v1+json",
            },
          });
        return new Response("", { status: 404 });
      }),
    );
    const info = await dockerRegistryReader().inspectManifest({ host: "ghcr.io" }, undefined, "acme/api", "v1");
    expect(info).toEqual({
      reference: "v1",
      digest: "sha256:deadbeef",
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      layerCount: 2,
    });
  });

  it("surfaces a non-2xx as an UpstreamError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(dockerRegistryReader().listTags({ host: "ghcr.io" }, undefined, "acme/api")).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe("dockerRegistryReader — checkConnection (classified connection probe)", () => {
  it("reachable when GET /v2/ succeeds after the 401 → Bearer-token handshake with the given credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const s = String(url);
        if (s.endsWith("/v2/")) {
          const authz = (init?.headers as Record<string, string> | undefined)?.authorization;
          if (authz === "Bearer TOKEN") return new Response("{}", { status: 200 });
          return new Response("", {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="https://auth.ghcr.io/token",service="ghcr.io"' },
          });
        }
        if (s.startsWith("https://auth.ghcr.io/token"))
          return new Response(JSON.stringify({ token: "TOKEN" }), { status: 200 });
        return new Response("", { status: 404 });
      }),
    );
    const r = await dockerRegistryReader().checkConnection(
      { host: "ghcr.io" },
      { host: "ghcr.io", username: "u", password: "p" },
    );
    expect(r).toEqual({ reachable: true, detail: expect.stringContaining("accepted the credentials") });
  });

  it("reachable via anonymous access when GET /v2/ returns 200 with no credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const r = await dockerRegistryReader().checkConnection({ host: "reg.internal:5000" }, undefined);
    expect(r).toEqual({ reachable: true, detail: expect.stringContaining("anonymous") });
  });

  it("classifies a rejected Bearer challenge (bad token realm) as reason=auth, not a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const s = String(url);
        if (s.endsWith("/v2/"))
          return new Response("", {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="https://auth.ghcr.io/token",service="ghcr.io"' },
          });
        return new Response("denied", { status: 401 }); // the realm rejects the creds → no token
      }),
    );
    const r = await dockerRegistryReader().checkConnection(
      { host: "ghcr.io" },
      { host: "ghcr.io", username: "u", password: "bad" },
    );
    expect(r).toMatchObject({ reachable: false, reason: "auth" });
  });

  it("classifies a 401 with no credential (auth required) as reason=auth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="reg"' } })),
    );
    const r = await dockerRegistryReader().checkConnection({ host: "reg.io" }, undefined);
    expect(r).toMatchObject({ reachable: false, reason: "auth" });
  });

  it("classifies a transport failure (DNS/refused/timeout) as reason=unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND does-not-exist.example");
      }),
    );
    const r = await dockerRegistryReader().checkConnection({ host: "does-not-exist.example" }, undefined);
    expect(r).toMatchObject({ reachable: false, reason: "unreachable" });
  });

  it("classifies a non-auth non-2xx (e.g. 500) as reason=error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const r = await dockerRegistryReader().checkConnection({ host: "reg.io" }, undefined);
    expect(r).toMatchObject({ reachable: false, reason: "error" });
  });
});
