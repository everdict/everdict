import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { InMemoryEnvironmentRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The environment doors (harness-definability-spec.md §2) — the world a case ACTS ON, as a registered entity.
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in environment tests");
  },
};
function build(withRegistry: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  return buildServer({
    service,
    ...(withRegistry ? { environmentRegistry: new InMemoryEnvironmentRegistry() } : {}),
  });
}
const H = { "x-everdict-tenant": "acme" };
const SHOP = { id: "shop", version: "1.0.0", env: { kind: "repo", source: { path: "/app" } } };

describe("environment routes", () => {
  it("404s when no environment registry is configured — a capability this deployment lacks says so", async () => {
    const res = await build(false).inject({ method: "POST", url: "/environments", payload: SHOP, headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("registers a version, lists it, reads it back, and refuses a second registration of the same version", async () => {
    const app = build(true);
    const created = await app.inject({ method: "POST", url: "/environments", payload: SHOP, headers: H });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ workspace: "acme", id: "shop", version: "1.0.0" });

    const list = await app.inject({ method: "GET", url: "/environments", headers: H });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: "shop", versions: ["1.0.0"], owner: "acme" })]);

    const read = await app.inject({ method: "GET", url: "/environments/shop/versions/latest", headers: H });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(SHOP);

    // Registry versions are immutable — the same (id, version) with different bytes is a conflict, not an edit.
    const again = await app.inject({
      method: "POST",
      url: "/environments",
      payload: { ...SHOP, env: { kind: "prompt" } },
      headers: H,
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses a spec that is not an EnvironmentSpec, and a nested REF (a ref to a ref resolves to nothing)", async () => {
    const app = build(true);
    const bad = await app.inject({ method: "POST", url: "/environments", payload: { id: "x" }, headers: H });
    expect(bad.statusCode).toBe(400);
    const nested = await app.inject({
      method: "POST",
      url: "/environments",
      payload: { id: "x", version: "1.0.0", env: { kind: "ref", id: "shop" } },
      headers: H,
    });
    expect(nested.statusCode).toBe(400);
  });

  it("another workspace's environment reads as one that does not exist", async () => {
    const app = build(true);
    await app.inject({ method: "POST", url: "/environments", payload: SHOP, headers: H });
    const other = await app.inject({
      method: "GET",
      url: "/environments/shop/versions/1.0.0",
      headers: { "x-everdict-tenant": "other" },
    });
    expect(other.statusCode).toBe(404);
  });
});
