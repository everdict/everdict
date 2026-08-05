import type {
  IssueListFilter,
  IssuePageFilter,
  IssueStore,
  IssueTeamCounts,
  OutboxEvent,
} from "@everdict/application-control";
import {
  BadRequestError,
  CLOSED_ISSUE_STATUSES,
  ISSUE_PRIORITIES,
  type IssueGroupBy,
  type IssueGroupCount,
  type IssueOrder,
  type IssuePage,
  type IssueRecord,
  IssueRecordSchema,
  type IssueSummary,
  IssueSummarySchema,
} from "@everdict/contracts";
import {
  ISSUE_PRIORITIES_BY_RANK,
  type IssueOrderable,
  compareIssuesForList,
  isIssueAfterCursor,
  issueCountsByGroup,
  issueCountsByTeam,
  issueOrderKey,
  issueSummaryOf,
  orderIssueGroupCounts,
} from "@everdict/domain";

import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory, trackerIds } from "./row.js";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

// Which COLUMN each grouping reads. A closed lookup, not a name the caller hands us: the value is interpolated
// straight into the GROUP BY, and the only safe way to interpolate an identifier is to have written it here.
const GROUP_COLUMN: Record<IssueGroupBy, string> = {
  status: "status",
  priority: "priority",
  assignee: "assignee",
  project: "project_id",
  cycle: "cycle_id",
};

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

// Opaque page cursor — `order|sortKey|updatedAt|id` of the last row, base64url. The house shape
// (TrajectoryStore.list), with two things the shape alone does not give: the trailing (updatedAt, id) pair,
// because `updated_at` alone is not unique and two issues touched in the same millisecond would let a page
// boundary drop or repeat one of them; and the ORDERING the token was minted under, because a position in one
// sequence means nothing in another — resuming a priority-sorted list with a date cursor silently serves the
// wrong window rather than failing.
function encodeCursor(record: IssueOrderable, order: IssueOrder): string {
  return Buffer.from(`${order}|${issueOrderKey(record, order)}|${record.updatedAt}|${record.id}`, "utf8").toString(
    "base64url",
  );
}

interface CursorPosition {
  key: string;
  updatedAt: string;
  id: string;
}

// The token as it was minted, refused when it belongs to a different ordering. A TWO-field token is the legacy
// spelling from before orderings existed — it can only have meant `updated`, so a link somebody pasted then
// still resolves instead of 400-ing on a page they were reading.
function decodeCursor(cursor: string, order: IssueOrder): CursorPosition {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const parts = raw.split("|");
  if (parts.length === 2) {
    const [updatedAt, id] = parts;
    if (order !== "updated" || updatedAt === undefined || id === undefined || updatedAt === "")
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "This page cursor belongs to a different ordering. Start from the first page.",
      );
    return { key: updatedAt, updatedAt, id };
  }
  const [cursorOrder, key, updatedAt, ...rest] = parts;
  const id = rest.join("|"); // an id is opaque to us; only the first three separators are ours
  if (cursorOrder !== order || key === undefined || updatedAt === undefined || id === "")
    throw new BadRequestError(
      "BAD_REQUEST",
      undefined,
      "This page cursor belongs to a different ordering. Start from the first page.",
    );
  return { key, updatedAt, id };
}

// The tracker's issue ledger — same contract in-memory and on Postgres. Facts ride the E0 same-tx outbox
// (one statement, two writes), so an issue's state change and the fact describing it commit together.

