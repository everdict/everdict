import { ImageRegistryService } from "@everdict/application-control";
import { BadRequestError, NotFoundError, UpstreamError } from "@everdict/contracts";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { describe, expect, it, vi } from "vitest";

// A service whose reader's inspectManifest throws — for the verifyImage failure-classification cases.
// ghcr.io is REGISTERED (anonymously) so the probe actually runs: an unregistered host is refused before
// any fetch since H12, which is its own test below.
async function throwingSvc(err: unknown) {
  const settings = new InMemoryWorkspaceSettingsStore();
  const reader = {
    checkConnection: vi.fn(async () => ({ reachable: true, detail: "ok" })),
    listTags: vi.fn(async () => [] as string[]),
    inspectManifest: vi.fn(async () => {
      throw err;
    }),
  };
  const service = new ImageRegistryService({ settings, secretsFor: async () => ({}), reader });
  await service.upsert("acme", { name: "ghcr", host: "ghcr.io" });
  return service;
}

function svc(secrets: Record<string, string> = {}) {
  const settings = new InMemoryWorkspaceSettingsStore();
  // A fake Docker Registry v2 reader — records its (coords, auth, repository) calls; returns canned tags / manifest.
  const reader = {
    checkConnection: vi.fn(async () => ({ reachable: true, detail: "ok" })),
    listTags: vi.fn(async () => ["v1", "v2"]),
    inspectManifest: vi.fn(async (_c: unknown, _a: unknown, _r: string, reference: string) => ({
      reference,
      digest: "sha256:abc",
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      layerCount: 3,
    })),
  };
  return { settings, reader, service: new ImageRegistryService({ settings, secretsFor: async () => secrets, reader }) };
}

