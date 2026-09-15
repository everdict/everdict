import { KnowledgeEntryService, KnowledgeService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { NodeRef } from "@everdict/contracts";
import { InMemoryCommentStore, InMemoryKnowledgeEntryStore, InMemoryRunStore, InMemorySkillStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { KnowledgeExtractionService } from "../../core/knowledge/knowledge-extraction-service.js";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in knowledge tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

async function build(withKnowledge: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  if (!withKnowledge) return buildServer({ service });

  const knowledgeEntryStore = new InMemoryKnowledgeEntryStore();
  const skillStore = new InMemorySkillStore();
  await skillStore.create({
    id: "triage",
    tenant: "acme",
    name: "web-agent-triage",
    description: "how to triage a web-agent regression",
    instructions: "SKILL-BODY", // listing-level only — must not ride the context payload
    files: [],
    refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
    visibility: "workspace",
    version: "1.0.0",
    createdBy: "user-alice",
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z",
  });
  // Fake registry-latest: the harness family moved on to 2.3.0 (so a 2.1.0-pinned ref reads superseded).
  const latestVersionOf = async (_tenant: string, ref: NodeRef) =>
    ref.type === "harness" && ref.key === "web-agent" ? "2.3.0" : undefined;
  const knowledgeEntryService = new KnowledgeEntryService({ store: knowledgeEntryStore, latestVersionOf });
  // The extraction route: one comment thread plus a canned completion (one candidate) — for verifying the route, the gate and the round trip (no model call)
  const comments = new InMemoryCommentStore();
  await comments.add({
    id: "root",
    tenant: "acme",
    resourceType: "scorecard",
    resourceId: "sc1",
    author: "user-alice",
    body: "login flakiness discussion",
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z",
  });
  const knowledgeExtraction = new KnowledgeExtractionService({
    models: { get: async () => ({ id: "m", version: "1", provider: "anthropic", model: "x" }) } as never,
    scopedSecretsFor: async () => ({ workspace: {}, user: {} }),
    entries: knowledgeEntryService,
    comments,
    completionFor: async () => async () =>
      JSON.stringify([
        { kind: "finding", title: "Login cases are flaky on k8s", body: "…", refs: [], confidence: 0.7 },
      ]),
  });
  return buildServer({
    service,
    knowledgeService: new KnowledgeService({
      skills: skillStore,
      knowledgeEntries: knowledgeEntryStore,
      latestVersionOf,
    }),
    knowledgeEntryService,
    knowledgeExtraction,
  });
}

describe("knowledge entries — reified claims", () => {
  const entryPayload = {
    kind: "finding",
    title: "login cases flaky on k8s",
    body: "variance only on the k8s runtime",
    refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
    evidence: [{ type: "scorecard", key: "sc1" }],
    visibility: "workspace",
  };

  it("404s when the entry service is not configured", async () => {
    const res = await (await build(false)).inject({ method: "GET", url: "/knowledge/entries", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("creates an entry, lists it coverage-decorated (interval ends at 2.1.0, present 2.3.0 → behind)", async () => {
    const app = await build(true);
    const post = await app.inject({ method: "POST", url: "/knowledge/entries", headers: H, payload: entryPayload });
    expect(post.statusCode).toBe(201);
    const created = post.json() as { id: string; status: string };
    expect(created.status).toBe("active");

    const list = await app.inject({ method: "GET", url: "/knowledge/entries", headers: H });
    expect(list.statusCode).toBe(200);
    const entries = list.json() as Array<{ id: string; coverage?: { state: string } }>;
    expect(entries[0]?.id).toBe(created.id);
    expect(entries[0]?.coverage?.state).toBe("behind");
  });

  it("400s an unknown kind (closed vocabulary, no fallback)", async () => {
    const res = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/entries",
      headers: H,
      payload: { ...entryPayload, kind: "insight" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("verify stamps verifiedAt without touching updatedAt; PATCH edits; DELETE removes", async () => {
    const app = await build(true);
    const created = (
      await app.inject({ method: "POST", url: "/knowledge/entries", headers: H, payload: entryPayload })
    ).json() as { id: string; updatedAt: string };

    const verified = await app.inject({
      method: "POST",
      url: `/knowledge/entries/${created.id}/verify`,
      headers: H,
    });
    expect(verified.statusCode).toBe(200);
    const vBody = verified.json() as { verifiedAt?: string; updatedAt: string };
    expect(vBody.verifiedAt).toBeDefined();
    expect(vBody.updatedAt).toBe(created.updatedAt);

    const patched = await app.inject({
      method: "PATCH",
      url: `/knowledge/entries/${created.id}`,
      headers: H,
      payload: { status: "deprecated" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { status: string }).status).toBe("deprecated");

    const removed = await app.inject({ method: "DELETE", url: `/knowledge/entries/${created.id}`, headers: H });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: `/knowledge/entries/${created.id}`, headers: H });
    expect(gone.statusCode).toBe(404);
  });

  it("assembles task context: the entries and skills about the anchor family (version-agnostic match)", async () => {
    const app = await build(true);
    await app.inject({ method: "POST", url: "/knowledge/entries", headers: H, payload: entryPayload });

    const res = await app.inject({
      method: "POST",
      url: "/knowledge/context",
      headers: H,
      // The task anchors a NEWER harness version — the 2.1.0-pinned claim must still surface (family match).
      payload: { refs: [{ type: "harness", key: "web-agent", version: "2.3.0" }] },
    });
    expect(res.statusCode).toBe(200);
    const ctx = res.json() as {
      knowledge: Array<{ title: string; relation?: string; coverage?: { state: string } }>;
      skills: Array<{ id: string; relation?: string }>;
    };
    expect(Object.keys(ctx).sort()).toEqual(["knowledge", "skills"]);
    expect(ctx.knowledge).toHaveLength(1);
    expect(ctx.knowledge[0]?.title).toBe(entryPayload.title);
    expect(ctx.knowledge[0]?.coverage?.state).toBe("behind");
    expect(ctx.knowledge[0]?.relation).toBe("earlier"); // pinned at 2.1.0, anchored at 2.3.0
    expect(ctx.skills.map((k) => k.id)).toEqual(["triage"]);
    expect(ctx.skills[0]?.relation).toBe("earlier");
    expect(res.body).not.toContain("SKILL-BODY");
  });

  it("404s task context when the knowledge service is not configured", async () => {
    const res = await (await build(false)).inject({
      method: "POST",
      url: "/knowledge/context",
      headers: H,
      payload: { refs: [{ type: "harness", key: "web-agent" }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s an empty context anchor list", async () => {
    const res = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/context",
      headers: H,
      payload: { refs: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("knowledge extraction — thread → proposed → approve/reject", () => {
  it("extracts proposals from a thread, review-approves one (authorship transfer), and rejects on re-extract dupes", async () => {
    const app = await build(true);
    const extracted = await app.inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "comment", id: "root" }, model: "m" },
    });
    expect(extracted.statusCode).toBe(200);
    const { proposals } = extracted.json() as { proposals: Array<{ id: string; status: string; createdBy: string }> };
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe("proposed");
    expect(proposals[0]?.createdBy).toBe("everdict:extractor");
    const id = proposals[0]?.id ?? "";

    // re-extract: the same claim is skipped, not duplicated
    const again = await app.inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "comment", id: "root" }, model: "m" },
    });
    expect((again.json() as { skippedDuplicates: number }).skippedDuplicates).toBe(1);

    // approve → active + the approver owns it
    const approved = await app.inject({ method: "POST", url: `/knowledge/entries/${id}/approve`, headers: H });
    expect(approved.statusCode).toBe(200);
    const body = approved.json() as { status: string; createdBy: string; extraction?: { sourceId: string } };
    expect(body.status).toBe("active");
    expect(body.createdBy).not.toBe("everdict:extractor");
    expect(body.extraction?.sourceId).toBe("root"); // provenance survives approval

    // a second approve is a 409 (already active), reject likewise
    expect((await app.inject({ method: "POST", url: `/knowledge/entries/${id}/approve`, headers: H })).statusCode).toBe(
      409,
    );
    expect((await app.inject({ method: "POST", url: `/knowledge/entries/${id}/reject`, headers: H })).statusCode).toBe(
      409,
    );
  });

  it("reject deletes a proposal (204 → 404)", async () => {
    const app = await build(true);
    const { proposals } = (
      await app.inject({
        method: "POST",
        url: "/knowledge/extract",
        headers: H,
        payload: { source: { kind: "comment", id: "root" }, model: "m" },
      })
    ).json() as { proposals: Array<{ id: string }> };
    const id = proposals[0]?.id ?? "";
    expect((await app.inject({ method: "POST", url: `/knowledge/entries/${id}/reject`, headers: H })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: "GET", url: `/knowledge/entries/${id}`, headers: H })).statusCode).toBe(404);
  });

  it("400s an unsupported source kind and 404s when extraction is not configured", async () => {
    const bad = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "agent_session", id: "s1" }, model: "m" },
    });
    expect(bad.statusCode).toBe(400);
    const off = await (await build(false)).inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "comment", id: "root" }, model: "m" },
    });
    expect(off.statusCode).toBe(404);
  });
});
