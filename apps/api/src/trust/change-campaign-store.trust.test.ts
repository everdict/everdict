import type { ChangeCampaignRecord, ChangeRound } from "@everdict/contracts";
import { PgChangeCampaignStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — the `change` grade's two conditional writes against real Postgres.
//
// Written because the unit suite could not have caught what shipped: `updated_at = $5` in a statement whose
// `$5` was already pinned to TEXT by `to_jsonb($5::text)`, which Postgres refuses outright. The in-memory
// twin never sees SQL, and the fake SqlClient binds nothing — a fake cannot disagree about a type it never
// sent. The bug appeared on the first call made against a real database, from a script, after the suite was
// green. This is that script, as a scenario.
//
// What it certifies beyond "the statement parses": that `round_count = $3` is the compare and the jsonb
// append is the swap in ONE statement (a loser writes nothing rather than clobbering the winner's round), and
// that the close is once.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST — the change campaign's conditional writes, on real Postgres", () => {
  let pg: TrustPg;
  let store: PgChangeCampaignStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    store = new PgChangeCampaignStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const campaignOf = (id: string): ChangeCampaignRecord => ({
    id,
    tenant: "acme",
    issueId: `issue-${id}`,
    service: { repository: "acme/widget" },
    criteria: [
      { id: "tests", statement: "the suite is green", judges: { kind: "quality" } },
      { id: "it-works", statement: "the request is answered", judges: { kind: "requirement", issueId: `issue-${id}` } },
    ],
    rounds: [],
    state: "open",
    createdBy: "agent:builder",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  });

  const roundOf = (seq: number, sha: string): ChangeRound => ({
    seq,
    hypothesis: `attempt ${seq}`,
    changes: [{ repository: "acme/widget", commits: [{ sha }] }],
    gateRuns: [{ id: "tests", command: "pnpm test", exitCode: 0, metrics: [{ name: "tests.passed", value: 4027 }] }],
    judgement: {
      at: "2026-09-17T01:00:00.000Z",
      by: "agent:builder",
      answers: [{ criterionId: "tests", answer: "met", how: "observed", gateRunIds: ["tests"] }],
    },
    outcome: "adopted",
  });

  it("round-trips a campaign whose timestamps are ISO strings, which is where the shipped bug lived", async () => {
    const id = trustId("cc");
    await store.create(campaignOf(id));
    const at = "2026-09-17T02:00:00.000Z";

    // The statement that was rejected in production: the same parameter serving `to_jsonb($5::text)` and a
    // timestamptz column. Green here means the cast is present, not merely that the code compiles.
    expect(await store.appendRound("acme", id, roundOf(1, trustId("sha")), 0, at)).toBe(true);

    const read = await store.get("acme", id);
    expect(read?.rounds).toHaveLength(1);
    expect(read?.updatedAt).toContain("2026-09-17"); // the column accepted it AND the body carries it
    expect(read?.rounds[0]?.gateRuns[0]?.metrics[0]?.value).toBe(4027); // the numbers survive serialization
  });

  it("is a compare-and-swap: the loser writes nothing, and `seq` stays contiguous", async () => {
    const id = trustId("cc");
    await store.create(campaignOf(id));
    const at = "2026-09-17T03:00:00.000Z";

    expect(await store.appendRound("acme", id, roundOf(1, trustId("sha")), 0, at)).toBe(true);
    // A second logger that read the campaign before the first landed expects zero rounds too.
    expect(await store.appendRound("acme", id, roundOf(1, trustId("sha")), 0, at)).toBe(false);

    const read = await store.get("acme", id);
    expect(read?.rounds.map((r) => r.seq)).toEqual([1]); // the loser's round is absent, not appended out of order
  });

  it("closes once, and a second close writes nothing", async () => {
    const id = trustId("cc");
    await store.create(campaignOf(id));
    const close = {
      at: "2026-09-17T04:00:00.000Z",
      by: "alice",
      state: "adopted" as const,
      reason: "criteria met",
      roundSeq: 1,
      knowledge: ["k-1"],
      landed: [],
      remaining: [],
    };
    expect(await store.close("acme", id, close, close.at)).toBe(true);
    expect(await store.close("acme", id, { ...close, reason: "again" }, close.at)).toBe(false);

    const read = await store.get("acme", id);
    expect(read?.state).toBe("adopted");
    expect(read?.close?.reason).toBe("criteria met"); // the first ending, not the second
  });

  it("refuses to append to a campaign that has ended", async () => {
    const id = trustId("cc");
    await store.create(campaignOf(id));
    const at = "2026-09-17T05:00:00.000Z";
    await store.close(
      "acme",
      id,
      { at, by: "alice", state: "abandoned", reason: "wrong approach", knowledge: ["k-2"], landed: [], remaining: [] },
      at,
    );
    expect(await store.appendRound("acme", id, roundOf(1, trustId("sha")), 0, at)).toBe(false);
  });

  it("another workspace's campaign reads as nonexistent", async () => {
    const id = trustId("cc");
    await store.create(campaignOf(id));
    expect(await store.get("other", id)).toBeUndefined();
    expect(await store.list("other")).toEqual(expect.not.arrayContaining([expect.objectContaining({ id })]));
  });
});
