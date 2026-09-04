import type { IssueRecord, ProjectRecord, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "./client.js";
import { assertInsertArity, columnNames, insertPlaceholders } from "./insert-columns.js";
import { PgRunStore } from "./results/pg-run-store.js";
import { PgScorecardStore } from "./results/pg-scorecard-store.js";
import { PgIssueStore } from "./tracker/issue-store.js";
import { PgProjectStore } from "./tracker/project-store.js";

// ── THE DEFECT THIS FILE EXISTS FOR ──────────────────────────────────────────────────────────────────
//
// Dropping the team axis removed `team_id` from three column lists and left all three hand-written
// placeholder lists one longer. TypeScript cannot see inside a SQL string, every unit test ran against the
// in-memory twin, and the required check that WOULD have caught it (`trust fast (real Postgres)`) has not
// run since GitHub Actions was disabled on 2026-08-21. So `PgScorecardStore.create`, `PgIssueStore.create`
// and `PgProjectStore.create` shipped refused by the planner — three core write paths, in production,
// silently.
//
// The repair is structural (the placeholders are DERIVED from the columns, so they cannot disagree) plus an
// arity assertion on the params array, which is the axis a derivation cannot close. These tests drive the
// real store methods through a recording client: the assertion runs BEFORE the query, so the drift is
// caught with no database at all — which is the point, because a database is exactly what CI does not have
// when it needs to know.

const recording = (): { client: SqlClient; sql: string[] } => {
  const sql: string[] = [];
  const client: SqlClient = {
    async query<T>(text: string) {
      sql.push(text);
      return { rows: [] as T[], rowCount: 0 };
    },
  } as unknown as SqlClient;
  return { client, sql };
};

const now = "2026-09-04T00:00:00.000Z";

// THE PROPERTY, ASSERTED ON THE STATEMENT ITSELF. Relying on `assertInsertArity` to throw would make every
// test below vacuous the moment that call is removed — and the first draft of this file did exactly that:
// with the assertion reverted, the issue and project cases stayed green over the very statements the
// planner refuses. So the counts are read back out of the SQL the store actually built.
const listsAgree = (text: string, table: string): void => {
  const cols = new RegExp(`INSERT INTO ${table} \\(([^)]+)\\)`).exec(text)?.[1];
  const placeholders = /VALUES \(([^)]+)\)/.exec(text)?.[1];
  expect(cols, `no INSERT INTO ${table} in: ${text.slice(0, 120)}`).toBeDefined();
  expect(placeholders).toBeDefined();
  expect(columnNames(cols as string).length).toBe((placeholders as string).split(",").length);
};

describe("insertPlaceholders — one list, so there is nothing to disagree with", () => {
  it("numbers one placeholder per column, from 1", () => {
    expect(insertPlaceholders("(a, b, c)")).toBe("($1,$2,$3)");
  });

  it("counts the columns the same way the statement does", () => {
    // The parse has to survive the spelling the stores actually use — a parenthesized list with spaces
    // after the commas. A counter that split on ", " and one that split on "," would disagree on exactly
    // the lists nobody writes carefully.
    expect(columnNames("(id, tenant,   kind)")).toEqual(["id", "tenant", "kind"]);
  });
});

describe("assertInsertArity — the params axis, which a derivation cannot close", () => {
  it("passes when the counts agree", () => {
    expect(() => assertInsertArity("x", "(a, b)", [1, 2])).not.toThrow();
  });

  it("names BOTH counts when they drift, so the message is the diagnosis", () => {
    // A driver error ("bind message supplies 2 parameters, but prepared statement requires 3") reads like a
    // database problem and names no column list. This has to say which two numbers disagree.
    expect(() => assertInsertArity("store.create", "(a, b, c)", [1, 2])).toThrow(
      /store\.create: INSERT lists 3 column\(s\) and was given 2 parameter\(s\)/,
    );
  });
});

describe("every store that was broken now builds a statement whose three lists agree", () => {
  it("PgScorecardStore.create", async () => {
    const { client, sql } = recording();
    await new PgScorecardStore(client).create({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      status: "queued",
      createdAt: now,
      updatedAt: now,
    } as ScorecardRecord);
    listsAgree(sql[0] ?? "", "everdict_scorecards");
  });

  it("PgIssueStore.create", async () => {
    const { client, sql } = recording();
    await new PgIssueStore(client).create({
      id: "i-1",
      tenant: "acme",
      number: 1,
      identifier: "ACME-1",
      title: "t",
      status: "todo",
      createdBy: "u",
      createdAt: now,
      updatedAt: now,
    } as IssueRecord);
    listsAgree(sql[0] ?? "", "everdict_issues");
  });

  it("PgProjectStore.create", async () => {
    const { client, sql } = recording();
    await new PgProjectStore(client).create({
      id: "p-1",
      tenant: "acme",
      name: "n",
      status: "planned",
      createdBy: "u",
      createdAt: now,
      updatedAt: now,
    } as ProjectRecord);
    listsAgree(sql[0] ?? "", "everdict_projects");
  });

  it("PgRunStore.create — the neighbour that was NOT broken, so a regression here is visible too", async () => {
    const { client, sql } = recording();
    await new PgRunStore(client).create({
      id: "r-1",
      tenant: "acme",
      status: "queued",
      harness: { id: "h", version: "1.0.0" },
      case: { id: "c1", task: "t" },
      createdAt: now,
      updatedAt: now,
    } as unknown as RunRecord);
    listsAgree(sql[0] ?? "", "everdict_runs");
  });
});
