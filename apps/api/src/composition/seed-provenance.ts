import type {
  KnowledgeEntryStore,
  ScorecardStore,
  SeedProvenanceReader,
  SkillVersionStore,
} from "@everdict/application-control";
import { AppError, type HarnessSeeds, readOk, readUnknown } from "@everdict/contracts";
import type { SeedEvidence } from "@everdict/domain";
import type { HarnessInstanceRegistry } from "@everdict/registry";

// ── WHAT A CANDIDATE'S SEEDS WERE BORN FROM (docs/architecture/harness-identity-and-seeds-spec.md §4) ──
//
// A named function in `composition/` (not a literal in main.ts) for the reason the adoption wiring is: a
// closure in the root is production code no test can reach. Every read a decision rests on answers
// `ReadResult`; a store that throws answers `unknown` with its reason, never an empty list.
export function buildSeedProvenance(deps: {
  harnesses: Pick<HarnessInstanceRegistry, "get">;
  skillVersions: Pick<SkillVersionStore, "get">;
  knowledgeEntries: Pick<KnowledgeEntryStore, "get">;
  scorecards: Pick<ScorecardStore, "get">;
}): SeedProvenanceReader {
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  return {
    async seedsOf(tenant, harness) {
      try {
        const resolved = await deps.harnesses.get(tenant, harness.id, harness.version);
        return readOk(resolved.seeds);
      } catch (err) {
        if (err instanceof AppError && err.status === 404) return { kind: "absent" };
        return readUnknown(reason(err));
      }
    },
    async evidenceOf(tenant, seeds: HarnessSeeds) {
      try {
        // Which scorecards each seed's evidence names — a skill's `refs`, a knowledge entry's `evidence`.
        const named: Array<{ seed: string; scorecardId: string }> = [];
        for (const seed of seeds.skills) {
          const stamped = await deps.skillVersions.get(tenant, seed.id, seed.version);
          for (const ref of stamped?.refs ?? [])
            if (ref.type === "scorecard")
              named.push({ seed: `skill:${seed.id}@${seed.version}`, scorecardId: ref.key });
        }
        for (const seed of seeds.knowledge) {
          const entry = await deps.knowledgeEntries.get(tenant, seed.id);
          for (const ref of entry?.evidence ?? [])
            if (ref.type === "scorecard") named.push({ seed: `knowledge:${seed.id}`, scorecardId: ref.key });
        }
        // …and the cases each of those scorecards covered. A scorecard of another workspace, or a missing one,
        // covers nothing here — it is not this exam.
        const evidence: SeedEvidence[] = [];
        for (const n of named) {
          const record = await deps.scorecards.get(n.scorecardId);
          if (record === undefined || record.tenant !== tenant) continue;
          const caseIds = [...new Set((record.scorecard?.results ?? []).map((r) => r.caseId))];
          evidence.push({ seed: n.seed, scorecardId: n.scorecardId, caseIds });
        }
        return readOk(evidence);
      } catch (err) {
        return readUnknown(reason(err));
      }
    },
  };
}
