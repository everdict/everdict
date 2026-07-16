import { BrowserProfileService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryBrowserProfileStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in browser-profile tests");
  },
};

function build(withProfiles: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  let i = 0;
  return buildServer({
    service,
    ...(withProfiles
      ? {
          browserProfileService: new BrowserProfileService({
            store: new InMemoryBrowserProfileStore(),
            newId: () => `bp-${i++}`,
          }),
        }
      : {}),
  });
}

const H = { "x-everdict-tenant": "acme" };

describe("browser-profile routes", () => {
  it("returns 404 when browser profiles are not configured", async () => {
    const res = await build(false).inject({
      method: "POST",
      url: "/browser-profiles",
      payload: { name: "x" },
      headers: H,
    });
    expect(res.statusCode).toBe(404);
  });

  it("creates, lists, gets, renames, and deletes a profile (self-scoped happy path)", async () => {
    const app = build(true);

    const created = await app.inject({
      method: "POST",
      url: "/browser-profiles",
      headers: H,
      payload: { name: "GitHub", cookieDomains: ["github.com"] },
    });
    expect(created.statusCode).toBe(200);
    const profile = created.json() as { id: string; name: string; cookieDomains: string[] };
    expect(profile).toMatchObject({ id: "bp-0", name: "GitHub", cookieDomains: ["github.com"] });

    const list = await app.inject({ method: "GET", url: "/browser-profiles", headers: H });
    expect((list.json() as unknown[]).length).toBe(1);

    const got = await app.inject({ method: "GET", url: `/browser-profiles/${profile.id}`, headers: H });
    expect(got.statusCode).toBe(200);

    const patched = await app.inject({
      method: "PATCH",
      url: `/browser-profiles/${profile.id}`,
      headers: H,
      payload: { name: "GitHub work" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { name: string }).name).toBe("GitHub work");

    const del = await app.inject({ method: "DELETE", url: `/browser-profiles/${profile.id}`, headers: H });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({ method: "GET", url: `/browser-profiles/${profile.id}`, headers: H });
    expect(gone.statusCode).toBe(404);
  });

  it("400s an empty create body and 404s an unknown id", async () => {
    const app = build(true);
    expect((await app.inject({ method: "POST", url: "/browser-profiles", headers: H, payload: {} })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: "GET", url: "/browser-profiles/nope", headers: H })).statusCode).toBe(404);
  });
});
