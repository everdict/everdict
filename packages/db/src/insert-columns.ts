// ── THE PLACEHOLDER LIST IS DERIVED FROM THE COLUMN LIST, NEVER WRITTEN BESIDE IT ────────────────────
//
// Every Pg store builds its INSERT from a pair of hand-written constants:
//
//     const X_COLUMNS = "(id, tenant, …, publication)";
//     const X_VALUES  = "($1,$2,…,$36)";
//
// TypeScript cannot see inside a SQL string, so the two drift silently and the compiler is happy. Removing
// one column from the first is a one-character edit to the second that is easy to forget — and forgetting it
// is not a subtle bug: Postgres refuses the statement outright with "INSERT has more expressions than target
// columns", so EVERY insert on that table fails, in production, while every unit test stays green because
// they run against the in-memory twin.
//
// That is not hypothetical. Dropping the team axis removed `team_id` from three column lists and left all
// three placeholder lists a beat behind, so `PgScorecardStore.create`, `PgIssueStore.create` and
// `PgProjectStore.create` were each refused by the planner — three core write paths, shipped and pushed.
// The gate that exists to catch exactly this (`trust fast (real Postgres)`) could not: GitHub Actions has
// been disabled on the repository since 2026-08-21, so no required check has run since.
//
// A scanner comparing the two counts was the obvious repair and is the weaker one — rule `protocol`'s table
// says a scanner with an allowlist is a place the type failed to say it. So the second constant is gone:
// there is one list, and the placeholders are computed from it. They cannot disagree because there is
// nothing left to disagree with.
export function insertPlaceholders(columns: string): string {
  return `(${columnNames(columns)
    .map((_, i) => `$${i + 1}`)
    .join(",")})`;
}

// The column names, parsed from the parenthesized list the stores already write. Exported because the arity
// guard below needs the same count, and counting it twice is the defect this file removes (protocol L3).
export function columnNames(columns: string): string[] {
  return columns
    .replace(/^\s*\(|\)\s*$/g, "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// ── …AND THE PARAMS ARE CHECKED AGAINST IT, BECAUSE THAT IS THE OTHER HALF ──────────────────────────
//
// Deriving the placeholders closes column↔placeholder drift. It says nothing about the third list — the
// values array a `*InsertParams` function returns — which drifts the same way and fails the same way, one
// message later ("bind message supplies N parameters, but prepared statement requires M").
//
// So the insert goes through here, and a mismatch THROWS with both counts named, at the call site, instead
// of arriving as a driver error that reads like a database problem. It is a cheap assertion on a path that
// runs once per row, and it is the only thing standing between a column edit and a silent production
// outage on a store nobody re-plans.
export function assertInsertArity(label: string, columns: string, params: readonly unknown[]): void {
  const expected = columnNames(columns).length;
  if (params.length !== expected)
    throw new Error(
      `${label}: INSERT lists ${expected} column(s) and was given ${params.length} parameter(s) — the column list and the params array have drifted.`,
    );
}
