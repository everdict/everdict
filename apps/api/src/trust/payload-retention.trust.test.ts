import { OffloadingTrajectoryStore } from "@everdict/application-control";
import type { TraceEvent } from "@everdict/contracts";
import { PgTrajectoryStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-190.
//
// RETENTION'S REF ENUMERATION IS SQL, SO ONLY AN ENGINE CAN CERTIFY IT.
//
// An offloaded trace payload is named ONLY by the event row carrying its ref, so `deleteOlderThan` must
// enumerate those refs and delete the objects BEFORE the rows. The enumeration is a jsonpath query, and its
// first version was a SYNTAX ERROR — `'$.**{0 to 6}.*ref'`, trying to say "any key ending in ref", which
// SQL/JSON path cannot express. Postgres answered `syntax error at end of jsonpath input` on every call, and
// because the decorator awaits this read before deleting anything, the ENTIRE trajectory retention sweep
// threw in every Postgres deployment — object cleanup and row deletion alike.
//
// Every unit test passed throughout, against `InMemoryTrajectoryStore`'s own JavaScript walk. That is rule
// `testing`'s law verbatim: a decision that lives in the ADAPTER — a join, a constraint, a jsonpath — is
// certified by a real-Postgres scenario or by nothing at all. This is that scenario.
//
// It also pins the PREDICATE, which the three implementations had spelled three different ways: a ref is a
// complete string value that STARTS WITH the scheme. Not a key name (a ref stored under any other key would
// be missed) and not a substring (an agent's own output quoting somebody else's ref would be matched — and
// retention DELETES what this returns, so a loose predicate destroys another run's evidence).
const BIG = "x".repeat(200_000);

function artifacts() {
  const objects = new Map<string, Uint8Array>();
  return {
    keys: () => [...objects.keys()],
    async put(key: string, data: Uint8Array) {
      objects.set(key, data);
      return `https://example.invalid/${key}`;
    },
    async get(key: string) {
      return objects.get(key);
    },
    async publicUrlFor() {
      return undefined;
    },
    // The sweep lists a run's own prefix for what no row named (arch-review 124). Both real stores refuse an
    // empty prefix, so this one does too — a double more permissive than production is what rule `testing`
    // refuses, and this is a delete path.
    async listKeys(prefix: string) {
      if (prefix === "") throw new Error("refusing to list the whole artifact store");
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
    async remove(key: string) {
      objects.delete(key);
    },
  };
}

describe.skipIf(!TRUST_PG_ENABLED)("TRUST-190 — retention enumerates and deletes offloaded payloads", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  it("removes the payload objects and the rows, against a real database", async () => {
    const runId = trustId("run-retention");
    const tenant = trustId("acme");
    const raw = new PgTrajectoryStore(pg.client);
    const objects = artifacts();
    const store = new OffloadingTrajectoryStore(raw, objects);

    const events: TraceEvent[] = [
      { t: 0, kind: "message", role: "user", text: "go" },
      { t: 1, kind: "tool_result", id: "c1", ok: true, output: BIG },
      // A ref MENTIONED in prose, never a ref this trajectory owns. A substring predicate would return it,
      // and the sweep would then delete an object belonging to somebody else.
      { t: 2, kind: "message", role: "assistant", text: "saved it, see artifact://someone-elses-key" },
    ];
    await store.seal({ runId, tenant, source: "run", events });

    // The premise: the offload really happened, so there is a payload for retention to be wrong about.
    expect(objects.keys(), "nothing was offloaded — this would prove nothing about retention").toHaveLength(1);
    const owned = objects.keys()[0];

    // The enumeration itself, executed by Postgres. Before the fix this THREW.
    const refs = await raw.payloadRefsOf([runId], 5_000);
    expect(
      refs.map((r) => r.ref),
      "the enumeration did not find the trajectory's own payload",
    ).toContain(`artifact://${owned}`);
    // The owner travels with the ref, so the sweep can join it against the key rather than assuming it.
    //
    // ⚠️ SCOPED TO THIS RUN. The suite is designed to run against a database it may REUSE — that is what
    // `trustId` is for — so "every row this enumeration returned belongs to me" is a claim about the whole
    // database rather than about the read. It went red the first time another scenario in the same file set
    // left an expired row behind, which is a false RED: the enumeration was correct and the premise was not.
    const mine = refs.filter((r) => r.runId === runId);
    expect(mine, "the enumeration returned nothing for this run").not.toHaveLength(0);
    expect(
      mine.every((r) => r.tenant === tenant),
      "the enumeration answered a ref without saying which trajectory holds it",
    ).toBe(true);
    expect(
      mine.some((r) => r.ref.includes("someone-elses-key")),
      "a ref merely MENTIONED in the trace was claimed as this trajectory's own",
    ).toBe(false);

    const removed = await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    expect(removed, "no rows were swept").toBeGreaterThan(0);
    expect(objects.keys(), "the rows went and the payload bytes stayed").toEqual([]);
    // …and the evidence is gone from the database too, not merely from object storage.
    expect((await raw.planes(tenant, runId)) === undefined, "the trajectory row survived its retention").toBe(true);
  });
});
