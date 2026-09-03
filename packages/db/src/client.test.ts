import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  poolConfig,
} from "./client.js";

// ── THE POOL'S CEILINGS ARE ASSERTED, NOT ASSUMED (perf review) ──────────────────────────────────────
//
// The pool was built as `new pg.Pool({ connectionString })`, so `max` was 10, a caller finding it empty
// waited forever (`connectionTimeoutMillis: 0`) and a slow statement held its connection forever (no
// `statement_timeout`). Those three compose into a total outage from a local slowdown, and none of them is
// visible in any behavioural test — the pool works fine right up to the moment it does not.
//
// Neutralizing the fix (`poolConfig` returning `{ connectionString }` alone) makes all three RED with
// observed text `AssertionError: expected undefined to be 20 // Object.is equality` — `undefined` being
// precisely the pre-fix state of every ceiling here, so the failure names the defect rather than a fixture.
describe("poolConfig — every ceiling has a value", () => {
  it("bounds the pool size, the wait for a slot, and the statement itself", () => {
    // Given: the connection string a deployment configures and nothing else
    const config = poolConfig("postgresql://u:p@h:5432/db");

    // Then: none of the three ceilings is left at the driver's default
    expect(config.max).toBe(DEFAULT_POOL_MAX);
    expect(config.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(config.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(config.idle_in_transaction_session_timeout).toBe(DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  });

  it("never lets a caller wait forever for a connection", () => {
    // Given: the default configuration
    const config = poolConfig("postgresql://u:p@h:5432/db");

    // Then: 0 is node-pg's spelling of "wait without limit", and it is the one value this must never be
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config.statement_timeout).toBeGreaterThan(0);
  });

  it("lets a background lane take a longer statement deadline on a SMALLER pool", () => {
    // Given: the sweep lane — long statements are legitimate there, and the cost is capped by the pool size
    const sweep = poolConfig("postgresql://u:p@h:5432/db", {
      max: 2,
      statementTimeoutMs: 600_000,
      applicationName: "everdict-api-sweep",
    });

    // Then: the request lane's ceiling is untouched by the background lane's allowance
    expect(sweep.max).toBe(2);
    expect(sweep.statement_timeout).toBe(600_000);
    expect(sweep.application_name).toBe("everdict-api-sweep");
    expect(poolConfig("postgresql://u:p@h:5432/db").statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
  });
});
