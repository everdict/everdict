import { PgScorecardStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// ── THE PROJECTION A HUMAN READS IS MONOTONIC, AGAINST A REAL DATABASE (arch-review 58 P1-high) ──────
//
// arch-review 56 made the current-export projection a monotonic CAS: a settlement may only advance the
// reader-facing receipt, so two publishers finishing out of order cannot leave the older one's answer on
// screen. The guard was written against the RECORD field name (`export`) while the column is `sink_export`,
// which no unit test could notice — the in-memory twin has no columns to be wrong about, and a fake
// `SqlClient` answers whatever it is asked.
//
// So the one write the guard exists to protect failed outright (`column "export" does not exist`), and the
// projection never advanced at all. The historical publication protocol underneath was correct the whole
// time; a settlement can be perfectly recorded and still be invisible.
//
// This is the shape of check that catches it: a real database, a real schema, and the three writes in the
// order that matters. `pnpm ci:local` boots no database on purpose, so this scenario lives in the
// `trust fast (real Postgres)` lane, which is a required check.
//
// RED as of 26147830, observed:
//   error: column "export" does not exist

describe.skipIf(!TRUST_PG_ENABLED)("TRUST — the current export projection only ever moves forward", () => {
  let pg: TrustPg;
  let store: PgScorecardStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    store = new PgScorecardStore(pg.client);
  });
  afterAll(async () => {
    await pg?.close();
  });

  const seed = async (id: string) => {
    await store.create({
      id,
      tenant: "acme",
      kind: "scorecard",
      status: "running",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1" },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as never);
  };

  const exportAt = (revision: number) => ({
    sink: "mlflow" as const,
    status: "succeeded" as const,
    exportedAt: new Date(revision * 1000).toISOString(),
    scoringRevision: revision,
  });

  it("accepts an advance, and REFUSES the older settlement that finishes late", async () => {
    const id = trustId("sc-export");
    await seed(id);

    // Revision 2 lands first — an ordinary re-score published before the older owed export drained.
    await store.update(id, { export: exportAt(2) } as never, undefined, { expectExportRevisionBelow: 2 });
    expect((await store.get(id))?.export?.scoringRevision, "the first advance did not land at all").toBe(2);

    // …and now the older one arrives. It must not win: the reader would see a receipt for a plane the
    // record has moved past.
    await store
      .update(id, { export: exportAt(1) } as never, undefined, { expectExportRevisionBelow: 1 })
      .catch(() => undefined);
    expect((await store.get(id))?.export?.scoringRevision, "an older settlement overwrote a newer receipt").toBe(2);
  });

  it("treats a receipt with NO revision as older than every revision", async () => {
    // A pre-Wave-F receipt is not unknown, it is old — which is what `COALESCE(..., 0)` says. A guard that
    // skipped those rows would let the very first advance be the one that never happens.
    const id = trustId("sc-export-legacy");
    await seed(id);
    await store.update(id, {
      export: { sink: "mlflow", status: "succeeded", exportedAt: new Date(0).toISOString() },
    } as never);

    await store.update(id, { export: exportAt(1) } as never, undefined, { expectExportRevisionBelow: 1 });
    expect((await store.get(id))?.export?.scoringRevision).toBe(1);
  });
});
