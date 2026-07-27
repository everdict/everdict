import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in profile tests");
  },
};
const svc = () => new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
const acme = { "x-everdict-tenant": "acme" };

// GET /me surfaces read-only instance config the web can't derive from the token — currently the community-instance
// public-publish policy. Off by default; reflects the operator's ServerDeps flag.
describe("GET /me — instance config", () => {
  it("reports allowMemberPublicPublish=false by default", async () => {
    const res = await buildServer({ service: svc() }).inject({ method: "GET", url: "/me", headers: acme });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ config: { allowMemberPublicPublish: false } });
  });

  it("reports allowMemberPublicPublish=true when the operator opts in", async () => {
    const res = await buildServer({ service: svc(), allowMemberPublicPublish: true }).inject({
      method: "GET",
      url: "/me",
      headers: acme,
    });
    expect(res.json()).toMatchObject({ config: { allowMemberPublicPublish: true } });
  });
});
