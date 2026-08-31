import {
  ConflictError,
  type FsEntry,
  NotFoundError,
  type ScorecardRecord,
  type ViewRecord,
  ViewSnapshotSchema,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  type ScorecardGroupBy,
  type ScorecardGroupCount,
  type ScorecardListFilter,
  type ScorecardStore,
  countScorecardGroups,
} from "../ports/scorecard-store.js";
import type { ViewStore } from "../ports/view-store.js";
import type { FsFile, WorkspaceFs } from "../ports/workspace-fs.js";
import { ViewSnapshotService } from "./view-snapshot-service.js";

// Map-backed fakes — the real InMemory* impls live in @everdict/db, which application-control must not import.

class FakeViewStore implements ViewStore {
  readonly rows = new Map<string, ViewRecord>();
  async create(record: ViewRecord): Promise<void> {
    this.rows.set(`${record.tenant}/${record.id}`, record);
  }
  async get(tenant: string, id: string): Promise<ViewRecord | undefined> {
    return this.rows.get(`${tenant}/${id}`);
  }
  async listVisible(tenant: string, subject: string): Promise<ViewRecord[]> {
    return [...this.rows.values()].filter(
      (v) => v.tenant === tenant && (v.visibility === "workspace" || v.createdBy === subject),
    );
  }
  async update(): Promise<ViewRecord | undefined> {
    throw new Error("unused");
  }
  async remove(): Promise<void> {
    throw new Error("unused");
  }
}

class FakeScorecardStore implements ScorecardStore {
  constructor(private readonly records: ScorecardRecord[]) {}
  async list(tenant?: string, _filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    return this.records.filter((r) => tenant === undefined || r.tenant === tenant);
  }
  async create(): Promise<void> {
    throw new Error("unused");
  }
  async update(): Promise<ScorecardRecord | undefined> {
    throw new Error("unused");
  }
  async get(): Promise<ScorecardRecord | undefined> {
    throw new Error("unused");
  }
  async delete(): Promise<boolean> {
    throw new Error("unused");
  }
  // Counts the SAME rows this double's own `list` answers, through the one shared counter — a double that
  // answered `[]` here while holding rows would disagree with itself.
  async countByGroup(
    tenant: string | undefined,
    groupBy: ScorecardGroupBy,
    filter?: ScorecardListFilter,
  ): Promise<ScorecardGroupCount[]> {
    return countScorecardGroups(await this.list(tenant, filter), groupBy);
  }
}

