import { ImageRegistryService } from "@everdict/application-control";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { imageRepoFor } from "@everdict/domain";
import { InMemoryImageStore } from "@everdict/images";
import { describe, expect, it, vi } from "vitest";
import { buildImagePullAuths } from "./images.js";

const ENDPOINT = "images.everdict.test";
const NS = imageRepoFor("acme");

const reader = {
  checkConnection: vi.fn(async () => ({ reachable: true, detail: "ok" })),
  listTags: vi.fn(async () => []),
  inspectManifest: vi.fn(async () => ({ reference: "v1" })),
};

async function byoRegistry() {
  const settings = new InMemoryWorkspaceSettingsStore();
  const imageRegistry = new ImageRegistryService({
    settings,
    secretsFor: async () => ({ "ghcr-pull": "byo-token" }),
    reader,
  });
  await imageRegistry.upsert("acme", { name: "ghcr", host: "ghcr.io", pullSecretName: "ghcr-pull" });
  return imageRegistry;
}

describe("buildImagePullAuths — one answer for 'what does this job need to pull its images'", () => {
  it("mints a managed grant for the job's managed images and keeps the BYO credentials beside it", async () => {
    const images = new InMemoryImageStore({ endpoint: ENDPOINT });
    const resolve = buildImagePullAuths({ images, imageRegistry: await byoRegistry() });
    const auths = await resolve("acme", [`${ENDPOINT}/${NS}/officeqa:v1`, "ghcr.io/acme/agent:v1"]);
    expect(auths.map((a) => a.host)).toEqual([ENDPOINT, "ghcr.io"]);
  });

  it("puts the managed grant FIRST — consumers take the first host match, and ours is the one we can vouch for", async () => {
    // A workspace that registered a BYO registry on the SAME host as the managed store (contrived, but the
    // ordering must not be left to luck).
    const settings = new InMemoryWorkspaceSettingsStore();
    const imageRegistry = new ImageRegistryService({
      settings,
      secretsFor: async () => ({ tok: "byo-token" }),
      reader,
    });
    await imageRegistry.upsert("acme", { name: "shadow", host: ENDPOINT, pullSecretName: "tok" });
    const resolve = buildImagePullAuths({ images: new InMemoryImageStore({ endpoint: ENDPOINT }), imageRegistry });
    const [first] = await resolve("acme", [`${ENDPOINT}/${NS}/officeqa:v1`]);
    expect(first?.password).not.toBe("byo-token");
  });

  it("mints nothing for images outside the workspace's namespace (no standing credential)", async () => {
    const resolve = buildImagePullAuths({
      images: new InMemoryImageStore({ endpoint: ENDPOINT }),
      imageRegistry: await byoRegistry(),
    });
    const auths = await resolve("acme", [`${ENDPOINT}/${imageRepoFor("rival")}/secret:v1`]);
    expect(auths.map((a) => a.host)).toEqual(["ghcr.io"]); // only the BYO half answered
  });

  it("still answers with the BYO half when the managed store is unreachable (placement stays warn-only)", async () => {
    const broken = {
      endpoint: ENDPOINT,
      namespaceFor: () => NS,
      listRepositories: async () => [],
      listTags: async () => [],
      inspect: async () => ({ reference: "v1" }),
      mintPushGrant: async () => {
        throw new Error("registry down");
      },
      mintPullGrant: async () => {
        throw new Error("registry down");
      },
      remove: async () => 0,
      usage: async () => ({ repositories: 0 }),
    };
    const resolve = buildImagePullAuths({ images: broken, imageRegistry: await byoRegistry() });
    const auths = await resolve("acme", [`${ENDPOINT}/${NS}/officeqa:v1`, "ghcr.io/acme/agent:v1"]);
    expect(auths.map((a) => a.host)).toEqual(["ghcr.io"]);
  });

  it("works as a BYO-only deployment when no managed store is configured", async () => {
    const resolve = buildImagePullAuths({ imageRegistry: await byoRegistry() });
    const auths = await resolve("acme", ["ghcr.io/acme/agent:v1"]);
    expect(auths.map((a) => a.host)).toEqual(["ghcr.io"]);
  });
});
