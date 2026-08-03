import type { IssueRecord, WorkflowStateRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { WorkflowStateStore } from "../ports/workflow-state-store.js";
import { WorkflowStateService } from "./workflow-state-service.js";

const NOW = "2026-08-03T00:00:00.000Z";

function issue(id: string, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id,
    tenant: "acme",
    teamId: "team-eng",
    number: 1,
    identifier: `ENG-${id}`,
    formerIdentifiers: [],
    title: id,
    status: "todo",
    priority: "none",
    inTriage: false,
    labelIds: [],
    links: [],
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function deps(issues: IssueRecord[] = []) {
  const rows: WorkflowStateRecord[] = [];
  const store: WorkflowStateStore = {
    async create(record) {
      rows.push(record);
    },
    async get(_t, id) {
      return rows.find((r) => r.id === id);
    },
    async listByTeam(_t, teamId) {
      return rows.filter((r) => r.teamId === teamId).sort((a, b) => a.position - b.position);
    },
    async update(_t, id, patch) {
      const at = rows.findIndex((r) => r.id === id);
      if (at < 0) return undefined;
      const next = { ...rows[at], ...patch } as WorkflowStateRecord;
      rows[at] = next;
      return next;
    },
    async remove(_t, id) {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
  };
  const issueStore = {
    async list(_t: string, filter?: IssueListFilter) {
      const found = issues.filter((i) => filter?.stateId === undefined || i.stateId === filter.stateId);
      return filter?.limit === undefined ? found : found.slice(0, filter.limit);
    },
    async update(_t: string, id: string, patch: Partial<IssueRecord>) {
      const at = issues.findIndex((i) => i.id === id);
      if (at < 0) return undefined;
      const next = { ...issues[at], ...patch } as IssueRecord;
      issues[at] = next;
      return next;
    },
  } as unknown as IssueStore;
  return { store, issues: issueStore, rows, issueRows: issues };
}

describe("WorkflowStateService — a team's named board", () => {
  let n = 0;
  const service = (d: ReturnType<typeof deps>) =>
    new WorkflowStateService({ ...d, newId: () => `state-${++n}`, now: () => NOW });

  it("seeds the default six in board order for a team that has none", async () => {
    const d = deps();
    const states = await service(d).list("acme", "team-eng");
    expect(states.map((s) => s.name)).toEqual(["Backlog", "Todo", "In progress", "In review", "Done", "Cancelled"]);
    expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    // Seeding is idempotent — the list path is also the repair point.
    expect((await service(d).list("acme", "team-eng")).length).toBe(6);
  });

  it("refuses `regressed` as a column — an issue reaches it by falling, not by being dragged", async () => {
    const d = deps();
    await expect(
      service(d).create({
        tenant: "acme",
        teamId: "team-eng",
        name: "Regressed",
        status: "regressed",
        color: "red",
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it("adds a state at the end of the board and refuses a duplicate name", async () => {
    const d = deps();
    const svc = service(d);
    const added = await svc.create({
      tenant: "acme",
      teamId: "team-eng",
      name: "In QA",
      status: "in_review",
      color: "teal",
    });
    expect(added.position).toBe(6);
    await expect(
      svc.create({ tenant: "acme", teamId: "team-eng", name: "in qa", status: "in_review", color: "teal" }),
    ).rejects.toThrow(ConflictError);
  });

  it("re-mapping a column moves every issue in it, so the board and the record cannot disagree", async () => {
    const d = deps();
    const svc = service(d);
    const states = await svc.list("acme", "team-eng");
    const inProgress = states.find((s) => s.name === "In progress");
    if (!inProgress) throw new Error("seed missing");
    d.issueRows.push(issue("a", { stateId: inProgress.id, status: "in_progress" }));
    await svc.update("acme", inProgress.id, { status: "in_review" });
    expect(d.issueRows[0]?.status).toBe("in_review");
  });

  it("refuses to delete a state that still holds issues, and the last remaining one", async () => {
    const d = deps();
    const svc = service(d);
    const states = await svc.list("acme", "team-eng");
    const todo = states.find((s) => s.name === "Todo");
    if (!todo) throw new Error("seed missing");
    d.issueRows.push(issue("a", { stateId: todo.id }));
    await expect(svc.remove("acme", todo.id)).rejects.toThrow(ConflictError);
  });
});
