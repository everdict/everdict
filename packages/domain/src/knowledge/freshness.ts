import type { KnowledgePin } from "@everdict/contracts";
import { compareVersions } from "../registry/version-algebra.js";

// The subject-time kernel of the knowledge layer. Time is a COORDINATE of knowledge, not decay: a claim pinned at
// harness@2.1.0 stays true ABOUT 2.1.0 forever — the question is whether its known-valid interval
// `[pin.version, pin.verifiedVersion]` extends to a given coordinate. Two distinct vocabularies (deliberately not
// merged — they answer different questions):
//   • COVERAGE (record-level, against the entity's PRESENT): does the interval reach the current latest?
//     `current | behind | unverified` — for listings/badges. `behind` means "as-of an earlier point; validity at the
//     present is unknown", never "wrong".
//   • ANCHOR RELATION (per matched record, against an ANCHOR coordinate): where does the interval sit relative to the
//     coordinate a task is projected onto? `covers | earlier | later | general` — for context assembly. The anchor's
//     own version IS the as-of coordinate (an old scorecard's harness@2.1.0 anchor projects the knowledge base onto
//     that point; no separate asOf parameter).
// The caller resolves each pinned family's LATEST version (registries today; a graph-native `succeeds` join can back
// the same resolver later); this kernel is pure — the clock is an argument, never read.

export interface CoverageGap {
  ref: KnowledgePin;
  latest: string; // the entity's present, beyond the pin's known-valid interval
}

// Precedence: behind (an interval ends before the entity's present — extension unknown) > unverified (no recent
// edit/verification on the wall clock) > current. A record with no pinned refs can only be current or unverified.
export type CoverageState = "current" | "behind" | "unverified";

export interface Coverage {
  state: CoverageState;
  gaps: CoverageGap[];
}

// Knowledge accrues silently on the wall clock too — after this many days without an edit or an explicit
// re-verification, a record stops counting as current. Callers may override per surface.
export const DEFAULT_UNVERIFIED_AFTER_DAYS = 30;

const DAY_MS = 86_400_000;

// The end of a pin's known-valid interval along subject time: verifiedVersion when a verify extended it, else the
// original pin (a point interval).
export function intervalEnd(pin: KnowledgePin): string | undefined {
  return pin.verifiedVersion ?? pin.version;
}

export function assessCoverage(
  record: { refs: KnowledgePin[]; verifiedAt?: string; updatedAt: string },
  latestVersionOf: (ref: KnowledgePin) => string | undefined,
  opts: { now: string; unverifiedAfterDays?: number },
): Coverage {
  const gaps: CoverageGap[] = [];
  for (const ref of record.refs) {
    const end = intervalEnd(ref);
    if (end === undefined) continue; // an unversioned pin is a timeless family-wide claim — wall clock governs it
    const latest = latestVersionOf(ref);
    if (latest !== undefined && compareVersions(latest, end) > 0) gaps.push({ ref, latest });
  }
  if (gaps.length > 0) return { state: "behind", gaps };

  // The wall-clock baseline is the LATER of the two signals: an edit is an implicit re-validation (the author just
  // touched the content), and a verification without an edit refreshes an untouched record.
  const verified = record.verifiedAt !== undefined ? Date.parse(record.verifiedAt) : Number.NaN;
  const updated = Date.parse(record.updatedAt);
  const baseline = Number.isFinite(verified) ? Math.max(verified, updated) : updated;
  const ageMs = Date.parse(opts.now) - baseline;
  const limitDays = opts.unverifiedAfterDays ?? DEFAULT_UNVERIFIED_AFTER_DAYS;
  if (Number.isFinite(ageMs) && ageMs > limitDays * DAY_MS) return { state: "unverified", gaps: [] };
  return { state: "current", gaps: [] };
}

// Where a pin's known-valid interval sits relative to an anchor coordinate on the SAME family's version line.
//   covers  — pin.version ≤ anchor ≤ intervalEnd: confirmed knowledge at this coordinate.
//   earlier — the interval ends before the anchor: knowledge about an earlier point; validity here unknown.
//   later   — the pin starts after the anchor: knowledge from this coordinate's future ("fixed in 2.2.0" is a
//             decisive hint when analyzing 2.1.0).
//   general — an unversioned pin: a timeless family-wide claim, applicable at any coordinate.
// Returns undefined when the anchor coordinate itself is unresolved (an unversioned family) — indeterminate, and the
// caller must not rank it below positioned knowledge.
export type AnchorRelation = "covers" | "earlier" | "later" | "general";

export function anchorRelation(pin: KnowledgePin, anchorVersion: string | undefined): AnchorRelation | undefined {
  if (pin.version === undefined) return "general";
  if (anchorVersion === undefined) return undefined;
  if (compareVersions(pin.version, anchorVersion) > 0) return "later";
  const end = intervalEnd(pin);
  if (end !== undefined && compareVersions(end, anchorVersion) < 0) return "earlier";
  return "covers";
}
