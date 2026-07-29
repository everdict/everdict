import { BadRequestError, NotFoundError } from "@everdict/contracts";
import { imageRepoFor } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryImageStore } from "./in-memory-image-store.js";

const NS = imageRepoFor("acme");
const OTHER_NS = imageRepoFor("rival");

describe("InMemoryImageStore", () => {
  it("lists what was pushed as pinnable refs under the workspace namespace", async () => {
    const store = new InMemoryImageStore();
    store.push("acme", "officeqa", "v1", { sizeBytes: 100 });
    store.push("acme", "officeqa", "v2", { sizeBytes: 50 });
    const [repo] = await store.listRepositories("acme");
    expect(repo).toMatchObject({ name: "officeqa", repository: `${NS}/officeqa`, tags: ["v1", "v2"] });
    expect(repo?.image).toBe(`images.everdict.test/${NS}/officeqa`);
    await expect(store.usage("acme")).resolves.toEqual({ repositories: 1, bytes: 150 });
  });

  it("keeps one workspace's images invisible to another", async () => {
    const store = new InMemoryImageStore();
    store.push("acme", "officeqa", "v1");
    await expect(store.listRepositories("rival")).resolves.toEqual([]);
    await expect(store.listTags("rival", "officeqa")).resolves.toEqual([]);
    await expect(store.listTags("acme", `${OTHER_NS}/officeqa`)).rejects.toThrow(BadRequestError);
  });

  it("inspects by tag or digest and 404s on a reference it does not hold", async () => {
    const store = new InMemoryImageStore();
    const digest = store.push("acme", "officeqa", "v1");
    await expect(store.inspect("acme", "officeqa", "v1")).resolves.toMatchObject({ digest });
    await expect(store.inspect("acme", "officeqa", digest)).resolves.toMatchObject({ digest });
    await expect(store.inspect("acme", "officeqa", "nope")).rejects.toThrow(NotFoundError);
  });

  it("mirrors the managed grant semantics — one grant, own namespace only", async () => {
    const store = new InMemoryImageStore();
    const grants = await store.mintPullGrant("acme", [
      `images.everdict.test/${NS}/officeqa:v1`,
      `images.everdict.test/${NS}/browser:v1`,
      `images.everdict.test/${OTHER_NS}/secret:v1`,
      "postgres:16-alpine",
    ]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.repositories).toEqual([`${NS}/officeqa`, `${NS}/browser`]);
  });

  it("drops every tag pointing at a deleted manifest, as a registry does", async () => {
    const store = new InMemoryImageStore();
    store.push("acme", "officeqa", "v1", { digest: "sha256:a" });
    store.push("acme", "officeqa", "latest", { digest: "sha256:a" });
    store.push("acme", "officeqa", "v2", { digest: "sha256:b" });
    await expect(store.remove("acme", "officeqa", "v1")).resolves.toBe(1);
    await expect(store.listTags("acme", "officeqa")).resolves.toEqual(["v2"]);
    await expect(store.remove("acme", "officeqa")).resolves.toBe(1);
    await expect(store.listRepositories("acme")).resolves.toEqual([]);
  });
});
