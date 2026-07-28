import { KNOWLEDGE_EXTRACTION_AUTHOR, KnowledgeEntryService } from "@everdict/application-control";
import type { CommentRecord } from "@everdict/contracts";
import { InMemoryCommentStore, InMemoryKnowledgeEntryStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { KnowledgeExtractionService, parseCandidates } from "./knowledge-extraction-service.js";

const comment = (id: string, body: string, parentId?: string): CommentRecord => ({
  id,
  tenant: "acme",
  resourceType: "scorecard",
  resourceId: "sc-1",
  ...(parentId !== undefined ? { parentId } : {}),
  author: `user-${id}`,
  body,
  createdAt: `2026-07-28T00:0${id.length}:00Z`,
  updatedAt: `2026-07-28T00:0${id.length}:00Z`,
});

const CANDIDATES_JSON = JSON.stringify([
  {
    kind: "finding",
    title: "Login cases are flaky on the k8s runtime",
    body: "Three reruns showed variance only on k8s.",
    refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
    confidence: 0.8,
  },
]);

async function harness(completionText: string) {
  const comments = new InMemoryCommentStore();
  await comments.add(comment("root", "we saw login flakiness again on k8s"));
  await comments.add(comment("r1", "confirmed — three reruns, only k8s shows variance", "root"));
  const entryStore = new InMemoryKnowledgeEntryStore();
  let n = 0;
  const entries = new KnowledgeEntryService({
    store: entryStore,
    newId: () => `kn-${n++}`,
    now: () => "2026-07-28T01:00:00.000Z",
  });
  const prompts: string[] = [];
  const svc = new KnowledgeExtractionService({
    models: { get: async () => ({ id: "m", version: "1", provider: "anthropic", model: "x" }) } as never,
    scopedSecretsFor: async () => ({ workspace: {}, user: {} }),
    entries,
    comments,
    completionFor: async () => async (prompt: string) => {
      prompts.push(prompt);
      return completionText;
    },
  });
  return { svc, entries, prompts };
}

describe("KnowledgeExtractionService", () => {
  it("mines a thread into proposed entries: extractor authorship, source evidence, and the discussed resource as an anchor", async () => {
    const { svc, prompts } = await harness(CANDIDATES_JSON);
    const result = await svc.extract("acme", "alice", { source: { kind: "comment", id: "root" }, model: "m" });

    expect(result.considered).toBe(1);
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0];
    expect(p?.status).toBe("proposed");
    expect(p?.createdBy).toBe(KNOWLEDGE_EXTRACTION_AUTHOR);
    expect(p?.visibility).toBe("workspace"); // reviewable by every member
    expect(p?.extraction).toEqual({
      sourceKind: "comment",
      sourceId: "root",
      extractor: "knowledge_extractor_v1",
      confidence: 0.8,
    });
    expect(p?.evidence).toEqual([{ type: "comment", key: "root" }]);
    // the model's own ref + the discussed resource auto-anchored
    expect(p?.refs).toEqual([
      { type: "harness", key: "web-agent", version: "2.1.0" },
      { type: "scorecard", key: "sc-1" },
    ]);
    // the transcript reached the model: both thread messages, timeline order
    expect(prompts[0]).toContain("user-root: we saw login flakiness again on k8s");
    expect(prompts[0]).toContain("user-r1: confirmed");
  });

  it("re-running on the same thread skips already-proposed claims (dedupe by source + title)", async () => {
    const { svc } = await harness(CANDIDATES_JSON);
    await svc.extract("acme", "alice", { source: { kind: "comment", id: "root" }, model: "m" });
    const second = await svc.extract("acme", "alice", { source: { kind: "comment", id: "root" }, model: "m" });
    expect(second.proposals).toHaveLength(0);
    expect(second.skippedDuplicates).toBe(1);
  });

  it("a reply id resolves to its root thread (1-level threading)", async () => {
    const { svc } = await harness(CANDIDATES_JSON);
    const result = await svc.extract("acme", "alice", { source: { kind: "comment", id: "r1" }, model: "m" });
    expect(result.proposals[0]?.extraction?.sourceId).toBe("root");
  });

  it("404s an unknown comment", async () => {
    const { svc } = await harness(CANDIDATES_JSON);
    await expect(
      svc.extract("acme", "alice", { source: { kind: "comment", id: "nope" }, model: "m" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("parseCandidates — the lenient model-output boundary", () => {
  it("takes the outermost array even when wrapped in prose, drops invalid refs but keeps the candidate", () => {
    const text = `Here you go:\n[{"kind":"decision","title":"t","body":"b","refs":[{"type":"not_a_type","key":"x"},{"type":"dataset","key":"d1"}],"confidence":0.9}]\nDone.`;
    const out = parseCandidates(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.refs).toEqual([{ type: "dataset", key: "d1" }]); // the bad ref dropped, never the candidate
  });

  it("drops items missing kind/title/body, defaults an out-of-range confidence, and caps the batch at 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      kind: "finding",
      title: `t${i}`,
      body: "b",
      confidence: 7, // out of range → default
    }));
    const out = parseCandidates(JSON.stringify([{ kind: "finding", title: "", body: "b" }, ...many]));
    expect(out).toHaveLength(5);
    expect(out[0]?.confidence).toBe(0.6);
  });

  it("returns [] on non-JSON output (an empty extraction is a correct answer, never a crash)", () => {
    expect(parseCandidates("I could not find anything durable.")).toEqual([]);
  });
});