class FakeFs implements WorkspaceFs {
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();
  private key(tenant: string, path: string) {
    return `${tenant} ${path}`;
  }
  async list(tenant: string, dir: string): Promise<FsEntry[]> {
    const base = dir === "" ? `${tenant} ` : `${tenant} ${dir}/`;
    return [...this.files.keys()]
      .filter((k) => k.startsWith(base) && !k.slice(base.length).includes("/"))
      .map((k) => {
        const name = k.slice(base.length);
        return { path: `${dir}/${name}`, name, kind: "file" as const };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async stat(): Promise<FsEntry | undefined> {
    throw new Error("unused");
  }
  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const hit = this.files.get(this.key(tenant, path));
    if (!hit) return undefined;
    const name = path.split("/").at(-1) ?? path;
    return { entry: { path, name, kind: "file", size: hit.data.byteLength }, data: hit.data };
  }
  async write(tenant: string, path: string, data: Uint8Array, contentType?: string): Promise<FsEntry> {
    this.files.set(this.key(tenant, path), { data, contentType: contentType ?? "application/octet-stream" });
    const name = path.split("/").at(-1) ?? path;
    return { path, name, kind: "file", size: data.byteLength };
  }
  async mkdir(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async remove(): Promise<number> {
    throw new ConflictError("CONFLICT", {}, "unused");
  }
  async move(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async writeRevisionBlob(): Promise<void> {
    /* versioning is the decorator's job */
  }
  async removeRevisionBlobs(): Promise<number> {
    return 0;
  }
  async readRevisionBlob(): Promise<FsFile | undefined> {
    return undefined;
  }
}

const scorecard = (id: string, extra: Partial<ScorecardRecord> = {}): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "smoke", version: "1.0.0" },
    harness: { id: "hermes", version: "1.0.0" },
    status: "succeeded",
    summary: [{ metric: "judge", count: 10, mean: 0.8, passRate: 0.8 }],
    steps: [],
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...extra,
  }) as ScorecardRecord;

const view = (extra: Partial<ViewRecord> = {}): ViewRecord => ({
  id: "v1",
  tenant: "acme",
  name: "Harness leaderboard",
  // A stored config is the FLAT deep-link map, not an AnalysisConfig object.
  config: { group: "harness", measure: "passRate", viz: "bars" },
  visibility: "workspace",
  createdBy: "user-1",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  ...extra,
});

const member = { kind: "member" as const, subject: "user-1" };

function build(views: ViewRecord[], records: ScorecardRecord[], clock: string[]) {
  const viewStore = new FakeViewStore();
  for (const v of views) viewStore.rows.set(`${v.tenant}/${v.id}`, v);
  const fs = new FakeFs();
  let tick = 0;
  const service = new ViewSnapshotService({
    views: viewStore,
    scorecards: new FakeScorecardStore(records),
    fs,
    now: () => clock[Math.min(tick++, clock.length - 1)] ?? "2026-07-01T00:00:00.000Z",
  });
  return { service, fs };
}

const readSnapshot = (fs: FakeFs, tenant: string, path: string) =>
  ViewSnapshotSchema.parse(
    JSON.parse(new TextDecoder().decode(fs.files.get(`${tenant} ${path}`)?.data ?? new Uint8Array())),
  );

describe("ViewSnapshotService", () => {
  it("writes the computed analysis, and the config that produced it, as JSON on the filesystem", async () => {
    const { service, fs } = build([view()], [scorecard("a"), scorecard("b")], ["2026-07-29T14:45:00.123Z"]);

    const ref = await service.capture({ tenant: "acme", viewId: "v1", actor: member });

    expect(ref.path).toBe("views/v1/2026-07-29T14-45-00Z.json"); // colons are not legal path characters
    const snapshot = readSnapshot(fs, "acme", ref.path);
    expect(snapshot.viewName).toBe("Harness leaderboard");
    expect(snapshot.capturedBy).toBe("user-1");
    expect(snapshot.trigger).toBe("manual");
    // The recipe travels WITH the numbers — a View edited later must not rewrite what this capture meant.
    expect(snapshot.config).toMatchObject({ groupBy: ["harness"], measure: "passRate", viz: "bars" });
    expect(snapshot.result.kind).toBe("grid");
    expect(snapshot.totals).toEqual({ scorecards: 2, cases: 20 });
    expect(fs.files.get("acme views/v1/2026-07-29T14-45-00Z.json")?.contentType).toBe("application/json");
  });

  it("accumulates: each capture is its own file, and the directory sorts by time", async () => {
    const { service, fs } = build(
      [view()],
      [scorecard("a")],
      ["2026-07-01T09:00:00.000Z", "2026-07-08T09:00:00.000Z", "2026-07-15T09:00:00.000Z"],
    );

    await service.capture({ tenant: "acme", viewId: "v1", actor: member });
    await service.capture({ tenant: "acme", viewId: "v1", actor: member });
    await service.capture({ tenant: "acme", viewId: "v1", actor: member });

    const entries = await fs.list("acme", "views/v1");
    expect(entries.map((e) => e.name)).toEqual([
      "2026-07-01T09-00-00Z.json",
      "2026-07-08T09-00-00Z.json",
      "2026-07-15T09-00-00Z.json",
    ]);
  });

  it("records a scheduled capture as such, so an automatic history is distinguishable from a hand-taken one", async () => {
    const { service, fs } = build([view()], [scorecard("a")], ["2026-07-29T00:00:00.000Z"]);

    const ref = await service.capture({
      tenant: "acme",
      viewId: "v1",
      actor: member,
      trigger: "schedule",
      scheduleId: "sch-1",
    });

    const snapshot = readSnapshot(fs, "acme", ref.path);
    expect(snapshot.trigger).toBe("schedule");
    expect(snapshot.scheduleId).toBe("sch-1");
  });

  it("captures a foreign private View as not-found — the snapshot path must not leak its existence", async () => {
    const { service, fs } = build(
      [view({ visibility: "private", createdBy: "someone-else" })],
      [scorecard("a")],
      ["2026-07-29T00:00:00.000Z"],
    );

    await expect(service.capture({ tenant: "acme", viewId: "v1", actor: member })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(fs.files.size).toBe(0);
  });

  it("scopes to the tenant — another workspace's scorecards never enter the snapshot", async () => {
    const { service, fs } = build(
      [view()],
      [scorecard("mine"), scorecard("theirs", { tenant: "other" })],
      ["2026-07-29T00:00:00.000Z"],
    );

    const ref = await service.capture({ tenant: "acme", viewId: "v1", actor: member });
    expect(readSnapshot(fs, "acme", ref.path).totals.scorecards).toBe(1);
  });

  it("weights the captured value by case count, like every other read of the engine", async () => {
    const { service, fs } = build(
      [view()],
      [
        scorecard("suite", { summary: [{ metric: "judge", count: 500, mean: 0.8, passRate: 0.8 }] }),
        scorecard("smoke", { summary: [{ metric: "judge", count: 5, mean: 1, passRate: 1 }] }),
      ],
      ["2026-07-29T00:00:00.000Z"],
    );

    const snapshot = readSnapshot(
      fs,
      "acme",
      (await service.capture({ tenant: "acme", viewId: "v1", actor: member })).path,
    );
    if (snapshot.result.kind !== "grid") throw new Error("expected grid");
    expect(snapshot.result.rows[0]?.value).toBeCloseTo((500 * 0.8 + 5) / 505, 6); // not 0.9
    expect(snapshot.totals.cases).toBe(505);
  });
});
