import { BadRequestError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { parseTenantCounts, parseTenantWeights } from "./scheduling-config.js";

// ── A COUNT AND A WEIGHT ARE DIFFERENT GRAMMARS (arch-review 62 P1) ─────────────────────────────────
//
// One parser served quotas, queue depths and weights, and accepted every positive finite number. So
//
//     EVERDICT_TENANT_QUOTAS=acme=1.5
//
// booted clean, passed every check, and broke nothing — until a tenant's execution reached the admission
// ledger. A quota is compared against an integer counter column, the driver sends its parameters as text,
// and Postgres infers the parameter's type from the comparison it appears in. Reproduced against a real
// Postgres 16:
//
//     PREPARE u AS UPDATE … WHERE in_flight < $1;
//     SELECT parameter_types FROM pg_prepared_statements;   → {integer}
//     EXECUTE u('1.5');
//     ERROR:  invalid input syntax for type integer: "1.5"
//
// Every admission for that ONE tenant then throws, on Postgres only, long after the config was accepted —
// and a ledger that cannot answer is an upstream failure rather than a refusal, so that tenant's work stops
// being placed while every other tenant is unaffected. The in-memory ledger compares in JavaScript and is
// perfectly happy with 1.5, which is why no test caught it: the adapter that would have failed is the one a
// unit suite does not run.
//
// A weight has no such constraint — it is arithmetic in our own process, and a fractional share is the whole
// point of it. So the two are different grammars, chosen at the call site by whoever knows which kind of
// number this is, rather than by one function obliged to accept the looser one.
//
// Seen RED before the split, observed:
//   a fractional count was accepted at boot and only Postgres refused it, per-tenant, at admission time:
//   expected [Function] to throw an error

describe("[R62 COUNTEREXAMPLE] a per-tenant COUNT is whole, because the ledger that enforces it is", () => {
  it("REFUSES a fractional quota at boot", () => {
    expect(
      () => parseTenantCounts("acme=1.5", "EVERDICT_TENANT_QUOTAS"),
      "a fractional count was accepted at boot and only Postgres refused it, per-tenant, at admission time",
    ).toThrow(BadRequestError);
  });

  it("REFUSES a fractional queue depth too — the same column, the same comparison", () => {
    expect(() => parseTenantCounts("acme=2.25", "EVERDICT_TENANT_QUEUE_DEPTHS")).toThrow(BadRequestError);
  });

  it("REFUSES a count past what the ledger column can hold", () => {
    // `Number.isInteger(1e21)` is true and the column is a 32-bit int, so integrality alone is not the
    // property that matters — representability is.
    expect(() => parseTenantCounts("acme=1e21", "EVERDICT_TENANT_QUOTAS")).toThrow(BadRequestError);
  });

  it("still accepts the ordinary whole numbers, including the '*' default", () => {
    // The control: a guard that refused everything would pass the assertions above and take the product
    // with it.
    const counts = parseTenantCounts("acme=8,*=16", "EVERDICT_TENANT_QUOTAS");
    expect(counts?.get("acme")).toBe(8);
    expect(counts?.get("nobody")).toBe(16);
  });

  it("ALLOWS a fractional weight — a share is not a count", () => {
    // The other half of the split. Tightening both would have been a smaller diff and a worse answer: an
    // operator asking for half again as many turns is expressing exactly what weights are for.
    const weights = parseTenantWeights("acme=1.5", "EVERDICT_TENANT_WEIGHTS");
    expect(weights?.get("acme"), "a fair-share weight was refused for being fractional").toBe(1.5);
  });
});
