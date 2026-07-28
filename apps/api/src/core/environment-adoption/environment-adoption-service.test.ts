import { EnvironmentAdoptionService } from "@everdict/application-control";
import type { CapabilityRecord } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { InMemoryCapabilityStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { describe, expect, it, vi } from "vitest";

const AT = "2026-07-28T00:00:00.000Z";

function envRecord(over: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    id: "officeqa-env",
    tenant: "pub",
    version: "1.0.0",
    name: "OfficeQA env",
    description: "d",
    spec: {
      type: "environment",
      image: "ghcr.io/pub/officeqa:v1",
      contents: { benchmark: "officeqa", packages: [] },
      instructions: "how it's built",
    },
    visibility: "public",
    sharedWith: [],
    tags: [],
    createdBy: "owner",
    createdAt: "t",
    ...over,
  };
}

type Verify = { pullable: boolean; reason: "ok" | "auth" | "not-found" | "unreachable"; digest?: string };
function build(verify?: (ws: string, ref: string) => Promise<Verify>) {
  const settings = new InMemoryWorkspaceSettingsStore();
  const capabilityStore = new InMemoryCapabilityStore();
  const verifyImage = vi.fn(verify ?? (async () => ({ pullable: true, reason: "ok" as const, digest: "sha256:x" })));
  const service = new EnvironmentAdoptionService({
    settings,
    capabilityStore,
    verifyImage,
    registryCoordinates: async () => [],
    now: () => AT,
  });
  return { settings, capabilityStore, verifyImage, service };
}
const REF = { source: "pub", id: "officeqa-env", version: "1.0.0" };

describe("EnvironmentAdoptionService", () => {
  it("adopts a public (cross-tenant) environment — verifies pullability, merges the live capability into the view", async () => {
    const { capabilityStore, service, verifyImage } = build();
    await capabilityStore.register(envRecord());
    const view = await service.adopt("acme", "u1", REF);
    expect(verifyImage).toHaveBeenCalledWith("acme", "ghcr.io/pub/officeqa:v1");
    expect(view).toMatchObject({
      source: "pub",
      id: "officeqa-env",
      version: "1.0.0",
      available: true,
      name: "OfficeQA env",
      image: "ghcr.io/pub/officeqa:v1",
      benchmark: "officeqa",
      verify: { pullable: true, reason: "ok", digest: "sha256:x", at: AT },
    });
    expect(await service.list("acme", "u1")).toHaveLength(1);
  });

  it("rejects adopting a capability the workspace cannot consume (private to another tenant) — 404, no existence leak", async () => {
    const { capabilityStore, service } = build();
    await capabilityStore.register(envRecord({ visibility: "private", createdBy: "someone" }));
    await expect(service.adopt("acme", "u1", REF)).rejects.toBeInstanceOf(NotFoundError);
    expect(await service.list("acme", "u1")).toEqual([]);
  });

  it("records the adoption even when the image is NOT pullable (warn-not-block)", async () => {
    const { capabilityStore, service } = build(async () => ({ pullable: false, reason: "auth" }));
    await capabilityStore.register(envRecord());
    const view = await service.adopt("acme", "u1", REF);
    expect(view.verify).toMatchObject({ pullable: false, reason: "auth" });
    expect(await service.list("acme", "u1")).toHaveLength(1); // still in the inventory
  });

  it("surfaces a revoked/deleted source capability as available:false while retaining the verify snapshot", async () => {
    const { capabilityStore, service } = build();
    await capabilityStore.register(envRecord());
    await service.adopt("acme", "u1", REF);
    await capabilityStore.softDelete("pub", "officeqa-env", "1.0.0"); // publisher deletes the version
    const [item] = await service.list("acme", "u1");
    expect(item?.available).toBe(false);
    expect(item?.name).toBeUndefined(); // no longer resolvable
    expect(item?.verify?.pullable).toBe(true); // last snapshot kept
  });

  it("unadopts by (source,id)", async () => {
    const { capabilityStore, service } = build();
    await capabilityStore.register(envRecord());
    await service.adopt("acme", "u1", REF);
    await service.unadopt("acme", "pub", "officeqa-env");
    expect(await service.list("acme", "u1")).toEqual([]);
  });

  it("re-verify refreshes the stored snapshot", async () => {
    const verify = vi
      .fn<(ws: string, ref: string) => Promise<Verify>>()
      .mockResolvedValueOnce({ pullable: false, reason: "unreachable" })
      .mockResolvedValueOnce({ pullable: true, reason: "ok", digest: "sha256:y" });
    const { capabilityStore, service } = build(verify);
    await capabilityStore.register(envRecord());
    await service.adopt("acme", "u1", REF); // verify #1 → unreachable
    const re = await service.reverify("acme", "u1", "pub", "officeqa-env"); // verify #2 → pullable
    expect(re.verify).toMatchObject({ pullable: true, digest: "sha256:y", at: AT });
    expect((await service.list("acme", "u1"))[0]?.verify?.pullable).toBe(true); // persisted
  });
});
