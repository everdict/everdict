import { ScorecardService } from "@everdict/application-control";
import { NotFoundError } from "@everdict/contracts";
import { InMemoryScorecardStore } from "@everdict/db";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";

// ── A REGISTRY WE COULD NOT READ WAS REPORTED AS A HARNESS THAT IS GONE ──────────────────────────────
//
// `verifyManifest` answers the question this product sells: could this batch be reproduced today. Its
// vocabulary already carries three answers — `match`, `drifted`, `missing`, and `unverifiable`, which is what
// it says when no registry is wired at all ("we cannot tell").
//
// Both of its registry reads spent "we could not find out" as "it is gone". One wrapped the call in
// `try { … } catch { status: "missing" }`; the other in `.catch(() => undefined)`, whose undefined then flowed
// into a `missing` check carrying the note "the model binding no longer resolves". So a Postgres failover
// during a verification produced a recorded reproducibility verdict — the harness is missing, the model no
// longer resolves — from reads that never happened. Rule `protocol` L2, in the one place the product's own
// claim is computed.
//
// Found by `pnpm scan`, as the sibling of a defect repaired the same day in
// `apps/api/src/composition/sandbox.ts`; the ratchet could not see either one until `pnpm swallowed-reads`
// learned the conditional spelling.
//
// Seen RED against the pre-fix source, both reads, the two admitted-class cases staying green:
//   a store outage was recorded as a harness that is gone: expected 'missing' to be 'unverifiable'
//   a dataset store outage was recorded as a dataset that is gone: expected 'missing' to be 'unverifiable'

const MANIFEST_BATCH = {
  id: "vm",
  tenant: "acme",
  dataset: { id: "vd", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded" as const,
  manifest: {
    dataset: { id: "vd", version: "1.0.0", digest: "d0" },
    // Both facets under test: the spec digest drives the `harness` check, and a sealed model closure drives
    // the `harness:model` one. They read the registry through the same door and answered differently.
    harness: { id: "h", version: "1", specDigest: "0000000000000000", model: "openai/gpt-5.4-mini" },
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const serviceWith = async (harnesses: unknown, datasets: unknown = new InMemoryDatasetRegistry()) => {
  const store = new InMemoryScorecardStore();
  const service = new ScorecardService({
    dispatcher: {
      async dispatch() {
        throw new Error("never dispatched — this file only verifies a stored manifest");
      },
    },
    store,
    datasets,
    harnesses,
  } as never);
  await store.create(MANIFEST_BATCH as never);
  return service;
};

// A harness the registry CAN answer, for the two dataset cases below — their subject is the dataset read, and
// a harness double that answered nothing would fail them for an unrelated reason.
const RESOLVABLE_HARNESS = {
  async get() {
    return { kind: "process" as const, id: "h", version: "1", tags: [] };
  },
};

const statusOf = (checks: { subject: string; status: string }[], subject: string) =>
  checks.find((c) => c.subject === subject)?.status;

describe("a reproducibility verdict is not reached from a read that failed", () => {
  it("reports unverifiable, not missing, when the harness registry could not be read", async () => {
    const service = await serviceWith({
      async get() {
        throw new Error("harness registry unavailable");
      },
    });

    const v = await service.verifyManifest("acme", "vm");

    expect(statusOf(v.checks, "harness"), "a store outage was recorded as a harness that is gone").toBe("unverifiable");
    expect(
      statusOf(v.checks, "harness:model"),
      "a store outage was recorded as a model binding that no longer resolves",
    ).toBe("unverifiable");
    // …and it says WHY, because "unverifiable" without a reason reads like a batch nobody sealed properly.
    expect(v.checks.find((c) => c.subject === "harness")?.note ?? "").toContain("could not be read");
  });

  it("still reports missing for a harness this workspace genuinely no longer has", async () => {
    // The admitted class. `missing` is the drift this function exists to report, and a repair that answered
    // `unverifiable` for a deleted harness would have made the check unable to say anything at all.
    const service = await serviceWith({
      async get(_tenant: string, id: string) {
        throw new NotFoundError("NOT_FOUND", { harness: id }, `Harness '${id}' is not registered.`);
      },
    });

    const v = await service.verifyManifest("acme", "vm");

    expect(statusOf(v.checks, "harness"), "a deleted harness stopped reading as missing").toBe("missing");
  });

  it("answers the same way about the DATASET registry, which is read through the same door", async () => {
    // Three checks depend on that bundle — the composite, the per-case seals and the grading defaults — and
    // one `.catch(() => undefined)` made a store outage into three separate verdicts that the batch's inputs
    // are gone. Repaired in the same change as the harness read, because two reads answering one question
    // differently is how the next review finds the one that was missed.
    const unreadable = {
      async get() {
        throw new Error("dataset registry unavailable");
      },
    };
    const service = await serviceWith(RESOLVABLE_HARNESS, unreadable);

    const v = await service.verifyManifest("acme", "vm");

    expect(statusOf(v.checks, "dataset"), "a dataset store outage was recorded as a dataset that is gone").toBe(
      "unverifiable",
    );
  });

  it("still reports missing for a dataset version this workspace genuinely no longer has", async () => {
    const absent = {
      async get(_tenant: string, id: string) {
        throw new NotFoundError("NOT_FOUND", { dataset: id }, `Dataset '${id}' is not registered.`);
      },
    };
    const service = await serviceWith(RESOLVABLE_HARNESS, absent);

    const v = await service.verifyManifest("acme", "vm");

    expect(statusOf(v.checks, "dataset"), "a deleted dataset stopped reading as missing").toBe("missing");
  });
});
