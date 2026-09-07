import { CapabilityRecordSchema, ConflictError } from "@everdict/contracts";
import { PgCapabilityStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-195.
//
// TWO REGISTRATIONS OF ONE VERSION ARE ARBITRATED BY THE PRIMARY KEY, NOT BY A READ ABOVE THE INSERT.
//
// `PgCapabilityStore.register` read the row, decided "absent", and inserted. `(tenant, id, version)` is the
// table's primary key, so two concurrent registrations of the same brand-new version both saw absent and both
// inserted — and the loser met a unique violation that left the store as a RAW database error. Both endings
// were wrong in a way a caller cannot act on: an idempotent re-register of IDENTICAL content became a 500,
// and a genuine content conflict arrived as a driver error instead of this store's own 409.
//
// ⚠️ WHY A FAKE CANNOT PROVE THIS. The arbiter is the engine. Whether `ON CONFLICT (tenant, id, version)`
// INFERS the primary key is a question Postgres answers — an inference that does not match is not a subtle
// bug, the statement does not run at all — and whether `RETURNING 1` comes back empty on the losing arm is
// MVCC, not a code path. A client asserting on SQL text agrees with whatever it is shown. Reported by
// `pnpm scan` over `adapters` at low confidence and left unreproduced in the intent; it is reproduced here.
//
// Observed against the pre-fix store on a real Postgres:
//   duplicate key value violates unique constraint "everdict_capabilities_pkey"
// …thrown raw from `register`, where the second caller should have been told either "already registered,
// identical" (silently fine) or "already registered with different content" (this store's ConflictError).
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-195 — concurrent capability registration is decided by the key", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => {
    await pg?.close();
  });

  // Built through the SCHEMA, not by hand, and varying a field the schema KEEPS. `rowToRecord` parses what it
  // reads back, so a hand-made record is compared against a normalized one and reports "different content"
  // for a fixture reason; and the first draft varied `command`, which `McpToolSpecSchema` does not declare —
  // so the parse stripped it, both records became byte-identical, and the conflict case reported that two
  // different contents had been admitted when in fact only one content was ever sent.
  const record = (tenant: string, id: string, image: string) =>
    CapabilityRecordSchema.parse({
      tenant,
      id,
      version: "1.0.0",
      name: "helper",
      description: "a capability",
      spec: { type: "mcp", image, args: [] },
      visibility: "private",
      sharedWith: [],
      tags: [],
      createdBy: "alice",
      createdAt: new Date().toISOString(),
    });

  it("admits both racers when the content is identical, and neither sees a driver error", async () => {
    const store = new PgCapabilityStore(pg.client);
    const tenant = trustId("cap-same");
    const id = trustId("helper");

    // Both start from the same "absent" world — which is the race, not a simulation of one: neither call has
    // read anything yet, so both would have taken the insert arm under the old store.
    const results = await Promise.allSettled([
      store.register(record(tenant, id, "ghcr.io/acme/mcp:1")),
      store.register(record(tenant, id, "ghcr.io/acme/mcp:1")),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? ""),
      "a re-registration of identical content failed",
    ).toEqual([]);

    const rows = await pg.client.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM everdict_capabilities WHERE tenant = $1 AND id = $2",
      [tenant, id],
    );
    expect(Number(rows.rows[0]?.n ?? 0), "one version became two rows").toBe(1);
  });

  it("tells the loser it is a content conflict, in this store's own error, not the driver's", async () => {
    const store = new PgCapabilityStore(pg.client);
    const tenant = trustId("cap-diff");
    const id = trustId("helper");

    const results = await Promise.allSettled([
      store.register(record(tenant, id, "ghcr.io/acme/mcp:1")),
      store.register(record(tenant, id, "ghcr.io/acme/mcp:2")),
    ]);

    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    // Exactly one loses — immutable versions mean the second content cannot be admitted.
    expect(rejected, "both registrations of different content were admitted").toHaveLength(1);
    expect(
      rejected[0]?.reason,
      "the loser was handed a raw database error instead of this store's refusal",
    ).toBeInstanceOf(ConflictError);
  });

  it("still revives a tombstoned version when the same content is registered again", async () => {
    // The admitted class, and the reason the losing arm re-reads instead of simply refusing: identical
    // content is how a soft-deleted capability comes back, and a repair that turned every conflict into a
    // refusal would have removed that.
    const store = new PgCapabilityStore(pg.client);
    const tenant = trustId("cap-revive");
    const id = trustId("helper");
    await store.register(record(tenant, id, "ghcr.io/acme/mcp:1"));
    await pg.client.query(
      "UPDATE everdict_capabilities SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3",
      [tenant, id, "1.0.0"],
    );

    await store.register(record(tenant, id, "ghcr.io/acme/mcp:1"));

    const live = await pg.client.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM everdict_capabilities WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
      [tenant, id],
    );
    expect(Number(live.rows[0]?.n ?? 0), "re-registering identical content stopped reviving the tombstone").toBe(1);
  });
});
