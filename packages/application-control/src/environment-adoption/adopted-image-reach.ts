import { parseImageRef } from "@everdict/domain";
import type { AdoptedEnvironmentView } from "./environment-adoption-service.js";

// M6 — cross-tenant pull, the reach half. Answers "may this workspace pull an image that lives in ANOTHER
// workspace's managed namespace?" and is handed to `ManagedImageStore` as its `crossTenantPull` predicate.
//
// The answer is bounded by ADOPTION on purpose. The design's rule is that a scope is granted only for a ref a
// consumable capability DECLARES — pointing a pull grant at an arbitrary repository in someone else's namespace
// is not a request we can satisfy. Adoption is exactly that declaration made explicit: the workspace took a
// dependency on a published environment, and `list()` recomputes `available` through `canConsumeCapability` on
// every read, so reach that was revoked upstream stops authorizing pulls without anything to invalidate here.
// Design: docs/architecture/managed-image-store.md
export interface AdoptedImageReachDeps {
  // EnvironmentAdoptionService.list — the inventory with LIVE consumability already resolved per entry.
  list: (workspace: string, subject: string) => Promise<AdoptedEnvironmentView[]>;
}

// The subject a reach question is asked as. A cross-tenant decision never reads `createdBy`: the only tiers that
// cross a workspace boundary are `public` (everyone) and `subset` (an explicit workspace list), and neither is
// per-member. So the reach answer is a property of the WORKSPACE, and a placeholder subject cannot widen it —
// which is what lets this run on the pull path, where only the tenant is known.
const REACH_SUBJECT = "everdict-image-reach";

export function adoptedImageReach(deps: AdoptedImageReachDeps): (tenant: string, ref: string) => Promise<boolean> {
  return async (tenant, ref) => {
    const target = repositoryOf(ref);
    if (!target) return false;
    // An inventory that cannot be read denies rather than throws: a failed lookup must not fail the job, and the
    // pull then reports the registry's own 401 — the same outcome as having no reach at all.
    const inventory = await deps.list(tenant, REACH_SUBJECT).catch(() => []);
    return inventory.some((entry) => entry.available && entry.image && repositoryOf(entry.image) === target);
  };
}

// Compare by host + repository path, not by the whole ref: a job may pull the digest the capability pinned, a tag
// that resolves to it, or the bare repository, and all three are the same grant scope. Tag-level precision would
// buy nothing — the grant is issued per repository either way.
function repositoryOf(ref: string): string | undefined {
  try {
    const parsed = parseImageRef(ref);
    return parsed.host ? `${parsed.host}/${parsed.path}` : undefined;
  } catch {
    return undefined;
  }
}
