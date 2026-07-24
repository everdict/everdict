import { CapabilityService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryCapabilityStore, InMemoryRunStore } from "@everdict/db";
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
});
