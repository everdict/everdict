import {
  FsService,
  RevisionedWorkspaceFs,
  RunService,
  ViewService,
  ViewSnapshotService,
} from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryFsRevisionStore, InMemoryRunStore, InMemoryScorecardStore, InMemoryViewStore } from "@everdict/db";
import { InMemoryWorkspaceFs } from "@everdict/storage";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in view tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

// The composition main.ts wires: one revisioned filesystem shared by the Files surface and by view captures, so a
// capture publishes an attributed revision like any other write.
function build() {
  const ledger = new InMemoryFsRevisionStore();
  const fs = new RevisionedWorkspaceFs(new InMemoryWorkspaceFs(), ledger);
  const viewStore = new InMemoryViewStore();
  const scorecardStore = new InMemoryScorecardStore();
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    fsService: new FsService(fs, ledger),
    viewService: new ViewService({ store: viewStore }),
    viewSnapshotService: new ViewSnapshotService({ views: viewStore, scorecards: scorecardStore, fs }),
  });
  return { app, scorecardStore };
}

const scorecard = (id: string, passRate: number, cases: number) => ({
  id,
  tenant: "acme",
  dataset: { id: "smoke", version: "1.0.0" },
  harness: { id: "hermes", version: "1.0.0" },
  status: "succeeded" as const,
  summary: [{ metric: "judge", count: cases, mean: passRate, passRate }],
  steps: [],
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
});

async function createView(app: ReturnType<typeof build>["app"]) {
  const res = await app.inject({
    method: "POST",
    url: "/views",
    headers: H,
    payload: {
      name: "Harness leaderboard",
      // A stored config is the flat deep-link map the web persists, not an AnalysisConfig object.
      config: { group: "harness", measure: "passRate", viz: "bars" },
      visibility: "workspace",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("view snapshots (capturing a View onto the workspace filesystem)", () => {
  it("captures the view as JSON and the file is readable through the ordinary /fs surface", async () => {
    const { app, scorecardStore } = build();
    await scorecardStore.create(scorecard("a", 0.8, 500));
    await scorecardStore.create(scorecard("b", 1, 5));
    const id = await createView(app);

    const capture = await app.inject({ method: "POST", url: `/views/${id}/snapshots`, headers: H });
    expect(capture.statusCode).toBe(200);
    const { path, totals } = capture.json();
    expect(path).toMatch(new RegExp(`^views/${id}/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z\\.json$`));
    expect(totals).toEqual({ scorecards: 2, cases: 505 });

    // No new read API: the accumulated file is just a file.
    const read = await app.inject({ method: "GET", url: `/fs/file?path=${path}`, headers: H });
    expect(read.statusCode).toBe(200);
    const snapshot = JSON.parse(read.json().content);
    expect(snapshot.viewName).toBe("Harness leaderboard");
    expect(snapshot.trigger).toBe("manual");
    expect(snapshot.config).toMatchObject({ groupBy: ["harness"], measure: "passRate" });
    // Case-weighted, like every other read of the engine — not the 0.9 an unweighted mean would give.
    expect(snapshot.result.rows[0].value).toBeCloseTo((500 * 0.8 + 5) / 505, 6);

    await app.close();
  });

  it("accumulates — the view's directory lists one file per capture", async () => {
    const { app, scorecardStore } = build();
    await scorecardStore.create(scorecard("a", 1, 1));
    const id = await createView(app);

    const first = await app.inject({ method: "POST", url: `/views/${id}/snapshots`, headers: H });
    expect(first.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: `/fs/entries?path=views/${id}`, headers: H });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ kind: "file" });

    await app.close();
  });

  it("publishes an attributed revision, so a capture is auditable like any other write", async () => {
    const { app, scorecardStore } = build();
    await scorecardStore.create(scorecard("a", 1, 1));
    const id = await createView(app);
    const { path } = (await app.inject({ method: "POST", url: `/views/${id}/snapshots`, headers: H })).json();

    const history = await app.inject({ method: "GET", url: `/fs/revisions?path=${path}`, headers: H });
    expect(history.statusCode).toBe(200);
    expect(history.json()[0]).toMatchObject({ revision: 1, actor: { kind: "member" } });

    await app.close();
  });

  it("is 404 for an unknown view — and writes nothing", async () => {
    const { app } = build();
    const res = await app.inject({ method: "POST", url: "/views/nope/snapshots", headers: H });
    expect(res.statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: "/fs/entries?path=views", headers: H });
    expect(list.json()).toEqual([]);

    await app.close();
  });

  it("404s the whole route when no snapshot service is composed", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      viewService: new ViewService({ store: new InMemoryViewStore() }),
    });
    const res = await app.inject({ method: "POST", url: "/views/whatever/snapshots", headers: H });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
