import type { ChangeCampaignRecord, KnowledgeEntryRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { IssueLineageService } from "./issue-lineage-service.js";

// The lineage read composes three optional sources, so the two things it must not do are: lose an edge that
// exists, and let a source it could not read look like a request that had nothing.

const campaign = (id: string, issueId: string, continues?: string): ChangeCampaignRecord => ({
  id,
  tenant: "acme",
  issueId,
  service: { repository: "acme/widget" },
  criteria: [{ id: "tests", statement: "green", judges: { kind: "requirement", issueId } }],
  rounds: [
    {
      seq: 1,
      hypothesis: "first try",
      changes: [{ repository: "acme/widget", commits: [{ sha: "aaa1111" }] }],
      gateRuns: [{ id: "gates", command: "pnpm test", exitCode: 0, metrics: [{ name: "tests.passed", value: 10 }] }],
      judgement: {
        at: "2026-09-17T00:00:00.000Z",
        by: "agent:builder",
        answers: [
          {
            criterionId: "tests",
            answer: "not_met",
            how: "observed",
            gateRunIds: ["gates"],
            reason: "attempted_and_failed",
          },
        ],
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
  ...(continues !== undefined ? { continues } : {}),
  createdBy: "alice",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T02:00:00.000Z",
});

const entry = (id: string, refs: KnowledgeEntryRecord["refs"], supersedes?: string): KnowledgeEntryRecord => ({
  id,
  tenant: "acme",
  kind: "finding",
  title: `${id} title`,
  body: "…",
  refs,
  evidence: [],
  status: "active",
  visibility: "workspace",
  ...(supersedes !== undefined ? { supersedes } : {}),
  createdBy: "alice",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
});

describe("IssueLineageService", () => {
  it("walks request → campaign → round → the commits each service took", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: { list: async () => [campaign("cc-1", "i-1")], get: async () => undefined },
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
      changeCampaigns: { list: async () => [campaign("cc-1", "i-1")], get: async () => undefined },
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
    const svc = new IssueLineageService({ changeCampaigns: { list: async () => [], get: async () => undefined } });
    const lineage = await svc.assemble("acme", "alice", "i-1");
    expect(lineage.sources).toEqual({
      changeCampaigns: "read",
      evaluatedCampaigns: "unavailable",
      knowledge: "unavailable",
    });
    expect(lineage.campaigns).toEqual([]);
  });
  // ── THE WALK ───────────────────────────────────────────────────────────────────────────────────────
  //
  // Each of these fails on the pre-change code for its own reason: the chain fields were stored, one of them
  // was even emitted, and `assemble` followed none of them.

  it("does not follow the chain at depth 1 — the original one-hop answer is unchanged", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: {
        list: async () => [campaign("cc-2", "i-1", "cc-1")],
        get: async (_t, id) => (id === "cc-1" ? campaign("cc-1", "i-0") : undefined),
      },
    });
    const lineage = await svc.assemble("acme", "alice", "i-1");
    expect(lineage.campaigns.map((c) => c.id)).toEqual(["cc-2"]);
    // The chain is REPORTED even when it is not walked, so a reader can tell "it ends here" from "I stopped".
    expect(lineage.campaigns[0]?.continues).toBe("cc-1");
    expect(lineage.walk).toEqual({ requested: 1, reached: 1, truncated: true, cycles: 0, unresolved: 0 });
  });

  it("walks `continues` back to the campaign whose remainder this one picked up", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: {
        list: async () => [campaign("cc-3", "i-1", "cc-2")],
        get: async (_t, id) =>
          id === "cc-2" ? campaign("cc-2", "i-0", "cc-1") : id === "cc-1" ? campaign("cc-1", "i-0") : undefined,
      },
    });
    const lineage = await svc.assemble("acme", "alice", "i-1", { depth: 3 });
    expect(lineage.campaigns.map((c) => [c.id, c.depth])).toEqual([
      ["cc-3", 1],
      ["cc-2", 2],
      ["cc-1", 3],
    ]);
    // The ancestors' commits are part of "how this came to be", so they join the flattened change list.
    expect(lineage.changes.filter((c) => c.campaignId === "cc-1")).not.toHaveLength(0);
    expect(lineage.walk).toMatchObject({ requested: 3, reached: 3, truncated: false });
  });

  it("walks `supersedes` to the claim that was corrected, and says which entry replaced it", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: { list: async () => [], get: async () => undefined },
      knowledgeEntries: {
        list: async () => [
          entry("k-new", [{ type: "issue", key: "i-1" }], "k-old"),
          // The retracted ancestor pins NOTHING about this request — it is history only because something
          // replaced it, which is exactly the edge a flat read cannot express.
          entry("k-old", [{ type: "issue", key: "i-9" }]),
        ],
      },
    });
    const shallow = await svc.assemble("acme", "alice", "i-1");
    expect(shallow.knowledge.map((k) => k.id)).toEqual(["k-new"]);
    expect(shallow.walk.truncated).toBe(true);

    const deep = await svc.assemble("acme", "alice", "i-1", { depth: 2 });
    expect(deep.knowledge.map((k) => [k.id, k.depth])).toEqual([
      ["k-new", 1],
      ["k-old", 2],
    ]);
    expect(deep.knowledge[1]?.reachedBy).toEqual({ issue: false, campaigns: [], supersededBy: "k-new" });
    expect(deep.walk).toEqual({ requested: 2, reached: 2, truncated: false, cycles: 0, unresolved: 0 });
  });

  it("stops on a cycle and COUNTS it — a chain pointing at itself is a defect in the records", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: {
        list: async () => [campaign("cc-a", "i-1", "cc-b")],
        get: async (_t, id) =>
          id === "cc-b" ? campaign("cc-b", "i-0", "cc-a") : id === "cc-a" ? campaign("cc-a", "i-1", "cc-b") : undefined,
      },
    });
    const lineage = await svc.assemble("acme", "alice", "i-1", { depth: 5 });
    expect(lineage.campaigns.map((c) => c.id)).toEqual(["cc-a", "cc-b"]);
    expect(lineage.walk).toMatchObject({ cycles: 1, truncated: false });
  });

  it("counts a chain step it could not fetch instead of ending the chain quietly", async () => {
    const svc = new IssueLineageService({
      changeCampaigns: {
        list: async () => [campaign("cc-9", "i-1", "cc-gone")],
        get: async () => undefined, // the predecessor is not readable here
      },
    });
    const lineage = await svc.assemble("acme", "alice", "i-1", { depth: 3 });
    expect(lineage.campaigns.map((c) => c.id)).toEqual(["cc-9"]);
    // NOT `truncated` — the depth had room. The chain named something this read could not get to.
    expect(lineage.walk).toMatchObject({ unresolved: 1, truncated: false, reached: 1 });
  });

  it("refuses a depth outside the range rather than clamping it", async () => {
    const svc = new IssueLineageService({ changeCampaigns: { list: async () => [], get: async () => undefined } });
    await expect(svc.assemble("acme", "alice", "i-1", { depth: 50 })).rejects.toThrow(/depth must be an integer/);
    await expect(svc.assemble("acme", "alice", "i-1", { depth: 0 })).rejects.toThrow(/depth must be an integer/);
  });
});
