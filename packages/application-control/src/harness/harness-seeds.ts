import { ConflictError, type HarnessSeeds, NotFoundError } from "@everdict/contracts";
import {
  type SeedFile,
  knowledgeSeedDigest,
  knowledgeSeedFile,
  skillSeedDigest,
  skillSeedFiles,
} from "@everdict/domain";

// ── MATERIALIZING A VERSION'S SEEDS (docs/architecture/harness-identity-and-seeds-spec.md §2) ────────
//
// The harness version named exact bytes; this reads them from the workspace's own records and REFUSES when
// they are not there or no longer digest to what was named. A seed whose content moved under a fixed version is
// not that version (rule `protocol` L4) — the run is refused rather than run with different skills under the
// same `specDigest`. A reader failure propagates: an outage is not an absence.
export interface SeedReader {
  skillVersion(
    tenant: string,
    id: string,
    version: string,
  ): Promise<{ instructions: string; files: ReadonlyArray<{ path: string; content: string }> } | undefined>;
  knowledgeEntry(tenant: string, id: string): Promise<{ title: string; body: string } | undefined>;
}

export async function materializeSeeds(tenant: string, seeds: HarnessSeeds, reader: SeedReader): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const seed of seeds.skills) {
    const version = await reader.skillVersion(tenant, seed.id, seed.version);
    if (version === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { seed: `skill:${seed.id}@${seed.version}` },
        `the harness version seeds skill ${seed.id}@${seed.version}, which this workspace does not hold — the run is refused rather than started without it`,
      );
    const held = skillSeedDigest(version);
    if (held !== seed.digest)
      throw new ConflictError(
        "CONFLICT",
        { seed: `skill:${seed.id}@${seed.version}`, named: seed.digest, held },
        `skill ${seed.id}@${seed.version} no longer digests to what the harness version named — its bytes moved under a fixed version; register a harness version that names the current digest`,
      );
    files.push(...skillSeedFiles(seed.id, version));
  }
  for (const seed of seeds.knowledge) {
    const entry = await reader.knowledgeEntry(tenant, seed.id);
    if (entry === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { seed: `knowledge:${seed.id}` },
        `the harness version seeds knowledge entry ${seed.id}, which this workspace does not hold — the run is refused rather than started without it`,
      );
    const held = knowledgeSeedDigest(entry);
    if (held !== seed.digest)
      throw new ConflictError(
        "CONFLICT",
        { seed: `knowledge:${seed.id}`, named: seed.digest, held },
        `knowledge entry ${seed.id} no longer digests to what the harness version named — register a harness version that names the current digest`,
      );
    files.push(knowledgeSeedFile(seed.id, entry));
  }
  return files;
}
