import type { KnowledgeEntryRecord, SkillRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { KnowledgeService } from "./knowledge-service.js";

// Context assembly reads the knowledge-entry and skill RECORDS directly (always current) — the anchors select them by
// entity family, and the anchor's version is the coordinate every match is positioned against.

const skill = (
  id: string,
  refs: SkillRecord["refs"],
  visibility: SkillRecord["visibility"] = "workspace",
): SkillRecord => ({
  id,
  tenant: "acme",
  name: id,
  description: `${id} desc`,
  instructions: "SECRET-BODY", // must NOT appear in the assembled context (listing-level only)
  version: "1.0.0",
  files: [],
  refs,
  visibility,
  createdBy: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

const entry = (
  id: string,
  refs: KnowledgeEntryRecord["refs"],
  status: KnowledgeEntryRecord["status"] = "active",
  updatedAt = "2026-07-01T00:00:00.000Z",
): KnowledgeEntryRecord => ({
  id,
  tenant: "acme",
  kind: "finding",
  title: `${id} title`,
  body: "…",
  refs,
  evidence: [],
  status,
  visibility: "workspace",
  createdBy: "alice",
  createdAt: updatedAt,
  updatedAt,
});

describe("KnowledgeService.assembleContext", () => {
  const webAgent = { type: "harness" as const, key: "web-agent" };

  it("family-matches records to anchors (version-agnostic), labels relations, decorates coverage, and keeps skills listing-level", async () => {
    const svc = new KnowledgeService({
      skills: {
        list: async () => [
          skill("triage", [{ ...webAgent, version: "2.1.0" }]),
          skill("unrelated", [{ type: "dataset", key: "other" }]),
        ],
      },
      knowledgeEntries: {
        list: async () => [
          entry("old-deprecated", [{ ...webAgent, version: "2.0.0" }], "deprecated", "2026-07-10T00:00:00.000Z"),
          entry("live-claim", [{ ...webAgent, version: "2.1.0" }], "active", "2026-07-05T00:00:00.000Z"),
          entry("unrelated", [{ type: "judge", key: "j1" }]),
        ],
      },
      latestVersionOf: async (_t, ref) => (ref.key === "web-agent" ? "2.3.0" : undefined),
    });

    // The task anchors a NEWER version of the harness — family matching still surfaces claims pinned to 2.1.0.
    const ctx = await svc.assembleContext("acme", "alice", [{ ...webAgent, version: "2.3.0" }]);

    expect(ctx.knowledge.map((k) => k.id)).toEqual(["live-claim", "old-deprecated"]); // same tier → active first
    expect(ctx.knowledge[0]?.relation).toBe("earlier"); // pinned at 2.1.0 — an earlier point of the 2.3.0 anchor
    expect(ctx.knowledge[0]?.coverage?.state).toBe("behind"); // interval ends at 2.1.0, present is 2.3.0

    expect(ctx.skills.map((s) => s.id)).toEqual(["triage"]);
    expect(ctx.skills[0]?.coverage?.state).toBe("behind");
    expect(JSON.stringify(ctx.skills)).not.toContain("SECRET-BODY"); // no instructions body in the context payload
  });

  it("projects onto a PAST anchor coordinate: a superseded claim covering it outranks an active claim from its future", async () => {
    const svc = new KnowledgeService({
      skills: { list: async () => [] },
      knowledgeEntries: {
        list: async () => [
          // the then-truth: pinned at 2.1.0, since superseded by the fix note
          entry("then-truth", [{ ...webAgent, version: "2.1.0" }], "superseded", "2026-07-01T00:00:00.000Z"),
          // the fix, observed at 2.2.0 — this coordinate's FUTURE
          entry("the-fix", [{ ...webAgent, version: "2.2.0" }], "active", "2026-07-20T00:00:00.000Z"),
        ],
      },
      latestVersionOf: async () => "2.3.0",
    });

    // analyzing an old scorecard that ran harness@2.1.0 — the anchor's version IS the as-of coordinate
    const ctx = await svc.assembleContext("acme", "alice", [{ ...webAgent, version: "2.1.0" }]);
    expect(ctx.knowledge.map((k) => k.id)).toEqual(["then-truth", "the-fix"]);
    expect(ctx.knowledge[0]?.relation).toBe("covers"); // superseded, but the truth AT this coordinate
    expect(ctx.knowledge[1]?.relation).toBe("later"); // the "what happened next" trail, ranked after
  });

  it("leaves proposed candidates and non-anchor families out, and decorates nothing without a resolver", async () => {
    const svc = new KnowledgeService({
      skills: { list: async () => [skill("unrelated", [{ type: "dataset", key: "other" }])] },
      knowledgeEntries: {
        list: async () => [
          entry("candidate", [{ ...webAgent, version: "2.1.0" }], "proposed"),
          entry("claim", [{ ...webAgent, version: "2.1.0" }]),
        ],
      },
    });
    // an unversioned anchor with no resolver has no coordinate: its match carries no relation and no coverage
    const ctx = await svc.assembleContext("acme", "alice", [webAgent]);
    expect(ctx.knowledge).toHaveLength(1);
    expect(ctx.knowledge[0]?.id).toBe("claim");
    expect(ctx.knowledge[0]?.relation).toBeUndefined();
    expect(ctx.knowledge[0]?.coverage).toBeUndefined();
    expect(ctx.skills).toEqual([]);
    // Three keys, not two: `receipt` joined the payload when the assembly began filing what it answered.
    // The key set stays pinned because this payload is a HOT one — it feeds every agent turn and every
    // plugin session, and a field that arrives unnoticed is a field nobody decided to pay for.
    expect(Object.keys(ctx).sort()).toEqual(["knowledge", "receipt", "skills"]);
    expect(ctx.receipt).toEqual({ recorded: false, reason: "unconfigured" });
  });
});

// ── THE RECEIPT — what the assembly answered, filed by the assembly ──────────────────────────────────
//
// The four outcomes are one contract: a caller can always tell a deployment that records from one that does
// not, and a failed write from a read nobody attributed. The read itself never fails for any of them — the
// context is the product — which is exactly why the outcome has to be IN the result rather than in a log.
describe("KnowledgeService.assembleContext — the retrieval receipt", () => {
  const anchor = { type: "repository" as const, key: "acme/widget" };
  const stores = (count: number) => ({
    skills: { list: async () => [] },
    knowledgeEntries: {
      list: async () => Array.from({ length: count }, (_, i) => entry(`e${i}`, [anchor])),
    },
  });

  it("reports `unconfigured` when no writer is composed — never silence", async () => {
    const svc = new KnowledgeService(stores(1));
    const ctx = await svc.assembleContext("acme", "alice", [anchor], { sessionId: "s-1" });
    expect(ctx.knowledge).toHaveLength(1); // the read still answered
    expect(ctx.receipt).toEqual({ recorded: false, reason: "unconfigured" });
  });

  it("reports `unattributed` rather than inventing a session for an unattributed caller", async () => {
    const written: unknown[] = [];
    const svc = new KnowledgeService({
      ...stores(1),
      receipts: {
        write: async (r) => {
          written.push(r);
          return { recorded: true, path: "p" };
        },
        writeUse: async () => ({ recorded: true, path: "used" }),
      },
    });
    const ctx = await svc.assembleContext("acme", "alice", [anchor]);
    expect(ctx.receipt).toEqual({ recorded: false, reason: "unattributed" });
    expect(written).toHaveLength(0); // nothing filed under a guessed key
  });

  it("files what was ANSWERED, and says what the page cut", async () => {
    // 25 matches, page is 20: the returned list alone cannot show that five were dropped, so the counts do.
    let filed: { counts: Record<string, number>; knowledge: unknown[]; sessionId: string } | undefined;
    const svc = new KnowledgeService({
      ...stores(25),
      receipts: {
        write: async (r) => {
          filed = r as never;
          return { recorded: true, path: `knowledge/retrievals/d/${r.sessionId}/assembly-x.json` };
        },
        writeUse: async () => ({ recorded: true, path: "used" }),
      },
    });
    const ctx = await svc.assembleContext("acme", "alice", [anchor], { sessionId: "s-42" });

    expect(ctx.receipt).toEqual({
      recorded: true,
      path: "knowledge/retrievals/d/s-42/assembly-x.json",
    });
    expect(filed?.sessionId).toBe("s-42");
    expect(filed?.counts).toMatchObject({ knowledgeAvailable: 25, knowledgeReturned: 20 });
    expect(filed?.knowledge).toHaveLength(20);
  });

  it("a failed write is reported, and does not fail the read", async () => {
    const svc = new KnowledgeService({
      ...stores(2),
      receipts: {
        write: async () => ({ recorded: false, reason: "write_failed", detail: "storage down" }),
        writeUse: async () => ({ recorded: false, reason: "write_failed", detail: "storage down" }),
      },
    });
    const ctx = await svc.assembleContext("acme", "alice", [anchor], { sessionId: "s-1" });
    expect(ctx.knowledge).toHaveLength(2);
    expect(ctx.receipt).toEqual({ recorded: false, reason: "write_failed", detail: "storage down" });
  });
});

// ── THE SESSION'S ACCOUNT ────────────────────────────────────────────────────────────────────────────
// The platform cannot produce this half, and it CAN check the citations — which is the difference between a
// measurement and a note.
describe("KnowledgeService.recordUse", () => {
  const anchor = { type: "repository" as const, key: "acme/widget" };
  const stores = (ids: string[]) => ({
    skills: { list: async () => [] },
    knowledgeEntries: { list: async () => ids.map((id) => entry(id, [anchor])) },
  });
  const writer = (sink: { use?: unknown }) => ({
    write: async () => ({ recorded: true as const, path: "a" }),
    writeUse: async (u: unknown) => {
      sink.use = u;
      return { recorded: true as const, path: "knowledge/retrievals/d/s-1/used.json" };
    },
  });

  it("refuses a citation this workspace cannot resolve", async () => {
    const svc = new KnowledgeService({ ...stores(["k-1"]), receipts: writer({}) });
    await expect(
      svc.recordUse("acme", "alice", {
        sessionId: "s-1",
        assemblyPath: "knowledge/retrievals/d/s-1/assembly-x.json",
        used: ["k-1", "k-ghost"],
        outcome: "used the convention",
      }),
    ).rejects.toThrow(/'k-ghost' is not one this workspace can show you/);
  });

  it("accepts an EMPTY used — 'the workspace had nothing for this work' is the measurement", async () => {
    const sink: { use?: { used: unknown[]; outcome: string } } = {};
    const svc = new KnowledgeService({ ...stores(["k-1"]), receipts: writer(sink) });
    const outcome = await svc.recordUse("acme", "alice", {
      sessionId: "s-1",
      assemblyPath: "knowledge/retrievals/d/s-1/assembly-x.json",
      used: [],
      outcome: "nothing here covered it",
    });
    expect(outcome).toEqual({ recorded: true, path: "knowledge/retrievals/d/s-1/used.json" });
    expect(sink.use?.used).toEqual([]);
  });

  it("carries the resolved TITLE, so the file is readable without a second lookup", async () => {
    const sink: { use?: { used: { id: string; title: string }[] } } = {};
    const svc = new KnowledgeService({ ...stores(["k-1"]), receipts: writer(sink) });
    await svc.recordUse("acme", "alice", {
      sessionId: "s-1",
      assemblyPath: "knowledge/retrievals/d/s-1/assembly-x.json",
      used: ["k-1"],
      outcome: "followed it",
    });
    expect(sink.use?.used).toEqual([{ id: "k-1", title: "k-1 title" }]);
  });

  it("says `unconfigured` rather than pretending, when no writer is composed", async () => {
    const svc = new KnowledgeService(stores(["k-1"]));
    expect(
      await svc.recordUse("acme", "alice", {
        sessionId: "s-1",
        assemblyPath: "knowledge/retrievals/d/s-1/assembly-x.json",
        used: [],
        outcome: "x",
      }),
    ).toEqual({ recorded: false, reason: "unconfigured" });
  });
});
