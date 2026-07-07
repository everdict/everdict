import pg from "pg";

// Minimal SQL-client abstraction — mockable in tests (same pattern as NomadHttp).
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
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
export function sqlClient(pool: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): SqlClient {
  return {
    async query(text, params) {
      const res = await pool.query(text, params);
      return { rows: res.rows as never[] };
    },
  };
}