function matchesFilter(record: IssueRecord, filter: IssueListFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.status !== undefined && record.status !== filter.status) return false;
  if (filter.teamId !== undefined && record.teamId !== filter.teamId) return false;
  if (filter.teamIds !== undefined && !filter.teamIds.includes(record.teamId)) return false;
  if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
  if (filter.assignee !== undefined && record.assignee !== filter.assignee) return false;
  if (filter.priority !== undefined && record.priority !== filter.priority) return false;
  if (filter.cycleId !== undefined && record.cycleId !== filter.cycleId) return false;
  if (filter.milestoneId !== undefined && record.milestoneId !== filter.milestoneId) return false;
  if (filter.stateId !== undefined && record.stateId !== filter.stateId) return false;
  if (filter.inTriage !== undefined && record.inTriage !== filter.inTriage) return false;
  // `null` means "top-level only", so it is checked against absence rather than against an id.
  if (filter.parentId === null && record.parentId !== undefined) return false;
  if (typeof filter.parentId === "string" && record.parentId !== filter.parentId) return false;
  if (filter.githubRepository !== undefined && record.github?.repository !== filter.githubRepository) return false;
  if (filter.syncPull === true && record.github?.sync.pull !== true) return false;
  if (filter.link !== undefined) {
    const { type, id } = filter.link;
    if (!record.links.some((link) => link.type === type && link.id === id)) return false;
  }
  if (filter.query !== undefined) {
    // Case-insensitive substring over what the issue is CITED by — the identifier it answers to now, the ones
    // it used to, and the title (never the description; see the port).
    const needle = filter.query.toLocaleLowerCase();
    const cited = [record.identifier, ...record.formerIdentifiers, record.title];
    if (!cited.some((text) => text.toLocaleLowerCase().includes(needle))) return false;
  }
  // The screen's set-per-facet filters. An EMPTY array selects nothing rather than everything: the caller asked
  // for "any of these" and named none, and widening that back to "all" would show rows they filtered out.
  if (filter.statuses !== undefined && !filter.statuses.includes(record.status)) return false;
  if (filter.priorities !== undefined && !filter.priorities.includes(record.priority)) return false;
  if (filter.assignees !== undefined && !matchesOptional(record.assignee, filter.assignees)) return false;
  if (filter.projectIds !== undefined && !matchesOptional(record.projectId, filter.projectIds)) return false;
  if (filter.cycleIds !== undefined && !matchesOptional(record.cycleId, filter.cycleIds)) return false;
  // Labels intersect rather than equal — an issue matches when it carries ANY of the asked-for labels.
  if (filter.labelIds !== undefined && !record.labelIds.some((id) => filter.labelIds?.includes(id))) return false;
  return true;
}

// An unset assignee/project/cycle is a real bucket a filter can name, spelled as the empty string on the wire
// (`?assignee=`) because a query parameter has no null. Absent from the record means it is in that bucket.
function matchesOptional(value: string | undefined, wanted: readonly string[]): boolean {
  return value === undefined ? wanted.includes("") : wanted.includes(value);
}

export class InMemoryIssueStore implements IssueStore {
  private readonly byId = new Map<string, IssueRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: IssueRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<IssueRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's row reads as nonexistent
  }

  // Current name first, then the names this issue used to have — a team move re-mints the identifier, and the
  // link somebody pasted last month has to keep landing here. Ordering matters: a name only ever appears in one
  // issue's `formerIdentifiers`, but the live spelling always wins.
  async getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined> {
    const rows = [...this.byId.values()].filter((record) => record.tenant === tenant);
    return (
      rows.find((record) => record.identifier === identifier) ??
      rows.find((record) => record.formerIdentifiers.includes(identifier))
    );
  }

  async getByGithub(
    tenant: string,
    repository: string,
    number: number,
    host?: string,
  ): Promise<IssueRecord | undefined> {
    return [...this.byId.values()].find(
      (record) =>
        record.tenant === tenant &&
        record.github?.repository === repository &&
        record.github.number === number &&
        record.github.host === host,
    );
  }

  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    const rows = this.ordered(tenant, filter);
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage> {
    const limit = clampLimit(filter?.limit);
    const order = filter?.order ?? "updated";
    const after = filter?.cursor !== undefined ? decodeCursor(filter.cursor, order) : undefined;
    // The same comparison the SQL cursor predicate makes, expressed once in the kernel, so a page boundary
    // lands on the same row in both implementations.
    const rows = this.ordered(tenant, filter, order).filter(
      (record) => after === undefined || isIssueAfterCursor(record, after, order),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(issueSummaryOf),
      ...(rows.length > limit && last !== undefined ? { nextCursor: encodeCursor(last, order) } : {}),
    };
  }

  async countByTeam(tenant: string): Promise<IssueTeamCounts[]> {
    return issueCountsByTeam([...this.byId.values()].filter((record) => record.tenant === tenant));
  }

  async countByGroup(tenant: string, groupBy: IssueGroupBy, filter?: IssueListFilter): Promise<IssueGroupCount[]> {
    return issueCountsByGroup(
      [...this.byId.values()].filter((record) => record.tenant === tenant && matchesFilter(record, filter)),
      groupBy,
    );
  }

  // The ONE ordering both list paths read, so `list` and `listSummaries` can never disagree about which issue
  // comes next. Whole-record `list` has no cursor and therefore no choice of ordering — it stays on the
  // newest-updated sequence its callers (the rollups, the sync) have always read.
  private ordered(tenant: string, filter?: IssueListFilter, order: IssueOrder = "updated"): IssueRecord[] {
    return [...this.byId.values()]
      .filter((record) => record.tenant === tenant && matchesFilter(record, filter))
      .sort((a, b) => compareIssuesForList(a, b, order));
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: IssueRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const current = this.byId.get(id);
    if (current && current.tenant === tenant) this.byId.delete(id);
  }

  // Test/dev inspection of the outbox half — the Pg impl's equivalent is the platform-events table.
  emittedEvents(): OutboxEvent[] {
    return [...this.events];
  }
}

