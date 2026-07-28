import type { NodeRef } from "@everdict/contracts";
import { compareVersions } from "../registry/version-algebra.js";

// Freshness assessment for knowledge-layer records (skills + knowledge entries) — the pure kernel behind
// "a skill is stale ⟺ an `about` target has a newer version". The caller resolves each pinned ref's LATEST version
// (from the registries today; a graph-native `succeeds` join can back the same resolver later) and this kernel does
// the version algebra + verification-age policy. Pure: the clock is an argument, never read.

export interface StaleRef {
  ref: NodeRef;
  latest: string; // the newer version that superseded the pinned one
}

// Precedence: superseded refs (the procedure/claim's subject moved on) > unverified (nobody has confirmed it recently)
// > fresh. A record with no pinned refs can only ever be fresh or unverified.
export type FreshnessState = "fresh" | "superseded_refs" | "unverified";

export interface Freshness {
  state: FreshnessState;
  staleRefs: StaleRef[];
}

// Knowledge rots even when untouched — after this many days without an update or an explicit re-verification, a
// record stops counting as fresh. Callers may override per surface.
export const DEFAULT_UNVERIFIED_AFTER_DAYS = 30;

const DAY_MS = 86_400_000;

export function assessFreshness(
  record: { refs: NodeRef[]; verifiedAt?: string; updatedAt: string },
  latestVersionOf: (ref: NodeRef) => string | undefined,
  opts: { now: string; unverifiedAfterDays?: number },
): Freshness {
  const staleRefs: StaleRef[] = [];
  for (const ref of record.refs) {
    if (ref.version === undefined) continue; // an unpinned ref carries no staleness contract
    const latest = latestVersionOf(ref);
    if (latest !== undefined && compareVersions(latest, ref.version) > 0) staleRefs.push({ ref, latest });
  }
  if (staleRefs.length > 0) return { state: "superseded_refs", staleRefs };

  // The freshness baseline is the LATER of the two signals: an edit is an implicit re-validation (the author just
  // touched the content), and a verification without an edit refreshes an untouched record.
  const verified = record.verifiedAt !== undefined ? Date.parse(record.verifiedAt) : Number.NaN;
  const updated = Date.parse(record.updatedAt);
  const baseline = Number.isFinite(verified) ? Math.max(verified, updated) : updated;
  const ageMs = Date.parse(opts.now) - baseline;
  const limitDays = opts.unverifiedAfterDays ?? DEFAULT_UNVERIFIED_AFTER_DAYS;
  if (Number.isFinite(ageMs) && ageMs > limitDays * DAY_MS) return { state: "unverified", staleRefs: [] };
  return { state: "fresh", staleRefs: [] };
}
