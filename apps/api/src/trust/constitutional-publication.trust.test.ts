import type { ConstitutionApproval } from "@everdict/application-control";
import type { Dataset } from "@everdict/contracts";
import { PgConstitutionApprovalStore } from "@everdict/db";
import { contentDigest } from "@everdict/domain";
import { PgDatasetRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgConstitutionalPublisher } from "../infrastructure/registry/constitutional-publisher.js";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-137.
//
// WRITE A THEN B IS NOT AN ATOMIC PUBLICATION.
//
// A dataset whose graders declare `ground_truth` decides what passing means, and the receipt beside it says
// who authorised exactly those bytes. They were two commits. Ordering the receipt first only moved the
// window; it did not close it, and the state inside it is the one this mechanism has no vocabulary for —
// bytes registered under a name whose recorded approval names DIFFERENT bytes.
//
// That state is not a smaller version of the guarantee. Submit compares digest to digest, so such a dataset
// is refused forever, and the only way back (`legacy_attested`) records that it was authorised AFTER it
// already ran. A half-landed publication does not lose information; it writes a wrong history.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-137 — a constitutional dataset publishes in one commit or not at all", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  const dataset = (id: string, metric: string): Dataset =>
    ({
      id,
      version: "1.0.0",
      cases: [
        {
          id: "c1",
          env: { kind: "prompt" },
          task: "do",
          graders: [{ id: "probe", metrics: [{ id: metric, authority: "ground_truth" }] }],
          timeoutSec: 60,
          tags: [],
        },
      ],
      tags: [],
    }) as unknown as Dataset;

  const approvalFor = (ds: Dataset, metric: string): ConstitutionApproval => ({
    kind: "dataset",
    id: ds.id,
    version: ds.version,
    contentDigest: contentDigest(ds),
    metrics: [metric],
    mode: "approved",
    approvedBy: "member:admin",
    approvedAt: "2026-08-11T00:00:00.000Z",
  });

  it("both halves land together — the bytes, the receipt that names them, and the capability generation", async () => {
    const id = trustId("gt-ok");
    const ds = dataset(id, "business_ok");
    await pgConstitutionalPublisher(pg.client).publish({
      tenant: "trust",
      dataset: ds as unknown as { id: string; version: string } & Record<string, unknown>,
      approval: approvalFor(ds, "business_ok"),
      createdBy: "member:admin",
    });
    const stored = await new PgDatasetRegistry(pg.client).get("trust", id, "1.0.0");
    const receipt = await new PgConstitutionApprovalStore(pg.client).find("trust", "dataset", id, "1.0.0");
    expect(stored.id).toBe(id);
    // The receipt names THESE bytes — the comparison submit makes, and the reason the two writes cannot drift.
    expect(receipt?.contentDigest).toBe(contentDigest(stored));
    // …and the fence the release gate reads moved with them, because the registry's bump rides inside its own
    // INSERT and that statement is inside this transaction.
    const { rows } = await pg.client.query<{ generation: string }>(
      "SELECT generation FROM everdict_capability_generation WHERE tenant = 'trust' AND kind = 'dataset' AND id = $1",
      [id],
    );
    expect(Number(rows[0]?.generation)).toBeGreaterThanOrEqual(1);
  });

  it("a receipt that fails takes the DATASET with it — no bytes without their approval", async () => {
    // The failure the two-commit shape could not survive. `approved_at` is `timestamptz NOT NULL`, so a
    // receipt carrying a malformed instant is refused by the database mid-transaction — after the dataset row
    // has already been inserted inside it.
    const id = trustId("gt-rollback");
    const ds = dataset(id, "business_ok");
    await expect(
      pgConstitutionalPublisher(pg.client).publish({
        tenant: "trust",
        dataset: ds as unknown as { id: string; version: string } & Record<string, unknown>,
        approval: { ...approvalFor(ds, "business_ok"), approvedAt: "not-a-timestamp" },
        createdBy: "member:admin",
      }),
    ).rejects.toThrow();

    // Neither half is there. Pre-fix, the dataset existed with no receipt: a document that decides what
    // passing means, that every submit refuses, and whose only route back rewrites its own history.
    const { rows: datasetRows } = await pg.client.query<{ id: string }>(
      "SELECT id FROM everdict_datasets WHERE tenant = 'trust' AND id = $1",
      [id],
    );
    expect(datasetRows).toHaveLength(0);
    const receipt = await new PgConstitutionApprovalStore(pg.client).find("trust", "dataset", id, "1.0.0");
    expect(receipt).toBeUndefined();
    // …and the fence did not move for a publication that never happened.
    const { rows: genRows } = await pg.client.query(
      "SELECT 1 FROM everdict_capability_generation WHERE tenant = 'trust' AND kind = 'dataset' AND id = $1",
      [id],
    );
    expect(genRows).toHaveLength(0);
  });

  it("a client that cannot transact REFUSES — it does not fall back to two commits", async () => {
    // Fail-closed by construction: doing the two writes separately is not a degraded version of this
    // invariant, it is a different one with a window in it. A deployment that cannot commit both is one that
    // cannot publish a constitutional dataset, and it says so at the door.
    const ds = dataset(trustId("gt-notx"), "business_ok");
    const noTx = { query: pg.client.query.bind(pg.client) }; // a bare {query} — no connection to hold open
    await expect(
      pgConstitutionalPublisher(noTx).publish({
        tenant: "trust",
        dataset: ds as unknown as { id: string; version: string } & Record<string, unknown>,
        approval: approvalFor(ds, "business_ok"),
      }),
    ).rejects.toThrow(/cannot open a transaction/);
  });
});
