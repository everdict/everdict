import type { CapabilityRecord } from "@everdict/contracts";
import { NotFoundError, UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { EnvironmentAdoptionService } from "./environment-adoption-service.js";

// ── [pnpm scan · application · 2026-09-11] A STORE OUTAGE IS NOT A DELETED CAPABILITY ───────────────
//
// `resolve` swallowed a `capabilityStore.getVersion` failure into `undefined`, and `adopt` turned that into
// `404 "environment … is not available to adopt"` — the SAME answer a genuinely deleted or revoked
// capability gets. A caller told something does not exist stops asking; a caller told the store is
// unreachable retries, and only one of those was true (rule `protocol` L2).
//
// Both directions are asserted, because a predicate with only the refusal case has an unmeasured
// false-positive rate: the outage must NOT 404, and a genuinely absent capability must STILL 404.
//
// Seen red under neutralization: "expected NotFoundError: environment env-a@1.0.0 is… to be an instance of
// UpstreamError" — the 404 the finding is about, in the answer's own words.
const ENVIRONMENT = {
  id: "env-a",
  version: "1.0.0",
  name: "env-a",
  description: "",
  tags: [],
  tenant: "acme",
  createdAt: "2026-09-11T00:00:00.000Z",
  createdBy: "alice",
  visibility: "public",
  spec: { type: "environment", image: "reg/env-a:1.0.0" },
} as unknown as CapabilityRecord;

const service = (getVersion: () => Promise<CapabilityRecord | undefined>) =>
  new EnvironmentAdoptionService({
    capabilityStore: { getVersion: async () => getVersion() },
    settings: { get: async () => undefined, set: async () => undefined },
    registryCoordinates: async () => [],
    verifyImage: async () => ({ pullable: true as const }),
    now: () => "2026-09-11T00:00:00.000Z",
  } as unknown as ConstructorParameters<typeof EnvironmentAdoptionService>[0]);

const REF = { source: "acme", id: "env-a", version: "1.0.0" };

describe("[COUNTEREXAMPLE] an unreadable capability store is not a missing environment", () => {
  it("refuses an adoption it CANNOT decide as retryable upstream, never as 404", async () => {
    const outage = service(() => {
      throw new Error("connection terminated unexpectedly");
    });
    const err = await outage.adopt("acme", "alice", REF).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect((err as UpstreamError).message).toMatch(/capability store could not be read/);
    // …and nothing was adopted, which is what makes the retry safe.
    expect((err as UpstreamError).message).toMatch(/nothing was adopted/);
  });

  it("…and a genuinely absent capability still gets its 404 — the other half of the predicate", async () => {
    const gone = service(async () => undefined);
    await expect(gone.adopt("acme", "alice", REF)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a resolvable environment still adopts — the refusal is not a ban on the happy path", async () => {
    const ok = service(async () => ENVIRONMENT);
    const view = await ok.adopt("acme", "alice", REF);
    expect(view).toMatchObject({ id: "env-a", version: "1.0.0", available: true });
  });
});
