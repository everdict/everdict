import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { planPublicationOperation } from "./publication.js";
import { analysisArtifactKey, analysisPassKey } from "./scorecard-observability.js";

// ── THE EVIDENCE FOR A DELETION (arch-review 55, Wave 7) ─────────────────────────────────────────────
//
// Wave 5 made the analysis alias's monotonic guard three-valued, which was the right fix for the defect in
// front of it and the wrong fix for the effect underneath it: `analyses/<id>.json` cannot be promoted safely
// AT ALL. The position is read from the ledger and the bytes are written to an object store, and there is no
// conditional put to join them — so two settlements draining concurrently can still land newest-first, and
// no guard expressible here closes that.
//
// The deletion is licensed by a stronger fact than "the race is hard": the promotion was WRITE-ONLY.
//
//   · the alias was promoted iff staging produced `revisionKey` — the same value the settle records on the
//     revision as `analysisKey`;
//   · the reader (`ScorecardAnalyticsService.analysisBundle`) resolves `scoring.at(-1).analysisKey` FIRST and
//     only falls back to the alias when there is none;
//   · so every promotion wrote an object that its own settlement had just made unreachable, and every read
//     that reaches the alias belongs to a revision for which nothing was ever promoted.
//
// `offloadAnalysis`, the alias's only other writer, had already lost its last production caller when the
// staging seam landed. Both are deleted; the alias objects written before this stay where they are and the
// reader's fallback still finds them, which is what makes the deletion safe for history.
//
// These two assertions are what a future reader needs to re-derive that argument — the second one is the
// interesting half, because it is the one that would go red if someone re-introduced the promotion.

const STAGED_KEY = analysisPassKey("sc-1", "pass-1");

describe("a settlement's publication plan (arch-review 55, Wave 7)", () => {
  const plan = (staged: { revisionKey?: string; payloadKey?: string }) =>
    planPublicationOperation({
      scorecardId: "sc-1",
      bundle: { summary: "b" } as never,
      staged,
      passId: "pass-1",
      exports: true,
      results: [],
      scoringRevision: 1,
      now: "2026-08-18T00:00:00.000Z",
    });

  it("owes the export and NOTHING else — the alias promotion is gone", () => {
    const operation = plan({ revisionKey: STAGED_KEY, payloadKey: "payloads/sc-1/pass-1.json" });
    expect(operation?.effects, "a plan with a staged bundle should owe exactly one effect").toHaveLength(1);
    expect(operation?.effects[0]?.kind).toBe("export");
    // The mutable key is not named anywhere in the debt: an operation that cannot reference it cannot move it.
    expect(JSON.stringify(operation)).not.toContain(analysisArtifactKey("sc-1"));
  });

  it("owes nothing at all when there is no sink — a staged bundle is not a debt by itself", () => {
    // Before the deletion this planned an artifact effect, so every batch of a sinkless install carried a
    // publication operation to promote an object nobody reads. The sweep now has one fewer permanent tenant.
    expect(
      planPublicationOperation({
        scorecardId: "sc-1",
        bundle: { summary: "b" } as never,
        staged: { revisionKey: STAGED_KEY },
        passId: "pass-1",
        exports: false,
        results: [],
        scoringRevision: 1,
        now: "2026-08-18T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("still names the bytes it owes by digest — the export half is untouched by the deletion", () => {
    const operation = plan({ revisionKey: STAGED_KEY, payloadKey: "payloads/sc-1/pass-1.json" });
    const effect = operation?.effects[0];
    if (effect?.kind !== "export") throw new Error("expected an export effect");
    expect(effect.payloadDigest).toBe(contentDigest([]));
    expect(effect.idempotencyKey).toBe("sc-1:pass-1");
  });
});
