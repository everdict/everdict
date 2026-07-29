import { ImageRegistryService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { UpstreamError } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused");
  },
};
const acme = { "x-everdict-tenant": "acme" };

// A server whose image-registry service reads tags/manifests from a fake Docker Registry v2 reader.
function build() {
  const settings = new InMemoryWorkspaceSettingsStore();
  const reader = {
    checkConnection: vi.fn(async () => ({ reachable: true, detail: "Connected (anonymous access)." })),
    listTags: vi.fn(async () => ["v1", "v2"]),
    inspectManifest: vi.fn(async (_c: unknown, _a: unknown, _r: string, reference: string) => ({
      reference,
      digest: "sha256:abc",
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      layerCount: 3,
    })),
  };
  const imageRegistryService = new ImageRegistryService({ settings, secretsFor: async () => ({}), reader });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    imageRegistryService,
  });
  return { app, imageRegistryService };
}

describe("image registry read routes (tags / manifest)", () => {
  it("lists a repository's tags for the environment image picker", async () => {
    const { app, imageRegistryService } = build();
    await imageRegistryService.upsert("acme", { name: "ghcr", host: "ghcr.io", namespace: "acme" });
    const res = await app.inject({
      method: "GET",
      url: "/workspace/image-registries/tags?repository=acme/api",
      headers: acme,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registry: "ghcr", repository: "acme/api", tags: ["v1", "v2"] });
  });

  it("inspects a manifest to resolve the digest (recommended environment pin)", async () => {
    const { app, imageRegistryService } = build();
    await imageRegistryService.upsert("acme", { name: "ghcr", host: "ghcr.io", namespace: "acme" });
    const res = await app.inject({
      method: "GET",
      url: "/workspace/image-registries/manifest?repository=acme/api&reference=v2",
      headers: acme,
    });
    expect(res.json()).toMatchObject({ reference: "v2", digest: "sha256:abc" });
  });

  it("verifies that the workspace can pull a full ref and hands back the digest to pin", async () => {
    const { app, imageRegistryService } = build();
    await imageRegistryService.upsert("acme", { name: "ghcr", host: "ghcr.io", namespace: "acme" });
    const res = await app.inject({
      method: "GET",
      url: `/workspace/image-registries/verify?image=${encodeURIComponent("ghcr.io/acme/env:v3")}`,
      headers: acme,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pullable: true, reason: "ok", digest: "sha256:abc" });
  });

  it("reports a rejected pull as a RESULT (200 + reason), not an error", async () => {
    const settings = new InMemoryWorkspaceSettingsStore();
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      imageRegistryService: new ImageRegistryService({
        settings,
        secretsFor: async () => ({}),
        reader: {
          checkConnection: vi.fn(async () => ({ reachable: true, detail: "" })),
          listTags: vi.fn(async () => []),
          inspectManifest: vi.fn(async () => {
            throw new UpstreamError("UPSTREAM_ERROR", { status: 401 }, "unauthorized");
          }),
        },
      }),
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspace/image-registries/verify?image=${encodeURIComponent("ghcr.io/other/env:v3")}`,
      headers: acme,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pullable: false, reason: "auth" });
  });

  it("400s when the image ref is missing", async () => {
    const res = await build().app.inject({
      method: "GET",
      url: "/workspace/image-registries/verify",
      headers: acme,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when repository is missing", async () => {
    const res = await build().app.inject({
      method: "GET",
      url: "/workspace/image-registries/tags",
      headers: acme,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("image registry probe route (connection test before registering)", () => {
  it("returns the classified connection outcome for a host (no side effects)", async () => {
    const res = await build().app.inject({
      method: "POST",
      url: "/workspace/image-registries/probe",
      headers: acme,
      payload: { host: "ghcr.io", namespace: "acme" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reachable: true, credential: "anonymous" });
  });

  it("400s when host is missing", async () => {
    const res = await build().app.inject({
      method: "POST",
      url: "/workspace/image-registries/probe",
      headers: acme,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
