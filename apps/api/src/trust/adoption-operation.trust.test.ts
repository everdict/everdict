import { stampFacts } from "@everdict/application-control";
import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import type { CampaignClose, CampaignFrame, EvolutionCampaignRecord } from "@everdict/contracts";
import { PgAdoptionOperationStore, PgEvolutionCampaignStore } from "@everdict/db";
import { contentDigest } from "@everdict/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-184: the adoption operation's two conditional writes and
// its by-issue lookup, against real Postgres (arch-review 73).
//
// The in-memory twin makes the same DECISIONS, so the unit suite pins the refusals. What only the real
// adapter can certify is where those decisions actually live:
//
//   · `markRegistered` / `markCompleted` guard inside the UPDATE's WHERE clause, so two callers presenting
//     one authorization cannot both land — a read-then-write would leave exactly that window, and the twin
//     cannot show the difference because it has no concurrency (rule `testing`: a decision that lives in the
//     adapter is certified against the adapter).
//   · `forIssue` reads the issue out of the stored proof DOCUMENT (`proof ->> 'issueId'`, indexed
//     expressionally by mig 0197) rather than from a duplicated column. That expression is SQL; nothing in a
//     fake client proves Postgres agrees with what we think it means.
//   · and the migration itself applies — this suite migrates the database it is given, so a scenario that
//     runs at all has proved 0197 is applicable.
describe.skipIf(!TRUST_PG_ENABLED)(
  "TRUST-184 — an adoption is spent once and discharged once, on real Postgres",
  () => {
    let pg: TrustPg;
    let campaigns: PgEvolutionCampaignStore;
    let operations: PgAdoptionOperationStore;

    beforeAll(async () => {
      pg = await openTrustPg();
      campaigns = new PgEvolutionCampaignStore(pg.client);
      operations = new PgAdoptionOperationStore(pg.client);
    });
    afterAll(async () => pg?.close());

    const frame: CampaignFrame = {
      subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
      scenarios: [
        { id: "s1", heldOut: true },
        { id: "s2", heldOut: true },
      ],
      judges: [],
      trialsPerCase: 5,
      budget: { maxRounds: 5 },
      stopAfterRejectedRounds: 3,
      significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 }, // frozen: the level, and the family it is corrected over
      allowUnverifiedIdentity: false,
      allowLabelOnlyAdoption: false,
      oracleScope: [],
      observationPolicy: { allowDivergent: false },
    } as unknown as CampaignFrame;

    const proofFor = (campaignId: string, issueId: string): CampaignAdoptionProof => ({
      campaignId,
      frameDigest: "sha256:frame",
      roundSeq: 1,
      candidate: { identity: "exact", type: "agent", id: "everdict", version: "1.0.1", specDigest: "sha256:c1" },
      provingScorecardId: "sc-cand",
      issueId,
      gateDigest: "sha256:gate",
    });

    // A campaign settled `adopted`, with its authorization written in the same statement — the production
    // shape, because an operation reached any other way is not the row this protocol is about.
    async function settled(issueId: string): Promise<{ id: string; proof: CampaignAdoptionProof }> {
      const id = trustId("camp");
      const record: EvolutionCampaignRecord = {
        id,
        tenant: "trust",
        issueId,
        frame,
        frameDigest: "sha256:frame",
        rounds: [],
        state: "open",
        createdBy: "trust",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      };
      await campaigns.create(record);
      const proof = proofFor(id, issueId);
      const close: CampaignClose = {
        outcome: { kind: "adopted", version: "1.0.1", provingScorecardId: "sc-cand", waivedAxes: [] },
        at: "2026-08-27T01:00:00.000Z",
        by: "trust",
      } as unknown as CampaignClose;
      const adoption: AdoptionOperation = {
        operationId: `adopt/trust/${id}`,
        tenant: "trust",
        proof,
        state: "decided",
        createdAt: "2026-08-27T01:00:00.000Z",
        updatedAt: "2026-08-27T01:00:00.000Z",
      };
      const outcome = await campaigns.close("trust", id, "adopted", close, 0, undefined, adoption);
      expect(outcome.kind, "the fixture's close was refused, so this scenario measures nothing").toBe("closed");
      return { id, proof };
    }

    it("SPENDS the authorization exactly once under concurrency", async () => {
      // The property a read-then-write would lose. Both callers present the SAME valid proof at the same
      // moment; the guard lives in the UPDATE's WHERE clause, so exactly one may transition the row.
      const { id, proof } = await settled(trustId("iss"));
      const digest = contentDigest(proof);

      const outcomes = await Promise.all([
        operations.markRegistered("trust", id, digest, "1.0.1"),
        operations.markRegistered("trust", id, digest, "1.0.1"),
      ]);

      expect(
        outcomes.filter((o) => o === "registered"),
        "two writers spent one authorization",
      ).toHaveLength(1);
      expect(outcomes.filter((o) => o === "already_registered")).toHaveLength(1);
      expect((await operations.forCampaign("trust", id))?.registeredVersion).toBe("1.0.1");
    });

    it("DISCHARGES the intent exactly once, and only from `registered`", async () => {
      const { id, proof } = await settled(trustId("iss"));
      const digest = contentDigest(proof);

      // Nothing registered yet — there is no intent to settle, and saying otherwise would hide the
      // settle-then-crash state `decided` exists to make visible.
      expect(
        await operations.markCompleted("trust", id, digest),
        "an unspent authorization was recorded as having settled its intent",
      ).toBe("not_registered");

      await operations.markRegistered("trust", id, digest, "1.0.1");
      const outcomes = await Promise.all([
        operations.markCompleted("trust", id, digest),
        operations.markCompleted("trust", id, digest),
      ]);
      expect(
        outcomes.filter((o) => o === "completed"),
        "two writers discharged one adoption",
      ).toHaveLength(1);
      expect((await operations.forCampaign("trust", id))?.state).toBe("completed");
    });

    it("LANDS the fact with the transition, and NOT with a refused one (arch-review 86)", async () => {
      // The facts ride a CTE gated on the conditional UPDATE. A fake client proves the SQL TEXT contains one;
      // only Postgres proves the text parses, that the gating subquery sees `upd`, and that the outbox insert
      // is skipped when the update matched no row. A CTE that is syntactically wrong fails at execution — the
      // one place a text assertion cannot look.
      //
      // Seen RED with the `WHERE EXISTS (SELECT 1 FROM upd)` dropped: the refused spend wrote its fact anyway.
      const { id, proof } = await settled(trustId("iss"));
      const digest = contentDigest(proof);
      // ⚠️ Shaped by `stampFacts`, not by hand. The first draft omitted `message` — the column the PROJECTOR
      // fills at the choke point (rule `events`) — and real Postgres answered 23502 NOT NULL. A hand-made
      // outbox row is a row production never emits, and the fake-client suite could not have said so.
      const fact = (evId: string, kind: string) =>
        stampFacts(
          "trust",
          [{ kind, subject: { type: "campaign", id }, actor: "trust", payload: { campaignId: id } }] as never,
          { newId: () => evId, now: () => "2026-08-28T00:00:00.000Z" },
        ).map((f) => f.record);
      const factsFor = async (evId: string) =>
        (
          await pg.client.query<{ n: string | number }>(
            "SELECT count(*) AS n FROM everdict_platform_events WHERE id = $1",
            [evId],
          )
        ).rows[0];

      expect(
        await operations.markRegistered(
          "trust",
          id,
          digest,
          "1.0.1",
          fact(trustId("ev-ok"), "campaign.adoption_registered"),
        ),
      ).toBe("registered");

      // The SECOND spend is refused by the guard — and its fact must not exist, or the feed would show an
      // adoption that never happened.
      const refusedId = trustId("ev-refused");
      expect(
        await operations.markRegistered("trust", id, digest, "1.0.1", fact(refusedId, "campaign.adoption_registered")),
      ).toBe("already_registered");
      expect(Number((await factsFor(refusedId))?.n ?? -1), "a refused spend still wrote its fact").toBe(0);

      // …and the completion's CTE, same shape, same guard.
      const completedId = trustId("ev-done");
      expect(
        await operations.markCompleted("trust", id, digest, fact(completedId, "campaign.adoption_completed")),
      ).toBe("completed");
      expect(Number((await factsFor(completedId))?.n ?? -1), "the discharge emitted no fact").toBe(1);
    });

    it("REFUSES either write on a proof the campaign never issued", async () => {
      const { id, proof } = await settled(trustId("iss"));
      await operations.markRegistered("trust", id, contentDigest(proof), "1.0.1");

      expect(await operations.markRegistered("trust", id, "sha256:forged", "9.9.9")).toBe("proof_mismatch");
      expect(await operations.markCompleted("trust", id, "sha256:forged")).toBe("proof_mismatch");
      expect((await operations.forCampaign("trust", id))?.state).toBe("registered");
    });

    it("finds an ISSUE's authorizations through the stored proof document", async () => {
      // The jsonb expression mig 0197 indexes. A duplicated column would be a second copy of a value the
      // proof already owns, and this is the read that would have justified one.
      const issue = trustId("iss");
      const a = await settled(issue);
      const b = await settled(issue); // one issue, two campaigns over its life
      const elsewhere = await settled(trustId("iss"));

      const found = (await operations.forIssue("trust", issue)).map((o) => o.proof.campaignId).sort();
      expect(found).toEqual([a.id, b.id].sort());
      expect(found).not.toContain(elsewhere.id);
      expect(await operations.forIssue("trust", trustId("nobody"))).toEqual([]);
    });

    it("answers ANOTHER WORKSPACE nothing at all", async () => {
      // Tenancy in the statement, not in the caller. The in-memory twin ignored this argument for two waves
      // (arch-review 74); here it is the WHERE clause that has to carry it.
      const { id, proof } = await settled(trustId("iss"));
      const digest = contentDigest(proof);

      expect(await operations.forCampaign("other", id)).toBeUndefined();
      expect(await operations.forIssue("other", proof.issueId)).toEqual([]);
      expect(await operations.markRegistered("other", id, digest, "1.0.1")).toBe("no_such_operation");
      expect(await operations.markCompleted("other", id, digest)).toBe("no_such_operation");
      expect((await operations.forCampaign("trust", id))?.state, "another workspace moved this row").toBe("decided");
    });
  },
);
