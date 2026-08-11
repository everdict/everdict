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

// A real Postgres pool. connectionString example: postgresql://user:pass@host:5432/db
export function makePool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
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
