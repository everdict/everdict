import { RunService, SkillService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemorySkillStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in skill tests");
  },
};

function build(withSkills: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  return buildServer({
    service,
    ...(withSkills ? { skillService: new SkillService({ store: new InMemorySkillStore() }) } : {}),
  });
}

const H = { "x-everdict-tenant": "acme" };

describe("skill routes", () => {
  it("returns 404 when skills are not configured", async () => {
    const res = await build(false).inject({ method: "GET", url: "/skills", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("authors, reads, lists, shares, and deletes a workspace skill (happy path)", async () => {
    const app = build(true);

    const created = await app.inject({
      method: "POST",
      url: "/skills",
      headers: H,
      payload: { name: "scorecard-triage", description: "Summarize failures", instructions: "1. get_scorecard\n2. …" },
    });
    expect(created.statusCode).toBe(200);
    const skill = created.json() as { id: string; visibility: string; name: string };
    expect(skill).toMatchObject({ name: "scorecard-triage", visibility: "private" }); // personal draft by default

    const got = await app.inject({ method: "GET", url: `/skills/${skill.id}`, headers: H });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { instructions: string }).instructions).toContain("get_scorecard");

    // Share to the workspace (visibility-only PATCH = the share toggle).
    const shared = await app.inject({
      method: "PATCH",
      url: `/skills/${skill.id}`,
      headers: H,
      payload: { visibility: "workspace" },
    });
    expect((shared.json() as { visibility: string }).visibility).toBe("workspace");

    const list = await app.inject({ method: "GET", url: "/skills", headers: H });
    expect((list.json() as Array<{ id: string }>).map((s) => s.id)).toEqual([skill.id]);

    const del = await app.inject({ method: "DELETE", url: `/skills/${skill.id}`, headers: H });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: `/skills/${skill.id}`, headers: H });
    expect(after.statusCode).toBe(404);
  });

  it("rejects an empty PATCH body (at least one field required)", async () => {
    const app = build(true);
    const created = await app.inject({
      method: "POST",
      url: "/skills",
      headers: H,
      payload: { name: "x", description: "d", instructions: "i" },
    });
    const id = (created.json() as { id: string }).id;
    const bad = await app.inject({ method: "PATCH", url: `/skills/${id}`, headers: H, payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it("returns 404 for generate when the generator is not configured", async () => {
    const res = await build(true).inject({
      method: "POST",
      url: "/skills/generate",
      headers: H,
      payload: { description: "triage scorecards", model: "agent-llm" },
    });
    expect(res.statusCode).toBe(404);
  });
});
