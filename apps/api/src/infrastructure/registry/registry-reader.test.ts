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
