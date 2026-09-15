import type { WorkflowStateRecord } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowStateStore } from "../ports/workflow-state-store.js";
import { WorkflowStateService, type WorkflowStateServiceDeps } from "./workflow-state-service.js";

// ── ONE BOARD, THE WORKSPACE'S ───────────────────────────────────────────────────────────────────────
//
// A workflow state was a TEAM's column: the store read `listByTeam`, and every column belonged to whichever
// team's sidebar it appeared in. With the workspace as the only boundary there is one board — so the store reads
// `listByTenant`, and the tests below are what that collapse means rather than a per-team rule with the team
// argument deleted.

const NOW = "2026-08-03T00:00:00.000Z";

function fakeStore() {
  const rows: WorkflowStateRecord[] = [];
  const store: WorkflowStateStore = {
    async create(record) {
      rows.push(record);
    },
    // COPIES, not references — Postgres hands back a fresh row (rule `testing`: a double answers the way the
    // real one would).
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
  };
  return { rows, store };
}

function service(store: WorkflowStateStore) {
  let n = 0;
  const deps: WorkflowStateServiceDeps = {
    store,
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

    // Then: it was seeded, in position order, and the second read did not seed again — a board that re-seeds on
    // every read would grow a duplicate board per visit.
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((s) => s.position)).toEqual([...first.map((_, i) => i)]);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
    expect(fake.rows).toHaveLength(first.length);
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
});
