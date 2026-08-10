import type { ProductServiceVersionRecord } from "@everdict/contracts";
import { BadRequestError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Product } from "./product.js";

const NOW = "2026-08-08T00:00:00.000Z";
const LATER = "2026-08-09T00:00:00.000Z";

function newProduct() {
  return Product.newProduct({
    id: "prod-1",
    tenant: "acme",
    name: "Support Copilot",
    services: [{ name: "api", repository: "acme/copilot-api", source: "releases" }],
    series: [
      {
        key: "support-quality",
        label: "Support quality",
        dataset: { id: "support-cases" },
        harness: { id: "copilot" },
        judges: [{ id: "helpfulness" }],
      },
    ],
    createdBy: "dana",
    now: NOW,
  });
}

describe("Product — the released thing several services compose", () => {
  it("announces itself with its composition", () => {
    const record = newProduct();
    expect(record.autoEval).toEqual({ enabled: true });
    expect(Product.creationFacts(record)[0]).toMatchObject({
      kind: "product.created",
      subject: { type: "product", id: "prod-1" },
      payload: { name: "Support Copilot", services: 1, series: 1 },
    });
  });

  it("refuses two services with one name — the name is the timeline's key", () => {
    expect(() =>
      Product.newProduct({
        id: "prod-2",
        tenant: "acme",
        name: "Twin",
        services: [
          { name: "api", repository: "acme/a", source: "releases" },
          { name: "api", repository: "acme/b", source: "tags" },
        ],
        createdBy: "dana",
        now: NOW,
      }),
    ).toThrow(BadRequestError);
  });

  it("refuses two series sharing a key — the key is the trend's identity", () => {
    expect(() =>
      Product.newProduct({
        id: "prod-3",
        tenant: "acme",
        name: "Twin",
        series: [
          { key: "quality", label: "A", dataset: { id: "d" }, harness: { id: "h" }, judges: [] },
          { key: "quality", label: "B", dataset: { id: "d" }, harness: { id: "h" }, judges: [] },
        ],
        createdBy: "dana",
        now: NOW,
      }),
    ).toThrow(BadRequestError);
  });

  it("keeps a re-declared service's sync watermark, and drops it when the source coordinates change", () => {
    // Given a product whose service has already synced
    const synced = {
      ...newProduct(),
      services: [
        {
          name: "api",
          repository: "acme/copilot-api",
          source: "releases" as const,
          sync: { syncedAt: NOW },
        },
      ],
    };
    // When the editor re-sends the same service (editors never send sync state)
    const kept = Product.from(synced).update(
      {
        services: [
          { name: "api", repository: "acme/copilot-api", source: "releases" },
          { name: "web", repository: "acme/copilot-web", source: "releases" },
        ],
      },
      "dana",
      LATER,
    );
    // Then the watermark survives the edit
    expect(kept.patch.services?.find((service) => service.name === "api")?.sync).toEqual({ syncedAt: NOW });
    // But pointing the same name at a different repository starts a fresh track
    const repointed = Product.from(synced).update(
      { services: [{ name: "api", repository: "acme/other", source: "releases" }] },
      "dana",
      LATER,
    );
    expect(repointed.patch.services?.[0]?.sync).toBeUndefined();
  });

  it("treats content edits as audit-trail history, not lifecycle facts", () => {
    const transition = Product.from(newProduct()).update({ name: "Copilot" }, "dana", LATER);
    expect(transition.facts).toEqual([]);
    expect(transition.patch.history?.at(-1)).toMatchObject({ event: "updated", detail: { changed: ["name"] } });
  });

  it("keeps the sync watermark write silent — no history, no updatedAt bump", () => {
    const transition = Product.from(newProduct()).markServiceSynced("api", LATER);
    expect(transition.facts).toEqual([]);
    expect(transition.patch.history).toBeUndefined();
    expect(transition.patch.updatedAt).toBeUndefined();
    expect(transition.patch.services?.[0]?.sync).toEqual({ completeness: "complete", syncedAt: LATER });
  });

  it("mints the version-import fact with filterable top-level payload fields", () => {
    const version: ProductServiceVersionRecord = {
      id: "ver-1",
      tenant: "acme",
      productId: "prod-1",
      service: "api",
      version: "v1.4.0",
      kind: "release",
      prerelease: false,
      publishedAt: LATER,
      importedAt: LATER,
    };
    const fact = Product.from(newProduct()).versionImportFact(version, "dana");
    expect(fact).toMatchObject({
      kind: "product.service_version_imported",
      subject: { type: "product", id: "prod-1" },
      payload: {
        service: "api",
        version: "v1.4.0",
        repository: "acme/copilot-api",
        kind: "release",
        prerelease: false,
      },
    });
  });
});
