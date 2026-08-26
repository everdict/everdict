import type { CampaignFrame, CampaignRound, EvolutionCampaignRecord } from "@everdict/contracts";
import { PgEvolutionCampaignStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-183: the campaign settlement's append CAS against real Postgres
// (evolution-lineage Track D, the real-PG rung the design doc owed).
//
// The in-memory twin makes the SAME decisions, so the unit suite exercises the refusals — what only the real
// adapter can certify is the STATEMENT: that `rounds || $round` under `jsonb_array_length(rounds) = $n` is a
// compare-and-swap with no read-then-write window, and that the outbox fact rides that same statement — a
// fact for a round that lost its race must not exist, and a landed round's fact must (rule `events`, E0).
//
// Seen RED with the events CTE detached from the update (fact landed for a refused append): the fake-client
// suite pins the SQL text; this is the endpoint saying the text means what it says.
describe.skipIf(!TRUST_PG_ENABLED)(
  "TRUST-183 — the campaign round CAS and its fact land together, on real Postgres",
  () => {
    let pg: TrustPg;
    let store: PgEvolutionCampaignStore;

    beforeAll(async () => {
      pg = await openTrustPg();
      store = new PgEvolutionCampaignStore(pg.client);
    });
    afterAll(async () => pg?.close());

    const frame: CampaignFrame = {
      subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
      scenarios: [
        { id: "s1", heldOut: false },
        { id: "s2", heldOut: true },
      ],
      judges: [],
      trialsPerCase: 5,
      budget: { maxRounds: 5 },
      stopAfterRejectedRounds: 3,
      significance: {},
      allowUnverifiedIdentity: false,
    };

    const record = (id: string): EvolutionCampaignRecord => ({
      id,
      tenant: "trust",
      issueId: "iss_trust",
      frame,
      frameDigest: "sha256:frame",
      rounds: [],
      state: "open",
      createdBy: "trust",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    });

    const round = (seq: number): CampaignRound => ({
      seq,
      hypothesis: "structure over phrasing",
      candidateVersion: `1.0.${seq}`,
      baselineScorecardId: "sc-base",
      candidateScorecardId: `sc-cand-${seq}`,
      verdict: { comparable: true, significantImprovements: 1, significantRegressions: 0, unverifiedAxes: [] },
      at: "2026-08-26T00:00:00.000Z",
      by: "agent:everdict",
    });

    const event = (id: string, campaignId: string) => ({
      id,
      tenant: "trust",
      kind: "campaign.round_logged" as const,
      subject: { type: "campaign", id: campaignId },
      payload: {},
      message: "round logged",
      createdAt: "2026-08-26T00:00:00.000Z",
    });

    const eventCount = async (campaignId: string): Promise<number> => {
      const { rows } = await pg.client.query<{ n: string }>(
        "SELECT count(*) AS n FROM everdict_platform_events WHERE tenant='trust' AND subject_id=$1",
        [campaignId],
      );
      return Number(rows[0]?.n ?? 0);
    };

    it("two writers racing one expected count: exactly one round lands, and exactly one fact exists", async () => {
      const id = trustId("evc");
      await store.create(record(id));
      // Both writers read the empty campaign and append against expectedRounds = 0 — the CAS is the WHERE
      // clause of one UPDATE, so Postgres serializes them and the loser's statement matches zero rows.
      const [a, b] = await Promise.all([
        store.appendRound("trust", id, round(1), 0, [event(trustId("ev"), id)]),
        store.appendRound("trust", id, round(1), 0, [event(trustId("ev"), id)]),
      ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["appended", "conflict"]);
      const after = await store.get("trust", id);
      expect(after?.rounds).toHaveLength(1);
      // The loser's fact must not exist: the outbox insert is gated on the SAME statement's update landing.
      expect(await eventCount(id)).toBe(1);
    });

    it("a closed campaign refuses the append as terminal and writes no fact", async () => {
      const id = trustId("evc");
      await store.create(record(id));
      await store.close("trust", id, "no_improvement", {
        outcome: { kind: "halted", reason: "no_improvement", detail: "dry" },
        at: "2026-08-26T01:00:00.000Z",
        by: "trust",
      });
      const refused = await store.appendRound("trust", id, round(1), 0, [event(trustId("ev"), id)]);
      expect(refused).toEqual({ kind: "terminal", state: "no_improvement" });
      expect(await eventCount(id)).toBe(0);
    });
  },
);
