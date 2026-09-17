import type { ChangeCampaignRecord, KnowledgeEntryRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { IssueLineageService } from "./issue-lineage-service.js";

// The lineage read composes three optional sources, so the two things it must not do are: lose an edge that
// exists, and let a source it could not read look like a request that had nothing.

const campaign = (id: string, issueId: string): ChangeCampaignRecord => ({
  id,
  tenant: "acme",
  issueId,
  service: { repository: "acme/widget" },
  criteria: [{ id: "tests", statement: "green" }],
  rounds: [
    {
      seq: 1,
      hypothesis: "first try",
      changes: [{ repository: "acme/widget", commits: [{ sha: "aaa1111" }] }],
      gateRuns: [{ id: "gates", command: "pnpm test", exitCode: 0, metrics: [{ name: "tests.passed", value: 10 }] }],
      judgement: {
        at: "2026-09-17T00:00:00.000Z",
        by: "agent:builder",
        answers: [{ criterionId: "tests", answer: "not_met", how: "observed", gateRunIds: ["gates"] }],
      },
      outcome: "rejected",
    },
    {
      seq: 2,
      hypothesis: "second try",
      changes: [
        { repository: "acme/widget", commits: [{ sha: "bbb2222" }] },
        { repository: "acme/api", commits: [{ sha: "ccc3333" }] },
      ],
      gateRuns: [{ id: "gates", command: "pnpm test", exitCode: 0, metrics: [{ name: "tests.passed", value: 12 }] }],
      judgement: {
        at: "2026-09-17T01:00:00.000Z",
        by: "agent:builder",
        answers: [{ criterionId: "tests", answer: "met", how: "observed", gateRunIds: ["gates"] }],
      },
      outcome: "adopted",
    },
  ],
  state: "adopted",
  close: {
    at: "2026-09-17T02:00:00.000Z",
    by: "alice",
    state: "adopted",
    reason: "met",
    roundSeq: 2,
    knowledge: ["k-1"],
    landed: [],
    remaining: [],
  },
  createdBy: "alice",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T02:00:00.000Z",
});

const entry = (id: string, refs: KnowledgeEntryRecord["refs"]): KnowledgeEntryRecord => ({
  id,
  tenant: "acme",
  kind: "finding",
  title: `${id} title`,
  body: "…",
  refs,
  evidence: [],
  status: "active",
  visibility: "workspace",
  createdBy: "alice",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
});

describe("IssueLineageService", () => {
  it("walks request → campaign → round → the commits each service took", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: { list: async () => [campaign("cc-1", "i-1")] },
    });
    const lineage = await svc.assemble("acme", "alice", "i-1");

    expect(lineage.campaigns).toHaveLength(1);
    expect(lineage.campaigns[0]?.rounds.map((r) => r.outcome)).toEqual(["rejected", "adopted"]);
    // The rejected attempt is IN the lineage: what failed is what the next attempt was built on.
    expect(lineage.campaigns[0]?.rounds[0]?.answers).toMatchObject({ met: 0, notMet: 1 });
    // One request, several services — flattened so "what did this move" is one list.
    expect(lineage.changes.map((c) => `${c.repository}@${c.commits[0]?.sha}`)).toEqual([
      "acme/widget@aaa1111",
      "acme/widget@bbb2222",
      "acme/api@ccc3333",
    ]);
    expect(lineage.changes.every((c) => c.campaignId === "cc-1")).toBe(true);
  });

  it("reports EVERY way in, not the first — an entry pinning both is reachable both ways", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: { list: async () => [campaign("cc-1", "i-1")] },
      knowledgeEntries: {
        list: async () => [
          entry("k-issue", [{ type: "issue", key: "i-1" }]),
          entry("k-campaign", [{ type: "campaign", key: "cc-1" }]),
          // The common case, and the one that broke: the plugin's skill tells every session to pin the issue,
          // so an entry about a campaign almost always pins both. A first-match `via` reported only "issue"
          // and the campaign edge was invisible exactly where it existed.
          entry("k-both", [
            { type: "issue", key: "i-1" },
            { type: "campaign", key: "cc-1" },
          ]),
          entry("k-elsewhere", [{ type: "issue", key: "i-9" }]),
        ],
      },
    });
    const lineage = await svc.assemble("acme", "alice", "i-1");
    expect(lineage.knowledge.map((k) => [k.id, k.reachedBy.issue, k.reachedBy.campaigns])).toEqual([
      ["k-issue", true, []],
      ["k-campaign", false, ["cc-1"]],
      ["k-both", true, ["cc-1"]],
    ]);
  });

  // The failure this exists to prevent: a deployment with no evolution store answering as though the request
  // had no evaluated campaigns. Absent is a different claim from empty.
  it("says which sources it could not read instead of answering as if they were empty", async () => {
    const svc = new IssueLineageService({ changeCampaigns: { list: async () => [] } });
    const lineage = await svc.assemble("acme", "alice", "i-1");
    expect(lineage.sources).toEqual({
      changeCampaigns: "read",
      evaluatedCampaigns: "unavailable",
      knowledge: "unavailable",
    });
    expect(lineage.campaigns).toEqual([]);
  });
});
