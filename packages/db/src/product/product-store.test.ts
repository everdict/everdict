import type { OutboxEvent } from "@everdict/application-control";
import type { ProductRecord, ProductServiceVersionRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryProductStore } from "./product-store.js";
import { InMemoryProductVersionStore, PgProductVersionStore } from "./product-version-store.js";
import { InMemoryReleaseStore } from "./release-store.js";

const NOW = "2026-08-08T00:00:00.000Z";

const product = (over: Partial<ProductRecord>): ProductRecord => ({
  id: "prod-1",
  tenant: "acme",
  name: "Support Copilot",
  services: [],
  series: [],
  autoEval: { enabled: true },
  history: [],
  createdBy: "dana",
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const version = (over: Partial<ProductServiceVersionRecord>): ProductServiceVersionRecord => ({
  id: "ver-1",
  tenant: "acme",
  productId: "prod-1",
  service: "api",
  version: "v1.4.0",
  kind: "release",
  prerelease: false,
  publishedAt: NOW,
  importedAt: NOW,
  ...over,
});

const fact = (id: string): OutboxEvent => ({
  id,
  tenant: "acme",
  kind: "product.service_version_imported",
  subject: { type: "product", id: "prod-1" },
  payload: {},
  message: "api v1.4.0",
  createdAt: NOW,
});

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

describe("InMemoryProductVersionStore — the ledger's insert-once invariant", () => {
  it("inserts a new version once and refuses the same natural key twice, emitting facts only for the insert", async () => {
    // Given an empty ledger
    const store = new InMemoryProductVersionStore();
    // When the same (service, version) arrives twice — a re-sync, or two racing sweeps
    const first = await store.create(version({}), [fact("ev-1")]);
    const second = await store.create(version({ id: "ver-2" }), [fact("ev-2")]);
    // Then only the first is an insert, and only its facts were published
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(store.emittedEvents().map((event) => event.id)).toEqual(["ev-1"]);
    expect(await store.list("acme", { productId: "prod-1" })).toHaveLength(1);
  });

  it("orders the timeline by the remote clock, newest first, and scopes by service", async () => {
    const store = new InMemoryProductVersionStore();
    await store.create(version({ id: "v-old", version: "v1.0.0", publishedAt: "2026-01-01T00:00:00.000Z" }));
    await store.create(version({ id: "v-new", version: "v2.0.0", publishedAt: "2026-08-01T00:00:00.000Z" }));
    await store.create(version({ id: "v-web", service: "web", version: "v1.0.0" }));
    const all = await store.list("acme", { productId: "prod-1" });
    expect(all.map((row) => row.id)).toEqual(["v-web", "v-new", "v-old"]);
    expect(await store.list("acme", { productId: "prod-1", service: "web" })).toHaveLength(1);
  });

  it("keeps workspaces apart — the same product id in another tenant is another product", async () => {
    const store = new InMemoryProductVersionStore();
    await store.create(version({}));
    expect(await store.create(version({ id: "ver-2", tenant: "globex" }))).toBe(true);
    expect(await store.list("globex", { productId: "prod-1" })).toHaveLength(1);
  });
});

describe("PgProductVersionStore — insert-once decided by SQL, not a racy read", () => {
  it("dedups with ON CONFLICT feeding the outbox CTE, so a lost race emits nothing", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ id: "ver-1" }] }));
    const inserted = await new PgProductVersionStore(client).create(version({}), [fact("ev-1")]);
    expect(inserted).toBe(true);
    expect(calls[0]?.text).toMatch(/ON CONFLICT \(tenant, product_id, service, version\) DO NOTHING/);
    expect(calls[0]?.text).toMatch(/WHERE EXISTS \(SELECT 1 FROM ins\)/);
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_platform_events/);
  });

  it("reports a conflicted insert as not-new", async () => {
    const { client } = fakeClient(() => ({ rows: [] }));
    expect(await new PgProductVersionStore(client).create(version({}))).toBe(false);
  });
});

describe("InMemoryProductStore / InMemoryReleaseStore", () => {
  it("round-trips a product and scopes reads by tenant", async () => {
    const store = new InMemoryProductStore();
    await store.create(product({}));
    expect(await store.get("acme", "prod-1")).toBeDefined();
    expect(await store.get("globex", "prod-1")).toBeUndefined();
  });

  it("update merges the patch but never lets it change identity, and carries the outbox", async () => {
    const store = new InMemoryProductStore();
    await store.create(product({}));
    const updated = await store.update("acme", "prod-1", { name: "Copilot", id: "hijack" } as Partial<ProductRecord>, [
      fact("ev-9"),
    ]);
    expect(updated?.id).toBe("prod-1");
    expect(updated?.name).toBe("Copilot");
    expect(store.emittedEvents().map((event) => event.id)).toEqual(["ev-9"]);
  });

  it("lists a product's releases newest-plan-first and filters by status", async () => {
    const releases = new InMemoryReleaseStore();
    const base = {
      tenant: "acme",
      productId: "prod-1",
      history: [],
      createdBy: "dana",
      updatedAt: NOW,
    };
    await releases.create({
      ...base,
      id: "rel-1",
      name: "2026.2",
      status: "released",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await releases.create({
      ...base,
      id: "rel-2",
      name: "2026.3",
      status: "planned",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const all = await releases.list("acme", { productId: "prod-1" });
    expect(all.map((row) => row.name)).toEqual(["2026.3", "2026.2"]);
    expect(await releases.list("acme", { productId: "prod-1", status: "planned" })).toHaveLength(1);
  });
});