describe("ImageRegistryService — multiple registries", () => {
  it("upsert by name registers/updates several registries and lists them (including imagePrefix)", async () => {
    const { service } = svc();
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io", namespace: "acme" });
    await service.upsert("acme", { name: "corp", host: "registry.acme.dev:5000" });
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io", namespace: "acme2" }); // replace
    const list = await service.list("acme");
    expect(list.map((r) => r.name).sort()).toEqual(["corp", "ghcr"]);
    expect(list.find((r) => r.name === "ghcr")?.imagePrefix).toBe("ghcr.io/acme2/");
    // classification coordinates span all registries.
    expect((await service.coordinates("acme")).map((c) => c.host).sort()).toEqual([
      "ghcr.io",
      "registry.acme.dev:5000",
    ]);
  });

  it("the legacy singular (imageRegistry) is inherited as name=default for reading and cleared into the plural list on the first write", async () => {
    const { settings, service } = svc();
    // Given: a singular config registered before the plural model.
    await settings.set("acme", { imageRegistry: { host: "ghcr.io", namespace: "acme", pullSecretName: "PULL" } });
    const before = await service.list("acme");
    expect(before).toHaveLength(1);
    expect(before[0]?.name).toBe("default");
    // When: adding a new registry — the legacy joins the list and the singular field is cleared.
    await service.upsert("acme", { name: "corp", host: "registry.acme.dev:5000" });
    const after = await service.list("acme");
    expect(after.map((r) => r.name).sort()).toEqual(["corp", "default"]);
    expect((await settings.get("acme"))?.imageRegistry).toBeNull();
  });

  it("pullAuths returns every registry with pull configured (silently excluding entries with a missing secret)", async () => {
    const { service } = svc({ PULL_A: "pa" });
    await service.upsert("acme", { name: "a", host: "reg-a.io", username: "bot", pullSecretName: "PULL_A" });
    await service.upsert("acme", { name: "b", host: "reg-b.io", pullSecretName: "PULL_B" }); // no secret → excluded
    await service.upsert("acme", { name: "c", host: "reg-c.io" }); // pull not configured → excluded
    expect(await service.pullAuths("acme")).toEqual([{ host: "reg-a.io", username: "bot", password: "pa" }]);
  });

  it("pushCredentials: name required when multiple (400), name mismatch 404, omission allowed when there's only one", async () => {
    const { service } = svc({ PUSH: "tok" });
    await service.upsert("acme", { name: "only", host: "reg.io", pushSecretName: "PUSH" });
    // only one — omission allowed.
    expect((await service.pushCredentials("acme")).name).toBe("only");
    await service.upsert("acme", { name: "two", host: "reg2.io", pushSecretName: "PUSH" });
    // multiple — omission is 400 (lists names), a given name mints, an unknown name is 404.
    await expect(service.pushCredentials("acme")).rejects.toBeInstanceOf(BadRequestError);
    expect((await service.pushCredentials("acme", "two")).host).toBe("reg2.io");
    await expect(service.pushCredentials("acme", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("probe prefers the push secret, resolves its value, and passes it to the reader as the credential", async () => {
    const { service, reader } = svc({ PUSH: "ptok", PULL: "ltok" });
    const r = await service.probe("acme", {
      host: "ghcr.io",
      namespace: "acme",
      username: "u",
      pullSecretName: "PULL",
      pushSecretName: "PUSH",
    });
    expect(r).toEqual({ reachable: true, detail: "ok", credential: "push" });
    expect(reader.checkConnection).toHaveBeenCalledWith(
      { host: "ghcr.io", namespace: "acme" },
      { host: "ghcr.io", username: "u", password: "ptok" },
    );
  });

  it("probe falls back to the pull secret when no push secret is configured", async () => {
    const { service, reader } = svc({ PULL: "ltok" });
    const r = await service.probe("acme", { host: "reg.io", pullSecretName: "PULL" });
    expect(r.credential).toBe("pull");
    expect(reader.checkConnection).toHaveBeenCalledWith({ host: "reg.io" }, { host: "reg.io", password: "ltok" });
  });

  it("probe runs anonymously (no auth) when neither secret is configured", async () => {
    const { service, reader } = svc();
    const r = await service.probe("acme", { host: "reg.io" });
    expect(r.credential).toBe("anonymous");
    expect(reader.checkConnection).toHaveBeenCalledWith({ host: "reg.io" }, undefined);
  });

  it("probe returns a friendly auth result (not a throw, no reader call) when the secret has no value yet", async () => {
    const { service, reader } = svc(); // SecretStore empty — PUSH not saved
    const r = await service.probe("acme", { host: "reg.io", pushSecretName: "PUSH" });
    expect(r).toMatchObject({ reachable: false, reason: "auth", credential: "push" });
    expect(r.detail).toContain("save the secret first");
    expect(reader.checkConnection).not.toHaveBeenCalled();
  });

  it("remove unregisters by name — the other registries remain", async () => {
    const { service } = svc();
    await service.upsert("acme", { name: "a", host: "reg-a.io" });
    await service.upsert("acme", { name: "b", host: "reg-b.io" });
    await service.remove("acme", "a");
    expect((await service.list("acme")).map((r) => r.name)).toEqual(["b"]);
  });
});

describe("ImageRegistryService — registry reads (agent list_image_tags / inspect_image)", () => {
  it("lists tags via the resolved registry with pull auth (username + pull secret value)", async () => {
    const { service, reader } = svc({ PULL: "pw" });
    await service.upsert("acme", {
      name: "ghcr",
      host: "ghcr.io",
      namespace: "acme",
      username: "u",
      pullSecretName: "PULL",
    });
    const out = await service.listTags("acme", "acme/api", "ghcr");
    expect(out).toEqual({ registry: "ghcr", repository: "acme/api", tags: ["v1", "v2"] });
    expect(reader.listTags).toHaveBeenCalledWith(
      { host: "ghcr.io", namespace: "acme" },
      { host: "ghcr.io", username: "u", password: "pw" },
      "acme/api",
    );
  });

  it("reads anonymously (no auth) when the registry has no pull secret — name omittable when single", async () => {
    const { service, reader } = svc();
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io" });
    await service.listTags("acme", "library/node");
    expect(reader.listTags).toHaveBeenCalledWith({ host: "ghcr.io" }, undefined, "library/node");
  });

  it("inspects a manifest and returns the digest + summary", async () => {
    const { service } = svc();
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io" });
    const out = await service.inspectImage("acme", "acme/api", "v1", "ghcr");
    expect(out).toMatchObject({
      registry: "ghcr",
      repository: "acme/api",
      reference: "v1",
      digest: "sha256:abc",
      layerCount: 3,
    });
  });

  it("requires a registry name when multiple are registered", async () => {
    const { service } = svc();
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io" });
    await service.upsert("acme", { name: "harbor", host: "harbor.acme.io" });
    await expect(service.listTags("acme", "acme/api")).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("ImageRegistryService — verifyImage (pull-usability check)", () => {
  it("pullable via the matching workspace registry's pull auth — parses host/repo/tag", async () => {
    const { service, reader } = svc({ PULL: "pw" });
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io", username: "u", pullSecretName: "PULL" });
    const r = await service.verifyImage("acme", "ghcr.io/acme/env:v1");
    expect(r).toEqual({ pullable: true, reason: "ok", digest: "sha256:abc" });
    expect(reader.inspectManifest).toHaveBeenCalledWith(
      { host: "ghcr.io" },
      { host: "ghcr.io", username: "u", password: "pw" },
      "acme/env",
      "v1",
    );
  });

  it("NEVER probes an unregistered host — the agent-chosen destination gets a classification, not a fetch (H12)", async () => {
    // Regression: the pre-fix service fetched anonymously from the control plane's network position when the
    // ref's host wasn't a registered registry — with the reader honoring http:// scheme hosts, the classified
    // return (ok|auth|not-found|unreachable) was a promptless reachability oracle for internal services.
    const { service, reader } = svc();
    for (const ref of [
      "public.example.com/org/img@sha256:deadbeef",
      "http://10.0.0.1:8500/org/img:probe", // the oracle shape: an internal service, plain HTTP
      "registry.internal.corp/org/img:v1",
    ]) {
      expect(await service.verifyImage("acme", ref)).toEqual({ pullable: false, reason: "unregistered-host" });
    }
    expect(reader.inspectManifest).not.toHaveBeenCalled(); // no fetch left the control plane
    // Registering the host (no credential needed — anonymous registration is supported) re-enables the probe:
    // the provenance model's own path, not a security bypass.
    await service.upsert("acme", { name: "pub", host: "public.example.com" });
    const r = await service.verifyImage("acme", "public.example.com/org/img@sha256:deadbeef");
    expect(r.pullable).toBe(true);
    expect(reader.inspectManifest).toHaveBeenCalledWith(
      { host: "public.example.com" },
      undefined,
      "org/img",
      "sha256:deadbeef",
    );
  });

  it("Docker Hub stays probeable as THE well-known default — shorthand and explicit aliases alike", async () => {
    const { service, reader } = svc();
    await service.verifyImage("acme", "docker.io/library/postgres:16");
    expect(reader.inspectManifest).toHaveBeenLastCalledWith(
      { host: "registry-1.docker.io" },
      undefined,
      "library/postgres",
      "16",
    );
  });

  it("normalizes a docker.io shorthand (postgres:16 → registry-1.docker.io/library/postgres)", async () => {
    const { service, reader } = svc();
    await service.verifyImage("acme", "postgres:16");
    expect(reader.inspectManifest).toHaveBeenCalledWith(
      { host: "registry-1.docker.io" },
      undefined,
      "library/postgres",
      "16",
    );
  });

  it("classifies a 401/403 as reason=auth (a publisher's private registry not registered here)", async () => {
    const service = await throwingSvc(new UpstreamError("UPSTREAM_ERROR", { status: 401, host: "ghcr.io" }, "denied"));
    expect(await service.verifyImage("acme", "ghcr.io/acme/env:v1")).toEqual({ pullable: false, reason: "auth" });
  });

  it("classifies a 404 as reason=not-found and a transport failure as reason=unreachable", async () => {
    const notFound = await throwingSvc(new UpstreamError("UPSTREAM_ERROR", { status: 404, host: "ghcr.io" }, "no tag"));
    expect(await notFound.verifyImage("acme", "ghcr.io/acme/env:v1")).toEqual({ pullable: false, reason: "not-found" });
    const transport = await throwingSvc(new UpstreamError("UPSTREAM_ERROR", { detail: "ENOTFOUND" }, "unreachable"));
    expect(await transport.verifyImage("acme", "ghcr.io/acme/env:v1")).toEqual({
      pullable: false,
      reason: "unreachable",
    });
  });
});
