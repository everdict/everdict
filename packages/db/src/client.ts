import pg from "pg";

// Minimal SQL-client abstraction — mockable in tests (same pattern as NomadHttp).
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  // ONE ACT, ONE COMMIT. Optional because most writes here are single statements — a data-modifying CTE is
  // the repository's default way to make two writes atomic, and it needs no transaction. This exists for the
  // case a CTE cannot express: two writes owned by two different ADAPTERS (the dataset registry and the
  // constitutional receipt), which no single statement can span because neither adapter knows the other.
  //
  // `undefined` = this client cannot transact (a fake, an in-memory twin). Callers that REQUIRE atomicity
  // must refuse rather than fall back to two commits — see `withTransaction`.
  transaction?<T>(run: (tx: SqlClient) => Promise<T>): Promise<T>;
}

// Run `fn` inside one transaction, or refuse. The refusal is the point: a caller reaching for this has an
// invariant that spans two writes, and doing them separately is not a degraded version of that invariant —
// it is a different one, with a window in it.
export async function withTransaction<T>(client: SqlClient, what: string, run: (tx: SqlClient) => Promise<T>) {
  if (!client.transaction)
    throw new Error(`${what} must commit atomically, and this SQL client cannot open a transaction.`);
  return client.transaction(run);
}

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

// ── A POOL WITH NO CEILINGS IS A SINGLE POINT OF TOTAL FAILURE (perf review) ─────────────────────────
//
// This was `new pg.Pool({ connectionString })` — every ceiling left at the driver's default, which means:
//
//   max: 10                          the whole control plane shares TEN connections
//   connectionTimeoutMillis: 0       a caller that finds the pool empty waits FOREVER
//   statement_timeout: unset         a slow query holds its connection FOREVER
//
// Those three compose into one behaviour, and it is the one that was observed: a handful of expensive reads
// (a retention sweep, a dashboard fan-out, a trace page over a large ledger) take all ten slots, hold them
// with no server-side deadline, and every other route in the process — including ones that touch none of
// that data — queues behind them with no deadline either. A local slowdown becomes a total outage, and it
// presents as "the API times out" rather than as "this query is slow", which is why it is hard to find from
// the symptom.
//
// The repair is that each of the three has a value. NOT because the defaults are wrong in the abstract, but
// because a bound is a property of the deployment and `undefined` is not a bound (rule `protocol` L2's shape,
// applied to capacity): "no limit" and "the limit nobody chose" must not be the same configuration.
//
// `statement_timeout` is server-side deliberately. `query_timeout` (node-pg's client-side twin) abandons the
// JS promise while Postgres keeps executing and keeps holding the connection, so it bounds the CALLER and not
// the RESOURCE — which is the opposite of what pool starvation needs.
export interface PoolTuning {
  // Concurrent connections. The control plane fans out (the workspace pulse alone issues ~10 reads in one
  // request), so the default is sized for fan-out rather than for one query at a time.
  max?: number;
  // How long a caller waits for a slot before being told the pool is full. NEVER 0 — see above.
  connectionTimeoutMs?: number;
  // Server-side per-statement deadline. A statement past it is cancelled BY POSTGRES and the connection
  // returns to the pool, which is the property that keeps one slow read from becoming an outage.
  statementTimeoutMs?: number;
  // Server-side deadline for a session sitting idle INSIDE a transaction — the shape that holds locks as
  // well as a connection.
  idleInTransactionTimeoutMs?: number;
  // How long an idle (non-transacting) connection is kept before the pool closes it.
  idleTimeoutMs?: number;
  // Rides into `pg_stat_activity.application_name`, so an operator looking at a busy database can tell the
  // request path from a background sweep without guessing from the SQL text.
  applicationName?: string;
}

export const DEFAULT_POOL_MAX = 20;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// Pure, and exported for that reason: the values above are the deployment's ceilings, and a ceiling nobody
// can assert on is a ceiling that regresses silently the next time this constructor is edited.
export function poolConfig(connectionString: string, tuning?: PoolTuning): pg.PoolConfig {
  return {
    connectionString,
    max: tuning?.max ?? DEFAULT_POOL_MAX,
    connectionTimeoutMillis: tuning?.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: tuning?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    statement_timeout: tuning?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: tuning?.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    ...(tuning?.applicationName !== undefined ? { application_name: tuning.applicationName } : {}),
  };
}

// A real Postgres pool. connectionString example: postgresql://user:pass@host:5432/db
//
// ⚠️ A LONG-RUNNING BACKGROUND JOB GETS ITS OWN POOL, NOT A LONGER TIMEOUT ON THIS ONE. Retention sweeps and
// boot recovery legitimately run for minutes; raising `statementTimeoutMs` here to accommodate them would
// hand that same allowance to every request handler and undo the bound. Build a second, SMALL pool for them
// (`max: 2`) so their cost is capped by the pool that holds them rather than by the one serving requests.
export function makePool(connectionString: string, tuning?: PoolTuning): pg.Pool {
  return new pg.Pool(poolConfig(connectionString, tuning));
}

// pg.Pool → SqlClient (structurally compatible, but wrapped thinly to avoid generic friction).
export function sqlClient(pool: {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  // A real pool can hand out a dedicated connection; a bare `{query}` (a fake, a proxy) cannot, and then the
  // client honestly reports that it cannot transact.
  connect?(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
}): SqlClient {
  const base: SqlClient = {
    async query(text, params) {
      const res = await pool.query(text, params);
      return { rows: res.rows as never[] };
    },
  };
  if (!pool.connect) return base;
  const connect = pool.connect.bind(pool);
  return {
    ...base,
    async transaction(run) {
      // A DEDICATED connection for the whole unit — the pool hands out a different one per query, so BEGIN
      // and COMMIT issued through it would land on unrelated sessions and the transaction would be a fiction.
      const conn = await connect();
      const tx: SqlClient = {
        async query(text, params) {
          const res = await conn.query(text, params);
          return { rows: res.rows as never[] };
        },
      };
      try {
        await conn.query("BEGIN");
        const out = await run(tx);
        await conn.query("COMMIT");
        return out;
      } catch (err) {
        await conn.query("ROLLBACK").catch(() => undefined); // the connection may already be unusable
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}
