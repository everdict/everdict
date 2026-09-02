import { AppError, type CapabilityOriginFork, ConflictError, NotFoundError } from "@everdict/contracts";
import { digestUnder } from "@everdict/domain";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";

// ── A FORK NAMES BYTES IT CAME FROM (docs/architecture/harness-identity-and-seeds-spec.md §1) ─────────
//
// Verified where the fork is DECLARED — the register door, both transports — and refused rather than annotated:
// the named version must resolve (this workspace or `_shared`), and its resolved document must digest to what
// the fork claims. Deriving forks afterwards by similarity would be provenance re-derived from rendered output
// (rule `protocol` L3); a fork is a fact the forker knows at the moment of forking, or nowhere.
export async function verifyForkLineage(
  instances: Pick<HarnessInstanceRegistry, "get">,
  tenant: string,
  fork: CapabilityOriginFork,
): Promise<void> {
  let parent: unknown;
  try {
    parent = await instances.get(tenant, fork.id, fork.version);
  } catch (err) {
    if (err instanceof AppError && err.status === 404)
      throw new NotFoundError(
        "NOT_FOUND",
        { forkedFrom: `${fork.id}@${fork.version}` },
        `this fork names ${fork.id}@${fork.version}, which does not resolve in this workspace — a fork points at a version that exists`,
      );
    throw err;
  }
  // `digestUnder`, so a fork declared against a version sealed under an older algorithm still verifies.
  const held = digestUnder(fork.specDigest, parent);
  if (held !== fork.specDigest)
    throw new ConflictError(
      "CONFLICT",
      { forkedFrom: `${fork.id}@${fork.version}`, named: fork.specDigest, held },
      `this fork says ${fork.id}@${fork.version} digests to ${fork.specDigest}, and it resolves to ${held} — a fork names the bytes it came from, or it is not recorded`,
    );
}
