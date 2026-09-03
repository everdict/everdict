import { BadRequestError, ConflictError } from "@everdict/contracts";
import type { IssueRecord, WorkflowStateRecord } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { WorkflowStateStore } from "../ports/workflow-state-store.js";
import { WorkflowStateService, type WorkflowStateServiceDeps } from "./workflow-state-service.js";

// ── ONE BOARD, THE WORKSPACE'S ───────────────────────────────────────────────────────────────────────
//
// A workflow state was a TEAM's column: the store read `listByTeam`, uniqueness was per (tenant, team), and
// every column belonged to whichever team's sidebar it appeared in. With the workspace as the only boundary
// there is one board — so the store reads `listByTenant`, and the tests below are what that collapse means
// rather than a per-team rule with the team argument deleted.

const NOW = "2026-08-03T00:00:00.000Z";

function fakeStore() {
  const rows: WorkflowStateRecord[] = [];
  const store: WorkflowStateStore = {
    async create(record) {
      rows.push(record);
    },
    // ⚠️ COPIES, not references. Postgres hands back a fresh row, and `update` compares the status it is
    // about to write against the record `get` returned — so a double that hands out the STORED object makes
    // that comparison read the new value and silently skip the issue re-map (rule `testing`: a double answers
    // the way the real one would).
    async get(tenant, id) {
      const row = rows.find((r) => r.tenant === tenant && r.id === id);
      return row ? { ...row } : undefined;
    },
    async listByTenant(tenant) {
      return rows
        .filter((r) => r.tenant === tenant)
        .sort((a, b) => a.position - b.position)
        .map((r) => ({ ...r }));
    },
    async update(tenant, id, patch) {
      const i = rows.findIndex((r) => r.tenant === tenant && r.id === id);
      const row = rows[i];
      if (i < 0 || !row) return undefined;
      const next = { ...row, ...patch };
      rows[i] = next;
      return { ...next };
    },
    async remove(tenant, id) {
      const i = rows.findIndex((r) => r.tenant === tenant && r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
  return { rows, store };
}

function issue(id: string, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id,
    tenant: "acme",
    number: 1,
    identifier: `EVD-${id}`,
    formerIdentifiers: [],
    title: id,
    status: "todo",
    priority: "none",
    labelIds: [],
    links: [],
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

// The issue ledger the service actually reads: `list({stateId})` is the delete gate's count AND the working set
// a re-map moves, and `update` is how that move lands. A double that answers `[]` to both would make the two
// invariants below vacuously green (rule `testing` — a fake more permissive than the real thing).
function fakeIssues(rows: IssueRecord[]) {
  const issues = {
    async list(_tenant: string, filter?: IssueListFilter) {
      const found = rows.filter((r) => filter?.stateId === undefined || r.stateId === filter.stateId);
      return filter?.limit === undefined ? found : found.slice(0, filter.limit);
    },
    async update(_tenant: string, id: string, patch: Partial<IssueRecord>) {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
  };
  return issues as unknown as IssueStore;
}

function service(store: WorkflowStateStore, issueRows: IssueRecord[] = []) {
  let n = 0;
  const deps: WorkflowStateServiceDeps = {
    store,
    issues: fakeIssues(issueRows),
    newId: () => `st-${++n}`,
    now: () => NOW,
  };
  return new WorkflowStateService(deps);
}

describe("WorkflowStateService — the workspace's board", () => {
  let fake: ReturnType<typeof fakeStore>;
  beforeEach(() => {
    fake = fakeStore();
  });

  it("seeds a default board once, and a second read returns the same columns", async () => {
    // Given: a workspace whose board has never been opened
    const svc = service(fake.store);

    // When: the board is read twice
    const first = await svc.ensureDefaults("acme");
    const second = await svc.ensureDefaults("acme");

    // Then: it was seeded, in position order, and the second read did not seed again — a settings screen that
    // re-seeds on every open would grow a duplicate board per visit.
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((s) => s.position)).toEqual([...first.map((_, i) => i)]);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
  });

  it("keeps each workspace's board its own", async () => {
    // Given: two workspaces
    const svc = service(fake.store);
    await svc.ensureDefaults("acme");
    await svc.ensureDefaults("globex");

    // Then: neither sees the other's columns — the workspace is the boundary the team used to be
    const acme = await svc.ensureDefaults("acme");
    expect(acme.every((s) => s.tenant === "acme")).toBe(true);
    expect(await svc.ensureDefaults("globex")).toHaveLength(acme.length);
  });

  it("refuses a second column with the same name — the board is one namespace now", async () => {
    // Given: a seeded board
    const svc = service(fake.store);
    const seeded = await svc.ensureDefaults("acme");
    const taken = seeded[0];
    expect(taken, "the board seeded nothing, so this proves nothing about naming").toBeDefined();

    // When: a column reuses an existing name (case-insensitively, as the service compares)
    // Then: refused. Uniqueness used to be per (tenant, team); one board makes it per workspace.
    await expect(
      svc.create({ tenant: "acme", name: (taken?.name ?? "").toUpperCase(), status: "todo", color: "gray" }),
    ).rejects.toThrow(ConflictError);
  });

  it("answers which column a canonical status falls into", async () => {
    // Given: the default board
    const svc = service(fake.store);
    const seeded = await svc.ensureDefaults("acme");

    // Then: a status resolves to the column that carries it — the fallback for an issue that names none
    const todo = await svc.defaultFor("acme", "todo");
    expect(todo?.status).toBe("todo");
    expect(seeded.some((s) => s.id === todo?.id)).toBe(true);
  });

  it("refuses `regressed` as a column — an issue reaches it by falling, not by being dragged", async () => {
    // Given: a board (the status vocabulary is the workspace's, but `regressed` is not a place to drag a card)
    const svc = service(fake.store);

    // Then: declaring a column onto it is refused
    await expect(svc.create({ tenant: "acme", name: "Regressed", status: "regressed", color: "red" })).rejects.toThrow(
      BadRequestError,
    );
  });

  it("adds a column at the END of the board", async () => {
    // Given: the seeded board
    const svc = service(fake.store);
    const seeded = await svc.ensureDefaults("acme");

    // When: a column is added
    const added = await svc.create({ tenant: "acme", name: "In QA", status: "in_review", color: "teal" });

    // Then: it lands after every existing one — a new column must not silently reorder the board
    expect(added.position).toBe(seeded.length);
  });

  it("re-mapping a column moves every issue in it, so the board and the record cannot disagree", async () => {
    // Given: a column with an issue in it
    const rows: IssueRecord[] = [];
    const svc = service(fake.store, rows);
    const seeded = await svc.ensureDefaults("acme");
    const inProgress = seeded.find((s) => s.status === "in_progress");
    expect(inProgress, "the seeded board has no in_progress column to re-map").toBeDefined();
    if (!inProgress) return;
    rows.push(issue("a", { stateId: inProgress.id, status: "in_progress" }));

    // When: the column is re-mapped to another canonical status
    await svc.update("acme", inProgress.id, { status: "in_review" });

    // Then: the issue moved with it. The canonical status is what the rollups, the release gate and the
    // regression watch read — a column that re-maps without taking its issues leaves those reading the old one.
    expect(rows[0]?.status).toBe("in_review");
  });

  it("refuses to delete a column that still holds issues", async () => {
    // Given: a column with an issue in it
    const rows: IssueRecord[] = [];
    const svc = service(fake.store, rows);
    const seeded = await svc.ensureDefaults("acme");
    const todo = seeded.find((s) => s.status === "todo");
    expect(todo, "the seeded board has no todo column").toBeDefined();
    if (!todo) return;
    rows.push(issue("a", { stateId: todo.id }));

    // Then: removing it is refused — the issues would name a column that no longer exists, and where they
    // should go instead is the member's decision rather than the service's.
    await expect(svc.remove("acme", todo.id)).rejects.toThrow(ConflictError);
  });
});
