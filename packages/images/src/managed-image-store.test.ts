import { generateKeyPairSync } from "node:crypto";
import { BadRequestError } from "@everdict/contracts";
import { imageRepoFor } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ManagedImageStore, grantAsRegistryAuth } from "./managed-image-store.js";
import type { ManagedRegistryApi } from "./registry-api.js";
import { type RegistryAccess, RegistryTokenIssuer } from "./token-issuer.js";

const ENDPOINT = "images.everdict.test";
const NS = imageRepoFor("acme");
const OTHER_NS = imageRepoFor("rival");

function issuer() {
  return new RegistryTokenIssuer({
    privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
    issuer: "https://cp.everdict.test",
    service: "everdict-registry",
  });
}

// A registry that records the access every call was authorized with — the assertion that matters is not only
// "the right path" but "with a token scoped to that path and nothing else".
function fakeApi(seed: Record<string, Record<string, string>> = {}) {
  const repos = new Map(Object.entries(seed).map(([r, tags]) => [r, new Map(Object.entries(tags))]));
  const calls: Array<{ op: string; repository: string; access: RegistryAccess[] }> = [];
  const deleted: string[] = [];
  const api: ManagedRegistryApi = {
    async catalog(prefix, access) {
      calls.push({ op: "catalog", repository: prefix, access });
      return [...repos.keys()].filter((r) => r === prefix || r.startsWith(`${prefix}/`));
    },
    async tags(repository, access) {
      calls.push({ op: "tags", repository, access });
      return [...(repos.get(repository)?.keys() ?? [])];
    },
    async manifest(repository, reference, access) {
      calls.push({ op: "manifest", repository, access });
      const digest = repos.get(repository)?.get(reference);
      return { reference, ...(digest ? { digest } : {}) };
    },
    async deleteManifest(repository, digest, access) {
      calls.push({ op: "delete", repository, access });
      deleted.push(digest);
      return true;
    },
  };
  return { api, calls, deleted };
}

function store(api: ManagedRegistryApi) {
  return new ManagedImageStore({ endpoint: ENDPOINT, issuer: issuer(), api });
}

describe("ManagedImageStore — the namespace contains the caller", () => {
  it("resolves a bare name into the workspace's own namespace", async () => {
    const { api, calls } = fakeApi();
    await store(api).listTags("acme", "officeqa");
    expect(calls[0]?.repository).toBe(`${NS}/officeqa`);
  });

  it("accepts the fully-qualified path of its OWN repository (round-tripping what a listing returned)", async () => {
    const { api, calls } = fakeApi();
    await store(api).listTags("acme", `${NS}/officeqa`);
    expect(calls[0]?.repository).toBe(`${NS}/officeqa`);
  });

  it("refuses another workspace's path instead of silently rewriting it into ours", async () => {
    await expect(store(fakeApi().api).listTags("acme", `${OTHER_NS}/secret`)).rejects.toThrow(BadRequestError);
  });

  it("refuses a traversal or nested path — the escape a caller would actually try", async () => {
    const s = store(fakeApi().api);
    await expect(s.listTags("acme", "../rival/secret")).rejects.toThrow(BadRequestError);
    await expect(s.listTags("acme", "nested/path")).rejects.toThrow(BadRequestError);
    await expect(s.inspect("acme", "UPPER", "v1")).rejects.toThrow(BadRequestError);
  });

  it("lists only repositories under the workspace's namespace, as pinnable refs", async () => {
    const { api } = fakeApi({ [`${NS}/officeqa`]: { v1: "sha256:a" }, [`${OTHER_NS}/secret`]: { v1: "sha256:b" } });
    await expect(store(api).listRepositories("acme")).resolves.toEqual([
      { name: "officeqa", repository: `${NS}/officeqa`, image: `${ENDPOINT}/${NS}/officeqa` },
    ]);
  });

  it("scopes every registry call to the repository it touches", async () => {
    const { api, calls } = fakeApi({ [`${NS}/officeqa`]: { v1: "sha256:a" } });
    await store(api).inspect("acme", "officeqa", "v1");
    expect(calls[0]?.access).toEqual([{ type: "repository", name: `${NS}/officeqa`, actions: ["pull"] }]);
  });
});

describe("ManagedImageStore — grants", () => {
  it("mints a push grant that also carries pull (docker reads existing layers while pushing)", async () => {
    const grant = await store(fakeApi().api).mintPushGrant("acme", "officeqa");
    expect(grant.repositories).toEqual([`${NS}/officeqa`]);
    expect(grant.actions).toEqual(["pull", "push"]);
    expect(grantAsRegistryAuth(grant)).toEqual({ host: ENDPOINT, username: "everdict", password: grant.token });
  });

  it("covers MANY repositories with ONE grant — what a per-host BYO credential structurally cannot do", async () => {
    const grants = await store(fakeApi().api).mintPullGrant("acme", [
      `${ENDPOINT}/${NS}/officeqa:v1`,
      `${ENDPOINT}/${NS}/browser:v2`,
    ]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.repositories).toEqual([`${NS}/officeqa`, `${NS}/browser`]);
  });

  it("does not authorize another workspace's image (cross-tenant reach is M6's kernel, not a default)", async () => {
    await expect(store(fakeApi().api).mintPullGrant("acme", [`${ENDPOINT}/${OTHER_NS}/secret:v1`])).resolves.toEqual(
      [],
    );
  });

  it("ignores refs that are not ours at all — public and BYO images are another adapter's business", async () => {
    await expect(
      store(fakeApi().api).mintPullGrant("acme", ["postgres:16-alpine", "ghcr.io/acme/agent:v1", "!!not a ref"]),
    ).resolves.toEqual([]);
  });

  it("deduplicates repositories so two tags of one image do not double the scope", async () => {
    const grants = await store(fakeApi().api).mintPullGrant("acme", [
      `${ENDPOINT}/${NS}/officeqa:v1`,
      `${ENDPOINT}/${NS}/officeqa@sha256:abc`,
    ]);
    expect(grants[0]?.repositories).toEqual([`${NS}/officeqa`]);
  });
});

describe("ManagedImageStore — removal", () => {
  it("resolves a tag to its digest, because a registry deletes manifests by digest only", async () => {
    const { api, deleted } = fakeApi({ [`${NS}/officeqa`]: { v1: "sha256:a", v2: "sha256:b" } });
    await expect(store(api).remove("acme", "officeqa", "v1")).resolves.toBe(1);
    expect(deleted).toEqual(["sha256:a"]);
  });

  it("removes a whole repository once per manifest, not once per tag pointing at it", async () => {
    const { api, deleted } = fakeApi({ [`${NS}/officeqa`]: { v1: "sha256:a", latest: "sha256:a", v2: "sha256:b" } });
    await expect(store(api).remove("acme", "officeqa")).resolves.toBe(2);
    expect(deleted).toEqual(["sha256:a", "sha256:b"]);
  });

  it("authorizes deletion as a write, and reports nothing removed for an empty repository", async () => {
    const { api, calls } = fakeApi({ [`${NS}/officeqa`]: {} });
    await expect(store(api).remove("acme", "officeqa")).resolves.toBe(0);
    expect(calls.every((c) => c.op !== "delete")).toBe(true);
  });
});

describe("ManagedImageStore — usage", () => {
  it("reports the repository count and omits a size it cannot know", async () => {
    const { api } = fakeApi({ [`${NS}/officeqa`]: { v1: "sha256:a" }, [`${NS}/browser`]: { v1: "sha256:b" } });
    await expect(store(api).usage("acme")).resolves.toEqual({ repositories: 2 });
  });
});
