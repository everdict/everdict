import type {
  CapabilityOrigin,
  EvolutionCampaignRecord,
  HarnessSeeds,
  HarnessSpec,
  HarnessSpecDiff,
} from "@everdict/contracts";
import { contentDigest, diffHarnessSpecs } from "@everdict/domain";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";

// ── LINEAGE IS ONE READ (docs/architecture/harness-identity-and-seeds-spec.md §3) ────────────────────
//
// "Where did this version come from, what changed, what did it ship with, and which campaign proved it" took three
// reads — the registry's origins, the version diff, the campaign list — and nobody composed them. This does, per
// version, from reads that already exist: no new store, one service function, two transports.
export interface HarnessLineageVersion {
  version: string;
  specDigest: string; // the resolved document's digest — the identity a scorecard manifest seals
  tags: string[];
  origin?: CapabilityOrigin; // the birth stamp, verbatim
  // The version this one continues — the origin's same-family `from` when it was stamped (a re-pin, an adoption),
  // else the previous version in the registry's order, and the answer says which.
  predecessor?: { version: string; via: "origin" | "order" };
  forkedFrom?: { id: string; version: string; specDigest: string }; // another id's version this was copied from (§1)
  bornFrom?: CapabilityOrigin["from"]; // the intent — an issue, a scorecard, a run — when the origin names one
  seeds?: HarnessSeeds; // what the version ships with (§2)
  // What moved against the predecessor: the resolved-spec diff, and the slots those paths belong to.
  diff?: { summary: HarnessSpecDiff["summary"]; slots: string[]; changes: HarnessSpecDiff["changes"] };
  adoptedBy?: Array<{ campaignId: string; issueId: string; provingScorecardId: string }>;
}
export interface HarnessLineage {
  id: string;
  versions: HarnessLineageVersion[];
  // `adoptions` is answered only when a campaign reader was wired; absent means "not asked", never "none".
  adoptionsKnown: boolean;
}

export interface HarnessLineageDeps {
  instances: Pick<HarnessInstanceRegistry, "versions" | "get" | "list">;
  // The campaigns whose subject is this harness — the adoption side of the lineage. Optional at the ROOT (a
  // deployment may run without campaigns); the response says whether it was asked.
  campaigns?: {
    forSubject(
      tenant: string,
      subject: { type: "harness"; id: string },
    ): Promise<ReadonlyArray<EvolutionCampaignRecord>>;
  };
}

// The slot a resolved-spec diff path belongs to: `services[web].image` → `web`; a top-level key otherwise.
export function slotOfPath(path: string): string {
  const svc = /^services\[([^\]]+)\]/.exec(path);
  if (svc?.[1] !== undefined) return svc[1];
  const head = /^([A-Za-z0-9_-]+)/.exec(path);
  return head?.[1] ?? path;
}

export async function harnessLineage(deps: HarnessLineageDeps, tenant: string, id: string): Promise<HarnessLineage> {
  const versions = await deps.instances.versions(tenant, id);
  const entry = (await deps.instances.list(tenant)).find((e) => e.id === id);
  const origins = entry?.versionOrigins ?? {};
  const tags = entry?.versionTags ?? {};
  const resolved = new Map<string, HarnessSpec>();
  for (const v of versions) resolved.set(v, await deps.instances.get(tenant, id, v));
  const adoptions = new Map<string, Array<{ campaignId: string; issueId: string; provingScorecardId: string }>>();
  if (deps.campaigns !== undefined)
    for (const c of await deps.campaigns.forSubject(tenant, { type: "harness", id })) {
      const outcome = c.close?.outcome;
      if (outcome?.kind !== "adopted") continue;
      adoptions.set(outcome.version, [
        ...(adoptions.get(outcome.version) ?? []),
        { campaignId: c.id, issueId: c.issueId, provingScorecardId: outcome.provingScorecardId },
      ]);
    }
  const out: HarnessLineageVersion[] = [];
  for (const [index, version] of versions.entries()) {
    const spec = resolved.get(version);
    if (spec === undefined) continue;
    const origin = origins[version];
    const from = origin?.from;
    const sameFamily = from !== undefined && from.type === "harness" && from.id === id && from.version !== undefined;
    const predecessor =
      sameFamily && from.version !== undefined
        ? { version: from.version, via: "origin" as const }
        : index > 0 && versions[index - 1] !== undefined
          ? { version: versions[index - 1] as string, via: "order" as const }
          : undefined;
    const prev = predecessor !== undefined ? resolved.get(predecessor.version) : undefined;
    const diff = prev !== undefined ? diffHarnessSpecs(prev, spec) : undefined;
    const adopted = adoptions.get(version);
    out.push({
      version,
      specDigest: contentDigest(spec),
      tags: tags[version] ?? [],
      ...(origin !== undefined ? { origin } : {}),
      ...(predecessor !== undefined ? { predecessor } : {}),
      ...(origin?.forkedFrom !== undefined ? { forkedFrom: origin.forkedFrom } : {}),
      ...(from !== undefined && !sameFamily ? { bornFrom: from } : {}),
      ...(spec.seeds !== undefined ? { seeds: spec.seeds } : {}),
      ...(diff !== undefined
        ? {
            diff: {
              summary: diff.summary,
              slots: [...new Set(diff.changes.map((c) => slotOfPath(c.path)))].sort(),
              changes: diff.changes,
            },
          }
        : {}),
      ...(adopted !== undefined ? { adoptedBy: adopted } : {}),
    });
  }
  return { id, versions: out, adoptionsKnown: deps.campaigns !== undefined };
}
