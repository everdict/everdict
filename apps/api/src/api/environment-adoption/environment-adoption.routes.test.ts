import { EnvironmentAdoptionService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CapabilityRecord } from "@everdict/contracts";
import { InMemoryCapabilityStore, InMemoryRunStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused");
  },
};
const acme = { "x-everdict-tenant": "acme" };

const envRecord = (over: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
  id: "officeqa-env",
  tenant: "pub",
  version: "1.0.0",
  name: "OfficeQA env",
  description: "d",
  spec: {
    type: "environment",
    image: "ghcr.io/pub/officeqa:v1",
    contents: { benchmark: "officeqa", packages: [] },
    instructions: "how",
  },
  visibility: "public",
  sharedWith: [],
  tags: [],
  createdBy: "owner",
  createdAt: "t",
  ...over,
});

async function build(pullable = true, record: CapabilityRecord | undefined = envRecord()) {
  const capabilityStore = new InMemoryCapabilityStore();
  if (record) await capabilityStore.register(record);
  const environmentAdoptionService = new EnvironmentAdoptionService({
    settings: new InMemoryWorkspaceSettingsStore(),
    capabilityStore,
    verifyImage: vi.fn(async () => ({
      pullable,
      reason: pullable ? ("ok" as const) : ("auth" as const),
      digest: "sha256:x",
    })),
    registryCoordinates: async () => [],
    now: () => "2026-07-28T00:00:00.000Z",
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    environmentAdoptionService,
  });
  return { app };
}

const REF = { source: "pub", id: "officeqa-env", version: "1.0.0" };

describe("environment adoption routes", () => {
  it("adopts an environment (PUT) and returns the merged view with verify status", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/workspace/adopted-environments",
      headers: acme,
      payload: REF,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "officeqa-env",
      available: true,
      image: "ghcr.io/pub/officeqa:v1",
      verify: { pullable: true },
    });
  });

  it("lists the workspace inventory (GET) after adopting", async () => {
    const { app } = await build();
    await app.inject({ method: "PUT", url: "/workspace/adopted-environments", headers: acme, payload: REF });
    const res = await app.inject({ method: "GET", url: "/workspace/adopted-environments", headers: acme });
    expect(res.statusCode).toBe(200);
    expect(res.json().environments).toHaveLength(1);
  });

  it("records the adoption even when the image is not pullable (warn-not-block)", async () => {
    const { app } = await build(false);
    const res = await app.inject({
      method: "PUT",
      url: "/workspace/adopted-environments",
      headers: acme,
      payload: REF,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verify).toMatchObject({ pullable: false, reason: "auth" });
  });

  it("re-verifies (POST /verify) and unadopts (DELETE)", async () => {
    const { app } = await build();
    await app.inject({ method: "PUT", url: "/workspace/adopted-environments", headers: acme, payload: REF });
    const verify = await app.inject({
      method: "POST",
      url: "/workspace/adopted-environments/verify",
      headers: acme,
      payload: { source: "pub", id: "officeqa-env" },
    });
    expect(verify.statusCode).toBe(200);
    const del = await app.inject({
      method: "DELETE",
      url: "/workspace/adopted-environments/pub/officeqa-env",
      headers: acme,
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: "/workspace/adopted-environments", headers: acme });
    expect(list.json().environments).toEqual([]);
  });

  it("404s adopting a capability the workspace cannot consume (private to another tenant)", async () => {
    const { app } = await build(true, envRecord({ visibility: "private", createdBy: "someone" }));
    const res = await app.inject({
      method: "PUT",
      url: "/workspace/adopted-environments",
      headers: acme,
      payload: REF,
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s an adopt with a missing field", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/workspace/adopted-environments",
      headers: acme,
      payload: { source: "pub" },
    });
    expect(res.statusCode).toBe(400);
  });
});
