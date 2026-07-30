import { CapabilityService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryCapabilityStore, InMemoryRunStore } from "@everdict/db";
import { InMemoryHarnessInstanceRegistry, InMemoryHarnessTemplateRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in capability tests");
  },
};

// A single shared store lets cross-tenant (subset/public) reads work across requests within one test.
function build(withCaps: boolean, store = new InMemoryCapabilityStore()) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  return buildServer({
    service,
    ...(withCaps ? { capabilityService: new CapabilityService({ store }) } : {}),
  });
}

const acme = { "x-everdict-tenant": "acme" };
const beta = { "x-everdict-tenant": "beta" };
const delta = { "x-everdict-tenant": "delta" };
const skillSpec = { type: "skill", instructions: "1. do the thing" };
const ids = (r: { json: () => unknown }) => (r.json() as Array<{ id: string }>).map((c) => c.id);

describe("capability routes", () => {
  it("returns 404 when capabilities are not configured", async () => {
    const res = await build(false).inject({ method: "GET", url: "/capabilities", headers: acme });
    expect(res.statusCode).toBe(404);
  });

  it("authors (version-free upsert, reach inherited across edits), reads, and lists a capability", async () => {
    const app = build(true);
    const saved = await app.inject({
      method: "PUT",
      url: "/capabilities/triage",
      headers: acme,
      payload: { name: "triage", description: "when to triage", spec: skillSpec, visibility: "workspace" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ id: "triage", version: "1.0.0", created: true });

    // unchanged content → idempotent no-op
    const again = await app.inject({
      method: "PUT",
      url: "/capabilities/triage",
      headers: acme,
      payload: { name: "triage", description: "when to triage", spec: skillSpec },
    });
    expect(again.json()).toMatchObject({ version: "1.0.0", created: false });

    // content change → patch bump, reach inherited (not reset by an edit)
    const edited = await app.inject({
      method: "PUT",
      url: "/capabilities/triage",
      headers: acme,
      payload: { name: "triage", description: "changed", spec: skillSpec },
    });
    expect(edited.json()).toMatchObject({ version: "1.0.1", created: true });

    const got = await app.inject({ method: "GET", url: "/capabilities/triage", headers: acme });
    expect(got.json()).toMatchObject({ version: "1.0.1", visibility: "workspace" });
    expect(ids(await app.inject({ method: "GET", url: "/capabilities", headers: acme }))).toEqual(["triage"]);
  });

  it("shares to a subset of workspaces — visible to a target, invisible elsewhere", async () => {
    const app = build(true);
    await app.inject({
      method: "PUT",
      url: "/capabilities/t",
      headers: acme,
      payload: { name: "t", description: "d", spec: skillSpec, visibility: "private" },
    });
    const patched = await app.inject({
      method: "PATCH",
      url: "/capabilities/t/visibility",
      headers: acme,
      payload: { visibility: "subset", sharedWith: ["beta"] },
    });
    expect(patched.statusCode).toBe(200);
    expect(ids(await app.inject({ method: "GET", url: "/capabilities", headers: beta }))).toEqual(["t"]);
    expect(ids(await app.inject({ method: "GET", url: "/capabilities", headers: delta }))).toEqual([]);
  });

  it("publishes to the public catalog, browsable from any workspace", async () => {
    const app = build(true);
    await app.inject({
      method: "PUT",
      url: "/capabilities/tool",
      headers: acme,
      payload: { name: "tool", description: "d", spec: skillSpec, visibility: "private" },
    });
    await app.inject({
      method: "PATCH",
      url: "/capabilities/tool/visibility",
      headers: acme,
      payload: { visibility: "public", sharedWith: [] },
    });
    // in beta's own store list it does NOT appear (public from others lives in the public catalog), but /public does
    expect(ids(await app.inject({ method: "GET", url: "/capabilities", headers: beta }))).toEqual([]);
    expect(ids(await app.inject({ method: "GET", url: "/capabilities/public", headers: beta }))).toEqual(["tool"]);
  });

  it("validates a capability (dry-run) — predicts the version without writing, and flags a bad spec", async () => {
    const app = build(true);
    // brand-new id → would create 1.0.0, and validate must NOT register it
    const fresh = await app.inject({
      method: "POST",
      url: "/capabilities/validate",
      headers: acme,
      payload: { id: "triage", name: "triage", description: "d", spec: skillSpec },
    });
    expect(fresh.json()).toMatchObject({ ok: true, willCreate: true, version: "1.0.0", existingVersions: [] });
    expect(ids(await app.inject({ method: "GET", url: "/capabilities", headers: acme }))).toEqual([]);

    // after a real save, unchanged content validates as a no-op; changed content as the next version
    await app.inject({
      method: "PUT",
      url: "/capabilities/triage",
      headers: acme,
      payload: { name: "triage", description: "d", spec: skillSpec },
    });
    const noop = await app.inject({
      method: "POST",
      url: "/capabilities/validate",
      headers: acme,
      payload: { id: "triage", name: "triage", description: "d", spec: skillSpec },
    });
    expect(noop.json()).toMatchObject({ ok: true, willCreate: false, version: "1.0.0" });

    // a malformed spec → ok:false with errors (never a 400/throw)
    const bad = await app.inject({
      method: "POST",
      url: "/capabilities/validate",
      headers: acme,
      payload: { id: "x", name: "x", description: "d", spec: { type: "code", language: "ruby" } },
    });
    expect(bad.statusCode).toBe(200);
    expect((bad.json() as { ok: boolean }).ok).toBe(false);
  });

  it("soft-deletes a version (then reads 404)", async () => {
    const app = build(true);
    await app.inject({
      method: "PUT",
      url: "/capabilities/d",
      headers: acme,
      payload: { name: "d", description: "d", spec: skillSpec, visibility: "workspace" },
    });
    const del = await app.inject({ method: "DELETE", url: "/capabilities/d/versions/1.0.0", headers: acme });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/capabilities/d", headers: acme });
    expect(after.statusCode).toBe(404);
  });

  it("lists a capability's versions and round-trips a version's tags", async () => {
    const app = build(true);
    await app.inject({
      method: "PUT",
      url: "/capabilities/v",
      headers: acme,
      payload: { name: "v", description: "d1", spec: skillSpec, visibility: "workspace" },
    });
    await app.inject({
      method: "PUT",
      url: "/capabilities/v",
      headers: acme,
      payload: { name: "v", description: "d2", spec: skillSpec },
    });
    const versions = await app.inject({ method: "GET", url: "/capabilities/v/versions", headers: acme });
    expect(versions.json()).toEqual({ id: "v", source: "acme", versions: ["1.0.0", "1.0.1"], versionTags: {} });

    // tag 1.0.0 (trims + dedupes)
    const tagged = await app.inject({
      method: "PUT",
      url: "/capabilities/v/versions/1.0.0/tags",
      headers: acme,
      payload: { tags: [" baseline ", "baseline", "stable"] },
    });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json()).toEqual({ workspace: "acme", id: "v", version: "1.0.0", tags: ["baseline", "stable"] });
    const after = await app.inject({ method: "GET", url: "/capabilities/v/versions", headers: acme });
    expect((after.json() as { versionTags: unknown }).versionTags).toEqual({ "1.0.0": ["baseline", "stable"] });
  });

  it("diffs two versions and 400s without base/candidate", async () => {
    const app = build(true);
    await app.inject({
      method: "PUT",
      url: "/capabilities/v",
      headers: acme,
      payload: { name: "v", description: "first", spec: skillSpec, visibility: "workspace" },
    });
    await app.inject({
      method: "PUT",
      url: "/capabilities/v",
      headers: acme,
      payload: { name: "v", description: "second", spec: skillSpec },
    });
    const diff = await app.inject({
      method: "GET",
      url: "/capabilities/v/diff?base=1.0.0&candidate=latest",
      headers: acme,
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({ id: "v", base: "1.0.0", candidate: "1.0.1", typeChanged: false });
    expect((diff.json() as { changes: unknown[] }).changes).toContainEqual({
      path: "description",
      before: "first",
      after: "second",
      change: "changed",
    });
    const missing = await app.inject({ method: "GET", url: "/capabilities/v/diff?base=1.0.0", headers: acme });
    expect(missing.statusCode).toBe(400);
  });

  it("reads a cross-tenant public capability's versions via source, and 404s a non-visible one", async () => {
    const app = build(true);
    await app.inject({
      method: "PUT",
      url: "/capabilities/pub",
      headers: acme,
      payload: { name: "pub", description: "d", spec: skillSpec, visibility: "public" },
    });
    // beta can list acme's public capability versions through ?source=acme …
    const viaSource = await app.inject({
      method: "GET",
      url: "/capabilities/pub/versions?source=acme",
      headers: beta,
    });
    expect(viaSource.json()).toMatchObject({ source: "acme", versions: ["1.0.0"] });
    // … but not without source (its own workspace has no such id) → 404
    const own = await app.inject({ method: "GET", url: "/capabilities/pub/versions", headers: beta });
    expect(own.statusCode).toBe(404);
  });

  it("probes an mcp capability URL — returns the injected prober's reachability + discovered tools", async () => {
    const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
    const app = buildServer({
      service,
      capabilityService: new CapabilityService({ store: new InMemoryCapabilityStore() }),
      probeCapabilityMcp: async (url: string, auth?: { token?: string }) => ({
        reachable: true,
        detail: `ok ${url}${auth?.token ? " (auth)" : ""}`,
        tools: [{ name: "search" }, { name: "fetch", description: "get a url" }],
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/capabilities/probe-mcp",
      headers: acme,
      payload: { url: "https://mcp.example.com/mcp", token: "t" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reachable: true,
      detail: "ok https://mcp.example.com/mcp (auth)",
      tools: [{ name: "search" }, { name: "fetch", description: "get a url" }],
    });
  });

  it("returns 404 for probe-mcp when the prober is not wired", async () => {
    const res = await build(true).inject({
      method: "POST",
      url: "/capabilities/probe-mcp",
      headers: acme,
      payload: { url: "https://mcp.example.com/mcp" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a malformed save (missing spec) and a bad visibility value with 400", async () => {
    const app = build(true);
    const bad = await app.inject({
      method: "PUT",
      url: "/capabilities/x",
      headers: acme,
      payload: { name: "x", description: "d" },
    });
    expect(bad.statusCode).toBe(400);
    await app.inject({
      method: "PUT",
      url: "/capabilities/x",
      headers: acme,
      payload: { name: "x", description: "d", spec: skillSpec },
    });
    const badVis = await app.inject({
      method: "PATCH",
      url: "/capabilities/x/visibility",
      headers: acme,
      payload: { visibility: "everyone" },
    });
    expect(badVis.statusCode).toBe(400);
  });

  // Environment kind — a managed eval-environment image published into the store, its image classified against the
  // workspace's registries at save time (warn-not-block). docs/architecture/environment-image-store.md.
  it("saves an environment capability, surfacing image warnings without blocking, and reads the spec back", async () => {
    const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
    const app = buildServer({
      service,
      capabilityService: new CapabilityService({
        store: new InMemoryCapabilityStore(),
        registryCoordinates: async () => [{ host: "ghcr.io", namespace: "acme" }],
      }),
    });

    // digest-pinned workspace image → clean save, no warnings field
    const clean = await app.inject({
      method: "PUT",
      url: "/capabilities/officeqa-env",
      headers: acme,
      payload: {
        name: "officeqa-env",
        description: "OfficeQA eval environment",
        spec: {
          type: "environment",
          image: "ghcr.io/acme/officeqa-env@sha256:ab12",
          preset: { service: { port: 8000 }, dependencies: [] },
          instructions: "Serves on :8000.",
        },
        visibility: "workspace",
      },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json()).toMatchObject({ id: "officeqa-env", version: "1.0.0", created: true });
    expect((clean.json() as { imageWarnings?: unknown }).imageWarnings).toBeUndefined();

    // unqualified image → saved anyway, warning surfaced on the response
    const warned = await app.inject({
      method: "PUT",
      url: "/capabilities/local-env",
      headers: acme,
      payload: {
        name: "local-env",
        description: "a local build",
        spec: { type: "environment", image: "officeqa-env:v3", instructions: "local only" },
      },
    });
    expect(warned.statusCode).toBe(200);
    expect(warned.json()).toMatchObject({
      created: true,
      imageWarnings: [{ image: "officeqa-env:v3", class: "unqualified" }],
    });

    // a preset service fragment carrying image/name is rejected at the boundary (strict fragment)
    const badPreset = await app.inject({
      method: "PUT",
      url: "/capabilities/bad-env",
      headers: acme,
      payload: {
        name: "bad-env",
        description: "d",
        spec: {
          type: "environment",
          image: "ghcr.io/acme/e:v1",
          preset: { service: { image: "x:1" } },
          instructions: "x",
        },
      },
    });
    expect(badPreset.statusCode).toBe(400);

    const got = await app.inject({ method: "GET", url: "/capabilities/officeqa-env", headers: acme });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      spec: {
        type: "environment",
        image: "ghcr.io/acme/officeqa-env@sha256:ab12",
        preset: { service: { port: 8000 } },
      },
      imageClass: "workspace", // viewer-relative provenance, served by the control plane
    });
  });

  // The store→pin flow end-to-end at the HTTP layer: publish an environment, read it as a consumer, pin its image
  // into a harness instance with the pinSources provenance annotation — the pin value stays the VERBATIM ref and the
  // resolved spec never carries the annotation. docs/architecture/environment-image-store.md.
  it("pins a published environment's image into a harness instance — verbatim ref + provenance annotation round-trip", async () => {
    const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
    const harnessTemplates = new InMemoryHarnessTemplateRegistry();
    const harnessInstances = new InMemoryHarnessInstanceRegistry(harnessTemplates);
    const app = buildServer({
      service,
      capabilityService: new CapabilityService({
        store: new InMemoryCapabilityStore(),
        registryCoordinates: async () => [{ host: "ghcr.io", namespace: "acme" }],
      }),
      harnessTemplates,
      harnessInstances,
    });

    // 1. publish the environment into the store
    await app.inject({
      method: "PUT",
      url: "/capabilities/officeqa-env",
      headers: acme,
      payload: {
        name: "officeqa-env",
        description: "OfficeQA eval environment",
        spec: {
          type: "environment",
          image: "ghcr.io/acme/officeqa-env@sha256:ab12",
          preset: { service: { port: 8000 } },
          instructions: "Serves on :8000.",
        },
        visibility: "workspace",
      },
    });

    // 2. the consumer reads the asset (what the web picker / composing agent does)
    const env = (await app.inject({ method: "GET", url: "/capabilities/officeqa-env", headers: acme })).json() as {
      tenant: string;
      id: string;
      version: string;
      spec: { image: string };
    };

    // 3. register the topology template (image-less slot) + the instance pinned from the store
    const template = await app.inject({
      method: "POST",
      url: "/harness-templates",
      headers: acme,
      payload: {
        kind: "service",
        category: "topology",
        id: "officeqa",
        version: "1",
        services: [{ name: "officeqa", port: 8000, slot: "officeqa" }],
        dependencies: [],
        frontDoor: { service: "officeqa", submit: "POST /runs" },
        traceSource: { kind: "otel", endpoint: "http://otel:4318" },
      },
    });
    expect(template.statusCode).toBe(201);
    const registered = await app.inject({
      method: "POST",
      url: "/harnesses",
      headers: acme,
      payload: {
        template: { id: "officeqa", version: "1" },
        id: "officeqa",
        version: "1.0.0",
        pins: { officeqa: env.spec.image },
        pinSources: { officeqa: { source: env.tenant, id: env.id, version: env.version } },
      },
    });
    expect(registered.statusCode).toBe(201);
    expect((registered.json() as { imageWarnings?: unknown }).imageWarnings).toBeUndefined(); // digest-pinned

    // 4. the raw instance round-trips the annotation; the resolved spec carries the verbatim image and NO annotation
    const raw = (
      await app.inject({ method: "GET", url: "/harnesses/officeqa/1.0.0/instance", headers: acme })
    ).json() as { pins: Record<string, string>; pinSources?: Record<string, { id: string }> };
    expect(raw.pins.officeqa).toBe("ghcr.io/acme/officeqa-env@sha256:ab12");
    expect(raw.pinSources?.officeqa?.id).toBe("officeqa-env");
    const resolved = (await app.inject({ method: "GET", url: "/harnesses/officeqa/1.0.0", headers: acme })).json() as {
      services?: { name: string; image: string }[];
      pinSources?: unknown;
    };
    expect(resolved.services?.find((s) => s.name === "officeqa")?.image).toBe("ghcr.io/acme/officeqa-env@sha256:ab12");
    expect(resolved.pinSources).toBeUndefined();
  });
});
