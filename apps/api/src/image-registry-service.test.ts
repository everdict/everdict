import { BadRequestError, NotFoundError } from "@everdict/core";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { ImageRegistryService } from "./image-registry-service.js";

function svc(secrets: Record<string, string> = {}) {
  const settings = new InMemoryWorkspaceSettingsStore();
  return { settings, service: new ImageRegistryService({ settings, secretsFor: async () => secrets }) };
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

  it("remove unregisters by name — the other registries remain", async () => {
    const { service } = svc();
    await service.upsert("acme", { name: "a", host: "reg-a.io" });
    await service.upsert("acme", { name: "b", host: "reg-b.io" });
    await service.remove("acme", "a");
    expect((await service.list("acme")).map((r) => r.name)).toEqual(["b"]);
  });
});