interface IssueRow extends TrackerRow {
  team_id: string;
  number: number;
  identifier: string;
  former_identifiers: unknown;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  estimate: number | null;
  due_date: string | null;
  parent_id: string | null;
  cycle_id: string | null;
  milestone_id: string | null;
  state_id: string | null;
  in_triage: boolean;
  project_id: string | null;
  assignee: string | null;
  label_ids: unknown;
  links: unknown;
  resolution: unknown;
  github: unknown;
  origin: unknown;
}

// The projected row `listSummaries` selects — deliberately NOT `IssueRow`: the columns missing here are the
// point of the projection, and typing it as a partial record would let one creep back in unnoticed.
interface IssueSummaryRow {
  id: string;
  tenant: string;
  team_id: string;
  number: number;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  estimate: number | null;
  due_date: string | null;
  parent_id: string | null;
  cycle_id: string | null;
  milestone_id: string | null;
  state_id: string | null;
  in_triage: boolean;
  project_id: string | null;
  assignee: string | null;
  label_ids: unknown;
  resolution: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  link_count: string | number;
  github_repository: string | null;
  github_host: string | null;
  github_pull: boolean;
}

function rowToSummary(row: IssueSummaryRow): IssueSummary {
  return IssueSummarySchema.parse({
    id: row.id,
    tenant: row.tenant,
    teamId: row.team_id,
    number: row.number,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    ...(row.estimate !== null ? { estimate: row.estimate } : {}),
    ...(row.due_date !== null ? { dueDate: row.due_date } : {}),
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    ...(row.cycle_id !== null ? { cycleId: row.cycle_id } : {}),
    ...(row.milestone_id !== null ? { milestoneId: row.milestone_id } : {}),
    ...(row.state_id !== null ? { stateId: row.state_id } : {}),
    inTriage: row.in_triage,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.assignee !== null ? { assignee: row.assignee } : {}),
    labelIds: row.label_ids ?? [],
    linkCount: Number(row.link_count),
    ...(row.resolution !== null ? { resolution: row.resolution } : {}),
    // No repository = no GitHub copy: the column is derived from `github->>'repository'`, which is NULL exactly
    // when the jsonb is absent.
    ...(row.github_repository !== null
      ? {
          github: {
            ...(row.github_host !== null ? { host: row.github_host } : {}),
            repository: row.github_repository,
            pull: row.github_pull,
          },
        }
      : {}),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

const ISSUE_COLUMNS =
  "(id, tenant, team_id, number, identifier, former_identifiers, title, description, status, priority, estimate, due_date, parent_id, cycle_id, milestone_id, state_id, in_triage, project_id, assignee, label_ids, links, resolution, github, history, created_by, origin, created_at, updated_at)";
const ISSUE_VALUES =
  "($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,$25,$26::jsonb,$27::timestamptz,$28::timestamptz)";

function insertParams(record: IssueRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.teamId,
    record.number,
    record.identifier,
    JSON.stringify(record.formerIdentifiers),
    record.title,
    record.description ?? null,
    record.status,
    record.priority,
    record.estimate ?? null,
    record.dueDate ?? null,
    record.parentId ?? null,
    record.cycleId ?? null,
    record.milestoneId ?? null,
    record.stateId ?? null,
    record.inTriage,
    record.projectId ?? null,
    record.assignee ?? null,
    JSON.stringify(record.labelIds),
    JSON.stringify(record.links),
    record.resolution === undefined ? null : JSON.stringify(record.resolution),
    record.github === undefined ? null : JSON.stringify(record.github),
    JSON.stringify(record.history),
    record.createdBy,
    record.origin === undefined ? null : JSON.stringify(record.origin),
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: IssueRow): IssueRecord {
  return IssueRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    teamId: row.team_id,
    number: row.number,
    identifier: row.identifier,
    formerIdentifiers: trackerIds(row.former_identifiers),
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    priority: row.priority,
    ...(row.estimate !== null ? { estimate: row.estimate } : {}),
    ...(row.due_date !== null ? { dueDate: row.due_date } : {}),
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    ...(row.cycle_id !== null ? { cycleId: row.cycle_id } : {}),
    ...(row.milestone_id !== null ? { milestoneId: row.milestone_id } : {}),
    ...(row.state_id !== null ? { stateId: row.state_id } : {}),
    inTriage: row.in_triage,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.assignee !== null ? { assignee: row.assignee } : {}),
    labelIds: row.label_ids ?? [],
    links: row.links ?? [],
    ...(row.resolution !== null ? { resolution: row.resolution } : {}),
    ...(row.github !== null ? { github: row.github } : {}),
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    ...(row.origin !== null ? { origin: row.origin } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgIssueStore implements IssueStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: IssueRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_issues ${ISSUE_COLUMNS} VALUES ${ISSUE_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_issues ${ISSUE_COLUMNS} VALUES ${ISSUE_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<IssueRecord | undefined> {
    const { rows } = await this.client.query<IssueRow>("SELECT * FROM everdict_issues WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  // Served by the (tenant, identifier) unique index from migration 0105 — the same index that makes the
  // identifier a safe URL key in the first place — with the GIN-indexed `former_identifiers` (0108) as the
  // fallback, so a link minted before a team move still lands on the issue it named. The ORDER BY is what makes
  // the live spelling win: both branches can only ever match one row, but never the same one.
  async getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined> {
    const { rows } = await this.client.query<IssueRow>(
      `SELECT * FROM everdict_issues
       WHERE tenant=$1 AND (identifier=$2 OR former_identifiers @> $3::jsonb)
       ORDER BY (identifier=$2) DESC
       LIMIT 1`,
      [tenant, identifier, JSON.stringify([identifier])],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getByGithub(
    tenant: string,
    repository: string,
    number: number,
    host?: string,
  ): Promise<IssueRecord | undefined> {
    const { rows } = await this.client.query<IssueRow>(
      `SELECT * FROM everdict_issues
       WHERE tenant=$1 AND github->>'repository' = $2 AND (github->>'number')::int = $3
         AND (github->>'host') IS NOT DISTINCT FROM $4
       LIMIT 1`,
      [tenant, repository, number, host ?? null],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  // The narrowing both list paths share. Built once so `list` (whole records) and `listSummaries` (the
  // projection) can never disagree about which issues a filter selects — only about how much of each it reads.
  private static where(tenant: string, filter: IssueListFilter | undefined): { conds: string[]; params: unknown[] } {
    const conds = ["tenant = $1"];
    const params: unknown[] = [tenant];
    const next = () => `$${params.length + 1}`;
    if (filter?.status !== undefined) {
      conds.push(`status = ${next()}`);
      params.push(filter.status);
    }
    if (filter?.teamId !== undefined) {
      conds.push(`team_id = ${next()}`);
      params.push(filter.teamId);
    }
    if (filter?.teamIds !== undefined) {
      // Empty roster = no rows, expressed as a false predicate rather than an `IN ()` the parser rejects.
      if (filter.teamIds.length === 0) conds.push("false");
      else {
        conds.push(`team_id = ANY(${next()}::text[])`);
        params.push(filter.teamIds);
      }
    }
    if (filter?.projectId !== undefined) {
      conds.push(`project_id = ${next()}`);
      params.push(filter.projectId);
    }
    if (filter?.priority !== undefined) {
      conds.push(`priority = ${next()}`);
      params.push(filter.priority);
    }
    if (filter?.cycleId !== undefined) {
      conds.push(`cycle_id = ${next()}`);
      params.push(filter.cycleId);
    }
    if (filter?.milestoneId !== undefined) {
      conds.push(`milestone_id = ${next()}`);
      params.push(filter.milestoneId);
    }
    if (filter?.stateId !== undefined) {
      conds.push(`state_id = ${next()}`);
      params.push(filter.stateId);
    }
    if (filter?.inTriage !== undefined) {
      conds.push(filter.inTriage ? "in_triage" : "NOT in_triage");
    }
    if (filter?.parentId === null) conds.push("parent_id IS NULL");
    else if (typeof filter?.parentId === "string") {
      conds.push(`parent_id = ${next()}`);
      params.push(filter.parentId);
    }
    if (filter?.assignee !== undefined) {
      conds.push(`assignee = ${next()}`);
      params.push(filter.assignee);
    }
    if (filter?.githubRepository !== undefined) {
      conds.push(`github->>'repository' = ${next()}`);
      params.push(filter.githubRepository);
    }
    if (filter?.syncPull === true) conds.push("(github->'sync'->>'pull') = 'true'");
    if (filter?.link !== undefined) {
      // Containment over the links array — id-level, version-agnostic (a cross-version regression is the signal).
      conds.push(`links @> ${next()}::jsonb`);
      params.push(JSON.stringify([{ type: filter.link.type, id: filter.link.id }]));
    }
    if (filter?.query !== undefined) {
      // What the issue is CITED by: the identifier it answers to now, the ones it used to answer to, and the
      // title. `%` and `_` are escaped so a title containing them searches for the characters rather than for
      // whatever LIKE would read them as.
      // One placeholder, referenced three times — the same needle in each column (rebinding it per column
      // would be three parameters saying the same thing).
      const needle = next();
      conds.push(
        `(identifier ILIKE ${needle} OR title ILIKE ${needle} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(former_identifiers, '[]'::jsonb)) AS former WHERE former ILIKE ${needle}))`,
      );
      params.push(`%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    // The screen's set-per-facet filters. `= ANY` rather than `IN` so the whole set rides as ONE parameter —
    // a filter bar with eight labels selected must not rewrite the statement into a shape the plan cache has
    // never seen. An empty set is a false predicate, mirroring `matchesFilter`: naming no value in a facet you
    // opened selects nothing, not everything.
    for (const [column, values] of [
      ["status", filter?.statuses],
      ["priority", filter?.priorities],
    ] as const) {
      if (values === undefined) continue;
      if (values.length === 0) conds.push("false");
      else {
        conds.push(`${column} = ANY(${next()}::text[])`);
        params.push([...values]);
      }
    }
    // The nullable columns carry the unset bucket, spelled as the empty string on the wire — "unassigned" is a
    // group a member filters to, so `IS NULL` has to be part of the same predicate rather than a second call.
    for (const [column, values] of [
      ["assignee", filter?.assignees],
      ["project_id", filter?.projectIds],
      ["cycle_id", filter?.cycleIds],
    ] as const) {
      if (values === undefined) continue;
      const named = values.filter((value) => value !== "");
      const wantsUnset = values.length !== named.length;
      if (named.length === 0 && !wantsUnset) conds.push("false");
      else if (named.length === 0) conds.push(`${column} IS NULL`);
      else {
        const predicate = `${column} = ANY(${next()}::text[])`;
        params.push(named);
        conds.push(wantsUnset ? `(${predicate} OR ${column} IS NULL)` : predicate);
      }
    }
    if (filter?.labelIds !== undefined) {
      // `?|` = "does this jsonb array contain ANY of these keys" — the intersection reading a label filter has.
      if (filter.labelIds.length === 0) conds.push("false");
      else {
        conds.push(`label_ids ?| ${next()}::text[]`);
        params.push([...filter.labelIds]);
      }
    }
    return { conds, params };
  }

  // The SQL spelling of `issueOrderKey` — the sort expression plus the cast its cursor value needs. It MUST
  // produce the same ordering the kernel does, which is why the two ascending orderings are inverted here the
  // same way: priority by subtracting from the vocabulary size, a due date by complementing each digit.
  //
  // `updated`/`created` sort on a bare column and keep the (tenant, …, updated_at DESC) index seek. The other
  // two sort on an expression and therefore cost a sort — deliberately: they are chosen deliberately, from a
  // display menu, and an ordering that agrees with the in-memory store is worth more here than an index.
  private static orderKey(order: IssueOrder, params: unknown[]): { expr: string; cast: string } {
    switch (order) {
      case "updated":
        return { expr: "updated_at", cast: "::timestamptz" };
      case "created":
        return { expr: "created_at", cast: "::timestamptz" };
      case "priority": {
        params.push([...ISSUE_PRIORITIES_BY_RANK]);
        return {
          expr: `(${ISSUE_PRIORITIES.length + 1} - array_position($${params.length}::text[], priority))`,
          cast: "::int",
        };
      }
      case "due":
        // COALESCE AFTER the complement, never before: complementing the placeholder would turn "no deadline"
        // into 9999-99-99 and sort the issues nobody dated to the very front.
        return { expr: `COALESCE(translate(due_date, '0123456789', '9876543210'), '0000-00-00')`, cast: "::text" };
    }
  }

  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    const { conds, params } = PgIssueStore.where(tenant, filter);
    let sql = `SELECT * FROM everdict_issues WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC, id DESC`;
    if (filter?.limit !== undefined) {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<IssueRow>(sql, params);
    return rows.map(rowToRecord);
  }

  // The list projection. `description`, `history`, `links`, `former_identifiers` and `origin` are never
  // selected — the row is assembled from the handful of columns a list row draws, plus two derived scalars
  // (the link COUNT and the GitHub marker) computed in SQL instead of by shipping the jsonb to be measured here.
  async listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage> {
    const limit = clampLimit(filter?.limit);
    const order = filter?.order ?? "updated";
    const { conds, params } = PgIssueStore.where(tenant, filter);
    const { expr, cast } = PgIssueStore.orderKey(order, params);
    const after = filter?.cursor !== undefined ? decodeCursor(filter.cursor, order) : undefined;
    if (after !== undefined && order === "updated") {
      // The default ordering sorts on the column the page is already keyed by, so the boundary stays a single
      // row-value comparison matching the ORDER BY — which is what lets the (tenant, …, updated_at DESC)
      // indexes seek straight to the page instead of scanning and discarding everything before it.
      conds.push(`(updated_at, id) < ($${params.length + 1}::timestamptz, $${params.length + 2})`);
      params.push(after.updatedAt, after.id);
    } else if (after !== undefined) {
      // Every other ordering: "past the boundary in this sequence", spelled the way `isIssueAfterCursor` spells
      // it — strictly beyond the sort key, or level with it and past the (updated_at, id) tail. Two branches
      // rather than one row value, because a row value cannot mix a computed key with stored columns.
      const k = `$${params.length + 1}${cast}`;
      const u = `$${params.length + 2}::timestamptz`;
      const i = `$${params.length + 3}`;
      conds.push(`(${expr} < ${k} OR (${expr} = ${k} AND (updated_at, id) < (${u}, ${i})))`);
      params.push(after.key, after.updatedAt, after.id);
    }
    const { rows } = await this.client.query<IssueSummaryRow>(
      `SELECT id, tenant, team_id, number, identifier, title, status, priority, estimate, due_date,
              parent_id, cycle_id, milestone_id, state_id, in_triage, project_id, assignee,
              label_ids, resolution, created_by, created_at, updated_at,
              COALESCE(jsonb_array_length(links), 0) AS link_count,
              github->>'repository' AS github_repository,
              github->>'host' AS github_host,
              COALESCE((github->'sync'->>'pull') = 'true', false) AS github_pull
       FROM everdict_issues
       WHERE ${conds.join(" AND ")}
       ORDER BY ${order === "updated" ? "" : `${expr} DESC, `}updated_at DESC, id DESC
       LIMIT ${limit + 1}`,
      params,
    );
    const items = rows.slice(0, limit).map(rowToSummary);
    const last = items[items.length - 1];
    return {
      items,
      // The token is minted from the ROW, through the same kernel function the in-memory store uses — never
      // from the SQL expression, which would put the sort key's SQL spelling in a token the other store reads.
      ...(rows.length > limit && last !== undefined ? { nextCursor: encodeCursor(last, order) } : {}),
    };
  }

  // One GROUP BY for the whole grouped screen. The alternative — a count per group — is a query per member on
  // a list grouped by assignee, and it still could not name the groups that hold no rows the page fetched.
  async countByGroup(tenant: string, groupBy: IssueGroupBy, filter?: IssueListFilter): Promise<IssueGroupCount[]> {
    const { conds, params } = PgIssueStore.where(tenant, filter);
    const column = GROUP_COLUMN[groupBy];
    const { rows } = await this.client.query<{ key: string | null; count: string | number }>(
      `SELECT ${column} AS key, count(*) AS count
       FROM everdict_issues WHERE ${conds.join(" AND ")} GROUP BY ${column}`,
      params,
    );
    // Ordered through the kernel, not by SQL: "largest first, unset last" is one rule, and an ORDER BY here
    // would be a second copy of it that can drift from the in-memory store's.
    return orderIssueGroupCounts(rows.map((row) => ({ key: row.key, count: Number(row.count) })));
  }

  // One GROUP BY over the issue table instead of a fetch per team. `FILTER` is what keeps "how many, and how
  // many open" a single pass; the closed vocabulary rides in as a parameter so the SQL and `isOpenIssueStatus`
  // are the same statement.
  async countByTeam(tenant: string): Promise<IssueTeamCounts[]> {
    const { rows } = await this.client.query<{ team_id: string; total: string | number; open: string | number }>(
      `SELECT team_id,
              count(*) AS total,
              count(*) FILTER (WHERE status <> ALL($2::text[])) AS open
       FROM everdict_issues WHERE tenant = $1 GROUP BY team_id`,
      [tenant, [...CLOSED_ISSUE_STATUSES]],
    );
    return rows.map((row) => ({ teamId: row.team_id, total: Number(row.total), open: Number(row.open) }));
  }

  // Fetch-merge-write: the tracker is low-contention (a human or one consumer at a time), and the merge keeps
  // the jsonb columns whole rather than hand-writing a SET clause per optional field.
  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: IssueRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    // team_id/number/identifier are in the SET clause because a team move rewrites all three (plus the former
    // names) — the whole record is written on every update, so a field that transitions must be listed here or
    // the transition silently does nothing.
    const sets = `team_id=$3, number=$4, identifier=$5, former_identifiers=$6::jsonb, title=$7, description=$8,
       status=$9, priority=$10, estimate=$11, due_date=$12, parent_id=$13, cycle_id=$14, milestone_id=$15,
       state_id=$16, in_triage=$17, project_id=$18, assignee=$19, label_ids=$20::jsonb, links=$21::jsonb,
       resolution=$22::jsonb, github=$23::jsonb, history=$24::jsonb, origin=$25::jsonb,
       updated_at=$26::timestamptz`;
    const params: unknown[] = [
      tenant,
      id,
      next.teamId,
      next.number,
      next.identifier,
      JSON.stringify(next.formerIdentifiers),
      next.title,
      next.description ?? null,
      next.status,
      next.priority,
      next.estimate ?? null,
      next.dueDate ?? null,
      next.parentId ?? null,
      next.cycleId ?? null,
      next.milestoneId ?? null,
      next.stateId ?? null,
      next.inTriage,
      next.projectId ?? null,
      next.assignee ?? null,
      JSON.stringify(next.labelIds),
      JSON.stringify(next.links),
      next.resolution === undefined ? null : JSON.stringify(next.resolution),
      next.github === undefined ? null : JSON.stringify(next.github),
      JSON.stringify(next.history),
      next.origin === undefined ? null : JSON.stringify(next.origin),
      next.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<IssueRow>(
        `WITH upd AS (UPDATE everdict_issues SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<IssueRow>(
      `UPDATE everdict_issues SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_issues WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
