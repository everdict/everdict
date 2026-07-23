import { createHash } from "node:crypto";
import type { DispatchManifest, StoreFixture } from "@everdict/contracts";

// Build a dispatched case's audit manifest for the sealed recording. Records a stable content hash of the case's
// world-state fixtures (P2) so the recording is self-describing — it says WHAT data the run was seeded with, for
// audit/reproducibility. Absent fixtures → a harness-only manifest. docs/architecture/dependency-store-roles.md
export function dispatchManifest(harness: string, fixtures?: StoreFixture[]): DispatchManifest {
  return {
    harness,
    ...(fixtures && fixtures.length > 0
      ? { fixtures: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex").slice(0, 32) }
      : {}),
  };
}
