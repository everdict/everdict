import pg from "pg";

// 최소 SQL 클라이언트 추상화 — 테스트에서 모킹 가능(NomadHttp 패턴과 동일).
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

// 실제 Postgres 풀. connectionString 예: postgresql://user:pass@host:5432/db
export function makePool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

// pg.Pool → SqlClient (구조적으로 호환되지만 제네릭 마찰을 피하려 얇게 감싼다).
export function sqlClient(pool: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): SqlClient {
  return {
    async query(text, params) {
      const res = await pool.query(text, params);
      return { rows: res.rows as never[] };
    },
  };
}
