import { CapabilityService, RunService, SkillService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CapabilityRecord } from "@everdict/contracts";
import { InMemoryCapabilityStore, InMemoryRunStore, InMemorySkillStore, InMemorySkillVersionStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in skill tests");
  },
};

// An Everdict-published example skill — a code definition, not a store row, exactly like the real first-party ones.
const EXAMPLE: CapabilityRecord = {
  id: "trace-analysis",
  tenant: "_everdict",
  version: "1.2.0",
  name: "analyze_trace",
  description: "Analyze one observability trace",
  spec: { type: "skill", instructions: "1. inspect_trace", files: [{ path: "references/report.md", content: "#" }] },
  visibility: "public",
  sharedWith: [],
  tags: [],
  createdBy: "everdict",
  createdAt: "2026-07-01T00:00:00.000Z",
};

function build(withSkills: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  const capabilityService = new CapabilityService({
    store: new InMemoryCapabilityStore(),
    firstPartyCatalog: () => [EXAMPLE],
  });
  return buildServer({
    service,
    ...(withSkills
      ? {
          skillService: new SkillService({
            store: new InMemorySkillStore(),
            versions: new InMemorySkillVersionStore(),
            capabilities: capabilityService,
          }),
        }
      : {}),
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

  it("round-trips supporting files: authored with the skill, replaced whole by PATCH, kept when omitted", async () => {
    const app = build(true);
    const created = await app.inject({
      method: "POST",
      url: "/skills",
      headers: H,
      payload: {
        name: "fix-pr",
        description: "Open a fix PR",
        instructions: "1. diagnose\n2. load references/pr-body.md",
        files: [{ path: "references/pr-body.md", content: "# PR body\n- What failed" }],
      },
    });
    expect(created.statusCode).toBe(200);
    const skill = created.json() as { id: string; files: Array<{ path: string }> };
    expect(skill.files.map((f) => f.path)).toEqual(["references/pr-body.md"]);

    // A files-less PATCH keeps the file set as-is.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/skills/${skill.id}`,
      headers: H,
      payload: { description: "Open a targeted fix PR" },
    });
    expect((renamed.json() as { files: Array<{ path: string }> }).files).toHaveLength(1);

    // Providing files replaces the whole set.
    const replaced = await app.inject({
      method: "PATCH",
      url: `/skills/${skill.id}`,
      headers: H,
      payload: { files: [{ path: "references/checklist.md", content: "- [ ] tests" }] },
    });
    expect((replaced.json() as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual([
      "references/checklist.md",
    ]);
  });

  it("rejects traversal / absolute / duplicate file paths (400)", async () => {
    const app = build(true);
    const cases = [
      [{ path: "../escape.md", content: "x" }],
      [{ path: "/etc/passwd", content: "x" }],
      [
        { path: "a.md", content: "x" },
        { path: "a.md", content: "y" },
      ],
    ];
    for (const files of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/skills",
        headers: H,
        payload: { name: "bad", description: "d", instructions: "i", files },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("takes a store example into the workspace as an editable skill, and refuses a second copy", async () => {
    const app = build(true);
    const taken = await app.inject({
      method: "POST",
      url: "/skills/import",
      headers: H,
      payload: { source: "_everdict", id: "trace-analysis" },
    });
    expect(taken.statusCode).toBe(200);
    const skill = taken.json() as { id: string; name: string; version: string; visibility: string; origin: unknown };
    expect(skill).toMatchObject({ name: "analyze_trace", version: "1.2.0", visibility: "workspace" });
    expect(skill.origin).toEqual({
      source: "_everdict",
      id: "trace-analysis",
      version: "1.2.0",
      name: "analyze_trace",
    });

    // It is an ordinary workspace skill now — it edits like one, and it is in the library.
    const edited = await app.inject({
      method: "PATCH",
      url: `/skills/${skill.id}`,
      headers: H,
      payload: { instructions: "1. our own first step" },
    });
    expect((edited.json() as { instructions: string }).instructions).toBe("1. our own first step");
    const list = await app.inject({ method: "GET", url: "/skills", headers: H });
    expect((list.json() as Array<{ id: string }>).map((s) => s.id)).toEqual([skill.id]);

    const again = await app.inject({
      method: "POST",
      url: "/skills/import",
      headers: H,
      payload: { source: "_everdict", id: "trace-analysis" },
    });
    expect(again.statusCode).toBe(409); // already here — the copy is theirs to edit, not to overwrite
  });

  it("404s an import of a publication that does not exist / is not visible", async () => {
    const res = await build(true).inject({
      method: "POST",
      url: "/skills/import",
      headers: H,
      payload: { source: "_everdict", id: "no-such-skill" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("stamps the current content as a version, and keeps older versions frozen", async () => {
    const app = build(true);
    const created = await app.inject({
      method: "POST",
      url: "/skills",
      headers: H,
      payload: { name: "triage", description: "d", instructions: "1. first" },
    });
    const id = (created.json() as { id: string }).id;
    expect((created.json() as { version: string }).version).toBe("1.0.0");

    await app.inject({ method: "PATCH", url: `/skills/${id}`, headers: H, payload: { instructions: "1. revised" } });
    const stamped = await app.inject({
      method: "POST",
      url: `/skills/${id}/versions`,
      headers: H,
      payload: { bump: "minor", note: "revised in conversation" },
    });
    expect(stamped.statusCode).toBe(200);
    expect(stamped.json()).toMatchObject({
      skill: { version: "1.1.0" },
      stamped: { version: "1.1.0", instructions: "1. revised", note: "revised in conversation" },
    });

    const versions = await app.inject({ method: "GET", url: `/skills/${id}/versions`, headers: H });
    expect((versions.json() as Array<{ version: string }>).map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    const first = await app.inject({ method: "GET", url: `/skills/${id}/versions/1.0.0`, headers: H });
    expect((first.json() as { instructions: string }).instructions).toBe("1. first"); // still says what it said

    // A version that does not come after the current one is a 400 — the line only moves forward.
    const backwards = await app.inject({
      method: "POST",
      url: `/skills/${id}/versions`,
      headers: H,
      payload: { version: "1.0.5" },
    });
    expect(backwards.statusCode).toBe(400);
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
