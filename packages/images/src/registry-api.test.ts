import { describe, expect, it } from "vitest";
import { fetchManagedRegistryApi } from "./registry-api.js";
import type { RegistryAccess } from "./token-issuer.js";

const ACCESS: RegistryAccess[] = [{ type: "repository", name: "ns/app", actions: ["pull"] }];

const CONFIG_BLOB = {
  created: "2026-07-30T10:00:00Z",
  os: "linux",
  architecture: "amd64",
  history: [
    { created: "2026-07-30T09:00:00Z", created_by: "/bin/sh -c #(nop) FROM node:22" },
    { created_by: "RUN pnpm install", comment: "buildkit.dockerfile.v0" },
    { created_by: '/bin/sh -c #(nop)  CMD ["node"]', empty_layer: true },
    { created: "2026-07-30T09:30:00Z" }, // a step with no created_by — dropped, not rendered as an empty row
  ],
  config: {
    Env: ["PATH=/usr/bin", "NODE_ENV=production"],
    Cmd: ["node", "server.js"],
    Entrypoint: ["docker-entrypoint.sh"],
    WorkingDir: "/app",
    User: "node",
    ExposedPorts: { "8080/tcp": {} },
    Labels: { "org.opencontainers.image.source": "https://github.com/acme/app" },
  },
};

const IMAGE_MANIFEST = {
  config: { digest: "sha256:cfg", size: 1234 },
  layers: [
    { digest: "sha256:l1", size: 100 },
    { digest: "sha256:l2", size: 250 },
  ],
};

// A fetch fake serving a tiny registry: route by URL suffix, record every path hit so a test can assert which
// round-trips an operation actually paid for.
function fakeRegistry(routes: Record<string, { body: unknown; headers?: Record<string, string> }>) {
  const hits: string[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
    const path = String(url).replace("https://reg.test/v2/", "");
    hits.push(path);
    const route = routes[path];
    if (!route) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  }) as typeof fetch;
  return { hits, api: fetchManagedRegistryApi("https://reg.test", async () => "tkn", fetchImpl) };
}

describe("ManagedRegistryApi.inspect — the config blob behind 'how was this image built'", () => {
  it("resolves a single image manifest through its config blob into history, runtime config, and size", async () => {
    const { api } = fakeRegistry({
      "ns/app/manifests/v1": {
        body: IMAGE_MANIFEST,
        headers: {
          "docker-content-digest": "sha256:m1",
          "content-type": "application/vnd.docker.distribution.manifest.v2+json",
        },
      },
      "ns/app/blobs/sha256:cfg": { body: CONFIG_BLOB },
    });
    const info = await api.inspect("ns/app", "v1", ACCESS);
    expect(info).toMatchObject({
      reference: "v1",
      digest: "sha256:m1",
      layerCount: 2,
      sizeBytes: 350,
      created: "2026-07-30T10:00:00Z",
      os: "linux",
      architecture: "amd64",
    });
    expect(info.history).toEqual([
      { createdBy: "/bin/sh -c #(nop) FROM node:22", created: "2026-07-30T09:00:00Z" },
      { createdBy: "RUN pnpm install", comment: "buildkit.dockerfile.v0" },
      { createdBy: '/bin/sh -c #(nop)  CMD ["node"]', emptyLayer: true },
    ]);
    expect(info.config).toEqual({
      entrypoint: ["docker-entrypoint.sh"],
      cmd: ["node", "server.js"],
      env: ["PATH=/usr/bin", "NODE_ENV=production"],
      workingDir: "/app",
      user: "node",
      exposedPorts: ["8080/tcp"],
      labels: { "org.opencontainers.image.source": "https://github.com/acme/app" },
    });
  });

  it("resolves an index through its runnable child but keeps reporting the INDEX digest (what a spec pins)", async () => {
    const { api } = fakeRegistry({
      "ns/app/manifests/v1": {
        body: {
          manifests: [
            { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } },
            { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
            { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
          ],
        },
        headers: { "docker-content-digest": "sha256:index" },
      },
      "ns/app/manifests/sha256:amd": {
        body: IMAGE_MANIFEST,
        headers: { "docker-content-digest": "sha256:amd" },
      },
      "ns/app/blobs/sha256:cfg": { body: CONFIG_BLOB },
    });
    const info = await api.inspect("ns/app", "v1", ACCESS);
    expect(info.digest).toBe("sha256:index");
    // The attestation's unknown/unknown is not a platform anyone can run — never listed.
    expect(info.platforms).toEqual(["linux/arm64", "linux/amd64"]);
    expect(info.sizeBytes).toBe(350);
    expect(info.history?.length).toBe(3);
  });

  it("degrades to the layer summary when the registry will not hand over the config blob", async () => {
    const { api } = fakeRegistry({
      "ns/app/manifests/v1": {
        body: IMAGE_MANIFEST,
        headers: { "docker-content-digest": "sha256:m1" },
      },
      // no blob route → 404 on the config read
    });
    const info = await api.inspect("ns/app", "v1", ACCESS);
    expect(info).toMatchObject({ reference: "v1", digest: "sha256:m1", layerCount: 2, sizeBytes: 350 });
    expect(info.history).toBeUndefined();
    expect(info.config).toBeUndefined();
  });

  it("keeps manifest() a single round-trip — digest resolution must not pay for the config blob", async () => {
    const { api, hits } = fakeRegistry({
      "ns/app/manifests/v1": {
        body: IMAGE_MANIFEST,
        headers: { "docker-content-digest": "sha256:m1" },
      },
    });
    const info = await api.manifest("ns/app", "v1", ACCESS);
    expect(info.digest).toBe("sha256:m1");
    expect(hits).toEqual(["ns/app/manifests/v1"]);
  });
});
