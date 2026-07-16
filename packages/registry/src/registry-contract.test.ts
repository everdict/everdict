import {
  ConflictError,
  type Dataset,
  DatasetSchema,
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
  type JudgeSpec,
  JudgeSpecSchema,
  type ModelSpec,
  ModelSpecSchema,
  NotFoundError,
  type RubricSpec,
  RubricSpecSchema,
  type RuntimeSpec,
  RuntimeSpecSchema,
} from "@everdict/contracts";
import { type BenchmarkAdapterSpec, BenchmarkAdapterSpecSchema } from "@everdict/datasets";
import { describe, expect, it } from "vitest";
import { InMemoryBenchmarkRegistry } from "./benchmark/benchmark-registry.js";
import { InMemoryDatasetRegistry } from "./dataset/dataset-registry.js";
import { InMemoryHarnessInstanceRegistry } from "./harness/harness-instance-registry.js";
import { InMemoryHarnessTemplateRegistry } from "./harness/harness-template-registry.js";
import { InMemoryJudgeRegistry } from "./judge/judge-registry.js";
import { InMemoryModelRegistry } from "./model/model-registry.js";
import { SHARED_TENANT } from "./registry.js";
import { InMemoryRubricRegistry } from "./rubric/rubric-registry.js";
import { InMemoryRuntimeRegistry } from "./runtime/runtime-registry.js";

// ── Golden contract tests (re-architecture P3) ──────────────────────────────────────────────
// One shared behavioral suite, run against EVERY in-memory versioned registry via a per-entity
// descriptor. Pins today's cross-entity behavior BEFORE the generic VersionedStore dedupe collapses
// the 12× hand-rolled impls into one. Each entity's descriptor declares only the capabilities it
// actually has today; the suite asserts the ABSENT ones are truly undefined, so the dedupe cannot
// silently ADD or REMOVE a capability from any entity. See .claude/rules/registry.md (the SSOT rules).
//
// This file deliberately does NOT re-test what a per-entity *.test.ts already pins (spec-shape
// variants, load*Dir, list-metadata derivations, Pg SQL). It fills the GAPS — key-order-independent
// identity, non-semver ordering, owner-first precedence, capability presence/absence — uniformly.

