import { ImageRegistryService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
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

  it("400s when repository is missing", async () => {
    const res = await build().app.inject({
      method: "GET",
      url: "/workspace/image-registries/tags",
      headers: acme,
    });
    expect(res.statusCode).toBe(400);
  });
});