// A registry the contract can drive. Every impl exposes register/get/versions/list; the rest are
// optional capability probes. Async throughout (every registry interface is async).
interface RegistryContract<Spec extends { id: string; version: string }> {
  name: string;
  make(): {
    register(tenant: string, spec: Spec, createdBy?: string): Promise<void>;
    get(tenant: string, id: string, ref?: string): Promise<Spec>;
    versions(tenant: string, id: string): Promise<string[]>;
    // Optional capabilities — present only where the entity supports them (probed reflectively below).
    has?(tenant: string, id: string, version: string): Promise<boolean>;
    ownVersions?(tenant: string, id: string): Promise<string[]>;
    list?(tenant: string): Promise<Array<{ id: string; owner: string; versions: string[] }>>;
    softDelete?(tenant: string, id: string, version: string): Promise<void>;
    creatorOf?(tenant: string, id: string, version: string): Promise<string | undefined>;
    setVersionTags?(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
    versionTags?(tenant: string, id: string): Promise<Record<string, string[]>>;
  };
  // A minimal, valid spec for (id, version). Two calls with the same (id, version) MUST be identical content.
  sample(id: string, version: string): Spec;
  // Same content as sample() but with a mutated field — for immutability conflict checks.
  mutate(id: string, version: string): Spec;
  // Same content as sample() but with object keys in a different order — for key-order-independent identity.
  reorder(id: string, version: string): Spec;
  // Declared capabilities. The suite asserts each of these matches whether the method exists on make().
  caps: {
    has: boolean;
    ownVersions: boolean;
    list: boolean;
    softDelete: boolean;
    createdBy: boolean; // register accepts a createdBy that is OUTSIDE content identity
    creatorOf: boolean; // a creatorOf/creatorOfVersion method exists
    versionTags: boolean;
  };
}

// ── Per-entity descriptors ──────────────────────────────────────────────────────────────────

const benchmark: RegistryContract<BenchmarkAdapterSpec> = {
  name: "benchmark",
  make: () => new InMemoryBenchmarkRegistry(),
  sample: (id, version) =>
    BenchmarkAdapterSpecSchema.parse({
      id,
      version,
      category: "qa",
      source: { kind: "huggingface", dataset: "me/x", split: "test" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    }),
  mutate: (id, version) =>
    BenchmarkAdapterSpecSchema.parse({
      id,
      version,
      category: "qa",
      source: { kind: "huggingface", dataset: "me/CHANGED", split: "test" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    }),
  reorder: (id, version) =>
    BenchmarkAdapterSpecSchema.parse({
      mapping: { answerField: "a", taskField: "q", idField: "id" },
      source: { split: "test", dataset: "me/x", kind: "huggingface" },
      version,
      category: "qa",
      id,
    }),
  caps: {
    has: false,
    ownVersions: true,
    list: true,
    softDelete: false,
    createdBy: false,
    creatorOf: false,
    versionTags: false,
  },
};

const dataset: RegistryContract<Dataset> = {
  name: "dataset",
  make: () => new InMemoryDatasetRegistry(),
  sample: (id, version) =>
    DatasetSchema.parse({
      id,
      version,
      cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
    }),
  mutate: (id, version) =>
    DatasetSchema.parse({
      id,
      version,
      description: "changed",
      cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
    }),
  reorder: (id, version) =>
    DatasetSchema.parse({
      cases: [{ task: "t", graders: [{ id: "steps" }], env: { source: { files: {} }, kind: "repo" }, id: "c1" }],
      version,
      id,
    }),
  caps: {
    has: true,
    ownVersions: true,
    list: true,
    softDelete: true,
    createdBy: true,
    creatorOf: true,
    versionTags: true,
  },
};

const harnessTemplate: RegistryContract<HarnessTemplateSpec> = {
  name: "harness-template",
  make: () => new InMemoryHarnessTemplateRegistry(),
  sample: (id, version) => templateSpec(id, version, "http://otel:4318"),
  mutate: (id, version) => templateSpec(id, version, "http://otel:CHANGED"),
  reorder: (id, version) => reorderedTemplateSpec(id, version),
  caps: {
    has: true,
    ownVersions: true,
    list: true,
    softDelete: false,
    createdBy: true,
    creatorOf: false,
    versionTags: false,
  },
};

const judge: RegistryContract<JudgeSpec> = {
  name: "judge",
  make: () => new InMemoryJudgeRegistry(),
  sample: (id, version) =>
    JudgeSpecSchema.parse({ kind: "model", id, version, model: "claude-opus-4-8", rubric: "did it work?" }),
  mutate: (id, version) =>
    JudgeSpecSchema.parse({ kind: "model", id, version, model: "claude-opus-4-8", rubric: "changed" }),
  reorder: (id, version) =>
    JudgeSpecSchema.parse({ rubric: "did it work?", model: "claude-opus-4-8", version, id, kind: "model" }),
  caps: {
    has: true,
    ownVersions: true,
    list: true,
    softDelete: false,
    createdBy: true,
    creatorOf: false,
    versionTags: true,
  },
};

const model: RegistryContract<ModelSpec> = {
  name: "model",
  make: () => new InMemoryModelRegistry(),
  sample: (id, version) => ModelSpecSchema.parse({ id, version, provider: "anthropic", model: "claude-opus-4-8" }),
  mutate: (id, version) =>
    ModelSpecSchema.parse({ id, version, provider: "anthropic", model: "claude-opus-4-8", description: "changed" }),
  reorder: (id, version) => ModelSpecSchema.parse({ model: "claude-opus-4-8", provider: "anthropic", version, id }),
  caps: {
    has: true,
    ownVersions: true,
    list: true,
    softDelete: true,
    createdBy: true,
    creatorOf: true,
    versionTags: false,
  },
};

const rubric: RegistryContract<RubricSpec> = {
  name: "rubric",
  make: () => new InMemoryRubricRegistry(),
  sample: (id, version) => RubricSpecSchema.parse({ id, version, text: "did it work?" }),
  mutate: (id, version) => RubricSpecSchema.parse({ id, version, text: "changed" }),
  reorder: (id, version) => RubricSpecSchema.parse({ text: "did it work?", version, id }),
  caps: {
    has: true,
    ownVersions: true,
    list: true,
    softDelete: false,
    createdBy: true,
    creatorOf: false,
    versionTags: true,
  },
};

const runtime: RegistryContract<RuntimeSpec> = {
  name: "runtime",
  make: () => new InMemoryRuntimeRegistry(),
  sample: (id, version) => RuntimeSpecSchema.parse({ kind: "local", id, version }),
  mutate: (id, version) => RuntimeSpecSchema.parse({ kind: "local", id, version, description: "changed" }),
  reorder: (id, version) => RuntimeSpecSchema.parse({ version, kind: "local", id }),
  caps: {
    has: true,
    ownVersions: true,
    list: true,
    softDelete: false,
    createdBy: false,
    creatorOf: false,
    versionTags: true,
  },
};

// harness-instance is special: register needs a template to resolve pins, its content-identity key is
// the InstanceSpec (not the resolved HarnessSpec), and get() returns a RESOLVED HarnessSpec (a different
// version field is impossible, so the contract reads the instance version through versions()/getInstance).
// It supports softDelete/creatorOfVersion/versionTags but NOT ownVersions (instance versions like "pr-1"
// aren't conflict-checked against a template). We drive it through a small adapter that owns a template.
function harnessInstanceContract(): RegistryContract<HarnessInstanceSpec & { id: string; version: string }> {
  const instance = (id: string, version: string, image: string) => ({
    template: { id: "tmpl", version: "1" },
    id,
    version,
    pins: { planner: image, browser: "b:1" },
  });
  return {
    name: "harness-instance",
    make: () => {
      const templates = new InMemoryHarnessTemplateRegistry();
      const instances = new InMemoryHarnessInstanceRegistry(templates);
      // Seed the template every instance resolves against (shared so any tenant can register instances).
      void templates.register(SHARED_TENANT, templateSpec("tmpl", "1", "http://otel:4318"));
      // getInstance returns the raw InstanceSpec (with the instance version), which the contract compares.
      return {
        register: (tenant: string, spec: HarnessInstanceSpec, createdBy?: string) =>
          instances.register(tenant, spec, createdBy),
        get: (tenant: string, id: string, ref?: string) => instances.getInstance(tenant, id, ref),
        versions: (tenant: string, id: string) => instances.versions(tenant, id),
        has: (tenant: string, id: string, version: string) => instances.has(tenant, id, version),
        list: (tenant: string) => instances.list(tenant),
        softDelete: (tenant: string, id: string, version: string) => instances.softDelete(tenant, id, version),
        creatorOf: (tenant: string, id: string, version: string) => instances.creatorOfVersion(tenant, id, version),
        setVersionTags: (tenant: string, id: string, version: string, tags: string[]) =>
          instances.setVersionTags(tenant, id, version, tags),
        versionTags: (tenant: string, id: string) => instances.versionTags(tenant, id),
      };
    },
    sample: (id, version) => instance(id, version, "p:1"),
    mutate: (id, version) => instance(id, version, "p:CHANGED"),
    reorder: (id, version) => ({
      pins: { browser: "b:1", planner: "p:1" },
      version,
      id,
      template: { version: "1", id: "tmpl" },
    }),
    caps: {
      has: true,
      ownVersions: false,
      list: true,
      softDelete: true,
      createdBy: true,
      creatorOf: true,
      versionTags: true,
    },
  };
}

// A minimal 2-service topology template — the harness-template/instance content unit.
function templateSpec(id: string, version: string, otel: string): HarnessTemplateSpec {
  return {
    kind: "service",
    category: "topology",
    id,
    version,
    services: [
      { name: "planner", needs: [], perRun: [], replicas: 1, env: {} },
      { name: "browser", needs: [], perRun: [], replicas: 1, env: {} },
    ],
    dependencies: [],
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: otel },
  };
}
function reorderedTemplateSpec(id: string, version: string): HarnessTemplateSpec {
  // Same content as templateSpec(...,"http://otel:4318") with top-level keys permuted (content identity is key-order-independent).
  return {
    traceSource: { endpoint: "http://otel:4318", kind: "otel" },
    frontDoor: { submit: "POST /runs", service: "planner" },
    dependencies: [],
    services: [
      { env: {}, replicas: 1, perRun: [], needs: [], name: "planner" },
      { env: {}, replicas: 1, perRun: [], needs: [], name: "browser" },
    ],
    version,
    id,
    category: "topology",
    kind: "service",
  } as HarnessTemplateSpec;
}

// ── The shared suite ────────────────────────────────────────────────────────────────────────
// Kept generic (runContract<Spec>) rather than a `for` over a heterogeneous array: an `as const`
// tuple of differently-typed descriptors unifies sample()/mutate() params to `never`. One generic
// call per descriptor binds Spec locally, so each spec factory stays fully typed.

function runContract<Spec extends { id: string; version: string }>(c: RegistryContract<Spec>): void {
  describe(`versioned registry contract — ${c.name}`, () => {
    it("Given the same (id, version) with different content, When re-registering, Then it throws ConflictError (versions are immutable)", async () => {
      const r = c.make();
      await r.register("acme", c.sample("x", "1.0.0"));
      await expect(r.register("acme", c.mutate("x", "1.0.0"))).rejects.toBeInstanceOf(ConflictError);
    });

    it("Given a registered version, When re-registering identical content, Then it is an idempotent no-op (no throw, one version)", async () => {
      const r = c.make();
      await r.register("acme", c.sample("x", "1.0.0"));
      await r.register("acme", c.sample("x", "1.0.0"));
      expect(await r.versions("acme", "x")).toEqual(["1.0.0"]);
    });

    it("Given a spec re-registered with its object keys reordered, When comparing content, Then identity is key-order-independent (no ConflictError)", async () => {
      const r = c.make();
      await r.register("acme", c.sample("x", "1.0.0"));
      // jsonb doesn't preserve key order, so content identity must be key-order-independent (specsEqual, not JSON.stringify).
      await expect(r.register("acme", c.reorder("x", "1.0.0"))).resolves.toBeUndefined();
      expect(await r.versions("acme", "x")).toEqual(["1.0.0"]);
    });

    it("Given semver versions registered out of order, When resolving 'latest', Then it returns the highest semver (ascending sorted versions)", async () => {
      const r = c.make();
      await r.register("acme", c.sample("x", "2.0.0"));
      await r.register("acme", c.sample("x", "1.9.0"));
      await r.register("acme", c.sample("x", "1.10.0"));
      expect(await r.versions("acme", "x")).toEqual(["1.9.0", "1.10.0", "2.0.0"]); // 1.10.0 > 1.9.0 numerically
      expect((await r.get("acme", "x")).version).toBe("2.0.0");
      expect((await r.get("acme", "x", "latest")).version).toBe("2.0.0");
    });

    it("Given a mix of semver and non-semver versions, When ordering, Then non-semver compare equal (0) and keep registration (seq) order — a stable sort", async () => {
      // PIN of today's tolerant behavior: compareVersions returns 0 for non-semver, so the stable sort
      // leaves those entries in insertion order relative to everything they tie with. The generic dedupe
      // MUST preserve this exact tie-break (seq), not reorder or reject non-semver versions.
      const r = c.make();
      await r.register("acme", c.sample("x", "1.5.0"));
      await r.register("acme", c.sample("x", "1.0.0"));
      await r.register("acme", c.sample("x", "beta")); // non-semver, registered last
      expect(await r.versions("acme", "x")).toEqual(["1.0.0", "1.5.0", "beta"]);
      expect((await r.get("acme", "x")).version).toBe("beta"); // last by stable order = latest
    });

    it("Given two non-semver versions registered in an order that string-sort would REVERSE, When ordering, Then the tie-break is seq (registration order) — NOT lexical", async () => {
      // Distinguishes the seq tie-break from a lexical one: "zeta" registered before "alpha" must stay
      // [zeta, alpha] (seq), which lexical sort would flip to [alpha, zeta]. The dedupe must keep seq.
      const r = c.make();
      await r.register("acme", c.sample("y", "zeta"));
      await r.register("acme", c.sample("y", "alpha"));
      expect(await r.versions("acme", "y")).toEqual(["zeta", "alpha"]); // seq order, not ["alpha","zeta"]
      expect((await r.get("acme", "y")).version).toBe("alpha"); // last-registered = latest
    });

    it("Given an unknown ref, When resolving, Then it throws NotFoundError", async () => {
      const r = c.make();
      await r.register("acme", c.sample("x", "1.0.0"));
      await expect(r.get("acme", "x", "9.9.9")).rejects.toBeInstanceOf(NotFoundError);
      await expect(r.get("acme", "nope")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("Given a _shared entity and a tenant with none of its own, When reading, Then the tenant sees the _shared one via fallback", async () => {
      const r = c.make();
      await r.register(SHARED_TENANT, c.sample("bench", "1.0.0"));
      expect((await r.get("anyone", "bench")).version).toBe("1.0.0");
      expect(await r.versions("anyone", "bench")).toEqual(["1.0.0"]);
    });

    it("Given both a _shared and a tenant-owned entity of the same id, When reading, Then the tenant's own takes precedence (owner-first)", async () => {
      const r = c.make();
      await r.register(SHARED_TENANT, c.sample("d", "1.0.0"));
      await r.register("acme", c.sample("d", "2.0.0"));
      expect((await r.get("acme", "d")).version).toBe("2.0.0"); // owned
      expect((await r.get("beta", "d")).version).toBe("1.0.0"); // fallback for a tenant with no own copy
    });

    it("Given a tenant-owned entity, When another tenant reads it, Then it is invisible (tenant isolation)", async () => {
      const r = c.make();
      await r.register("acme", c.sample("priv", "1.0.0"));
      await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
      expect(await r.versions("beta", "priv")).toEqual([]);
    });

    // ── has() — presence pinned per entity ───────────────────────────────────────────────────
    it(`Given the entity ${c.caps.has ? "supports" : "does not support"} has(), Then the method is ${c.caps.has ? "present and version-scoped" : "absent"}`, async () => {
      const r = c.make();
      if (!c.caps.has) {
        expect(r.has).toBeUndefined();
        return;
      }
      const has = r.has;
      if (!has) throw new Error("descriptor declares has but the impl lacks it");
      await r.register("acme", c.sample("x", "1.0.0"));
      expect(await has.call(r, "acme", "x", "1.0.0")).toBe(true);
      expect(await has.call(r, "acme", "x", "9.9.9")).toBe(false);
      expect(await has.call(r, "beta", "x", "1.0.0")).toBe(false); // isolation
    });

    // ── ownVersions() — no _shared fallback ──────────────────────────────────────────────────
    it(`Given the entity ${c.caps.ownVersions ? "supports" : "does not support"} ownVersions(), Then it ${c.caps.ownVersions ? "excludes the _shared fallback" : "is absent"}`, async () => {
      const r = c.make();
      if (!c.caps.ownVersions) {
        expect(r.ownVersions).toBeUndefined();
        return;
      }
      const own = r.ownVersions;
      if (!own) throw new Error("descriptor declares ownVersions but the impl lacks it");
      await r.register(SHARED_TENANT, c.sample("bench", "1.0.0"));
      await r.register("acme", c.sample("bench", "2.0.0"));
      expect(await r.versions("acme", "bench")).toEqual(["2.0.0"]); // owned takes precedence
      expect(await own.call(r, "acme", "bench")).toEqual(["2.0.0"]); // registered directly
      expect(await own.call(r, "beta", "bench")).toEqual([]); // visible via fallback, but owns nothing → no conflict
    });

    // ── list() — owner-labeled, sorted by id ─────────────────────────────────────────────────
    it("Given owned + shared entities, When listing, Then both appear id-sorted with the correct owner label", async () => {
      const r = c.make();
      if (!c.caps.list) {
        expect(r.list).toBeUndefined();
        return;
      }
      const list = r.list;
      if (!list) throw new Error("descriptor declares list but the impl lacks it");
      await r.register(SHARED_TENANT, c.sample("bench", "1.0.0"));
      await r.register("acme", c.sample("mine", "1.0.0"));
      const entries = await list.call(r, "acme");
      expect(entries.map((e) => ({ id: e.id, owner: e.owner }))).toEqual([
        { id: "bench", owner: SHARED_TENANT },
        { id: "mine", owner: "acme" },
      ]);
      expect(entries.find((e) => e.id === "mine")?.versions).toEqual(["1.0.0"]);
    });

    // ── createdBy — outside content identity ─────────────────────────────────────────────────
    it(`Given the entity ${c.caps.createdBy ? "stamps" : "does not stamp"} createdBy, Then re-registering identical content with a DIFFERENT createdBy is still idempotent (createdBy is outside content identity)`, async () => {
      const r = c.make();
      // register accepts (tenant, spec, createdBy?) uniformly; for entities without the concept the arg is ignored.
      await r.register("acme", c.sample("x", "1.0.0"), "alice");
      await expect(r.register("acme", c.sample("x", "1.0.0"), "bob")).resolves.toBeUndefined(); // no conflict
      expect(await r.versions("acme", "x")).toEqual(["1.0.0"]);
    });

    // ── creatorOf — tenant-owned live versions only ──────────────────────────────────────────
    it(`Given the entity ${c.caps.creatorOf ? "supports" : "does not support"} creatorOf, Then it ${c.caps.creatorOf ? "returns the registrant and rejects _shared with NotFound" : "is absent"}`, async () => {
      const r = c.make();
      if (!c.caps.creatorOf) {
        expect(r.creatorOf).toBeUndefined();
        return;
      }
      const creatorOf = r.creatorOf;
      if (!creatorOf) throw new Error("descriptor declares creatorOf but the impl lacks it");
      await r.register("acme", c.sample("mine", "1.0.0"), "alice");
      expect(await creatorOf.call(r, "acme", "mine", "1.0.0")).toBe("alice");
      await r.register(SHARED_TENANT, c.sample("bench", "1.0.0"), "sys");
      // No _shared fallback for creatorOf — a tenant can't claim a first-party version.
      await expect(creatorOf.call(r, "acme", "bench", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
      await expect(creatorOf.call(r, "acme", "mine", "9.9.9")).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── softDelete — tombstone semantics ─────────────────────────────────────────────────────
    it(`Given the entity ${c.caps.softDelete ? "supports" : "does not support"} softDelete, Then ${c.caps.softDelete ? "reads exclude the tombstone and re-registering identical content revives it" : "the method is absent"}`, async () => {
      const r = c.make();
      if (!c.caps.softDelete) {
        expect(r.softDelete).toBeUndefined();
        return;
      }
      const softDelete = r.softDelete;
      if (!softDelete) throw new Error("descriptor declares softDelete but the impl lacks it");
      await r.register("acme", c.sample("d", "1.0.0"));
      await r.register("acme", c.sample("d", "1.1.0"));
      await softDelete.call(r, "acme", "d", "1.0.0");
      expect(await r.versions("acme", "d")).toEqual(["1.1.0"]); // tombstone excluded from reads
      if (r.has) expect(await r.has("acme", "d", "1.0.0")).toBe(false);
      await softDelete.call(r, "acme", "d", "1.1.0"); // every version tombstoned → the id disappears
      await expect(r.get("acme", "d")).rejects.toBeInstanceOf(NotFoundError);
      await r.register("acme", c.sample("d", "1.0.0")); // identical content re-registers → revive
      expect((await r.get("acme", "d")).version).toBe("1.0.0");
    });

    it(`Given softDelete is ${c.caps.softDelete ? "supported" : "unsupported"}, When deleting a _shared or already-deleted version, Then it throws NotFoundError (tenant-owned live only)`, async () => {
      const r = c.make();
      if (!c.caps.softDelete) return; // covered by the absence assertion above
      const softDelete = r.softDelete;
      if (!softDelete) throw new Error("descriptor declares softDelete but the impl lacks it");
      await r.register(SHARED_TENANT, c.sample("bench", "1.0.0"));
      await expect(softDelete.call(r, "acme", "bench", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // can't delete _shared
      await r.register("acme", c.sample("mine", "1.0.0"));
      await softDelete.call(r, "acme", "mine", "1.0.0");
      await expect(softDelete.call(r, "acme", "mine", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // already deleted
    });

    // ── versionTags — mutable metadata, replace semantics, immutability-independent ───────────
    it(`Given the entity ${c.caps.versionTags ? "supports" : "does not support"} versionTags, Then ${c.caps.versionTags ? "replace semantics apply, empty clears, and tagging never affects content immutability" : "the methods are absent"}`, async () => {
      const r = c.make();
      if (!c.caps.versionTags) {
        expect(r.setVersionTags).toBeUndefined();
        expect(r.versionTags).toBeUndefined();
        return;
      }
      const setVersionTags = r.setVersionTags;
      const versionTags = r.versionTags;
      if (!setVersionTags || !versionTags) throw new Error("descriptor declares versionTags but the impl lacks it");
      await r.register("acme", c.sample("x", "1.0.0"));
      await r.register("acme", c.sample("x", "1.1.0"));
      await setVersionTags.call(r, "acme", "x", "1.0.0", ["baseline", "gpt-5"]);
      expect(await versionTags.call(r, "acme", "x")).toEqual({ "1.0.0": ["baseline", "gpt-5"] });
      // Replace semantics (full PUT), not append.
      await setVersionTags.call(r, "acme", "x", "1.0.0", ["only"]);
      expect(await versionTags.call(r, "acme", "x")).toEqual({ "1.0.0": ["only"] });
      // Tagging is outside content identity — re-registering identical content stays idempotent.
      await expect(r.register("acme", c.sample("x", "1.0.0"))).resolves.toBeUndefined();
      expect(await versionTags.call(r, "acme", "x")).toEqual({ "1.0.0": ["only"] }); // tags survive re-register
      // Empty array clears the tag entry entirely.
      await setVersionTags.call(r, "acme", "x", "1.0.0", []);
      expect(await versionTags.call(r, "acme", "x")).toEqual({});
    });

    it(`Given versionTags is ${c.caps.versionTags ? "supported" : "unsupported"}, When tagging a _shared or missing version, Then it throws NotFoundError (tenant-owned live only)`, async () => {
      const r = c.make();
      if (!c.caps.versionTags) return; // covered by the absence assertion above
      const setVersionTags = r.setVersionTags;
      if (!setVersionTags) throw new Error("descriptor declares versionTags but the impl lacks it");
      await r.register(SHARED_TENANT, c.sample("bench", "1.0.0"));
      await expect(setVersionTags.call(r, "acme", "bench", "1.0.0", ["x"])).rejects.toBeInstanceOf(NotFoundError);
      await r.register("acme", c.sample("mine", "1.0.0"));
      await expect(setVersionTags.call(r, "acme", "mine", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
    });

    it(`Given versionTags AND softDelete are ${c.caps.versionTags && c.caps.softDelete ? "both supported" : "not both supported"}, When a tagged version is tombstoned, Then its tags disappear from reads and re-tagging throws NotFound`, async () => {
      const r = c.make();
      if (!(c.caps.versionTags && c.caps.softDelete)) return; // only the entities with both
      const setVersionTags = r.setVersionTags;
      const versionTags = r.versionTags;
      const softDelete = r.softDelete;
      if (!setVersionTags || !versionTags || !softDelete) throw new Error("descriptor caps mismatch");
      await r.register("acme", c.sample("d", "1.0.0"));
      await setVersionTags.call(r, "acme", "d", "1.0.0", ["baseline"]);
      await softDelete.call(r, "acme", "d", "1.0.0");
      expect(await versionTags.call(r, "acme", "d")).toEqual({}); // tombstone excluded from tag reads
      await expect(setVersionTags.call(r, "acme", "d", "1.0.0", ["y"])).rejects.toBeInstanceOf(NotFoundError);
    });
  });
}

runContract(benchmark);
runContract(dataset);
runContract(harnessTemplate);
runContract(judge);
runContract(model);
runContract(rubric);
runContract(runtime);
runContract(harnessInstanceContract());
