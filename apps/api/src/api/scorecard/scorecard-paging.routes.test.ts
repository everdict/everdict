import { RunService, ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// ── THE LIST DOOR IS BOUNDED, AND THE COUNTS DOOR ANSWERS WHAT A PAGE CANNOT KNOW ────────────────────
//
// `GET /scorecards` answered the workspace's whole history to every caller, because a scorecard used to be a
// thing you had a few dozen of. It is filed by every CI run, so the read is now optional-bounded: absent
// `limit` nothing changes for any existing caller (the SDK, the MCP tool, four web screens), and with it the
// caller takes a page and continues from the last row it drew.
//
// What is locked here is the door's own behaviour: that the default is still unbounded, that the cursor
// needs BOTH halves to be a position in a total order, that a bad page is a 400 rather than a silent clamp,
// and that the counts door narrows exactly as the list door does — a header that counted a different set
// from the rows under it is the defect this endpoint exists to prevent.

const dispatcher: Dispatcher = {
  async dispatch(job) {
    return {
      caseId: job.evalCase.id,
      harness: `${job.harness.id}@${job.harness.version}`,
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };
  },
};

const at = (id: string, createdAt: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "smoke", version: "1.0.0" },
    harness: { id: "agent", version: "1.0.0" },
    status: "succeeded",
    createdAt,
    updatedAt: createdAt,
    steps: [],
    ...over,
  }) as ScorecardRecord;

// Two share an instant, so the id tie-break is exercised; two calendar days, so the day grouping has buckets.
const RECORDS = [
  at("s5", "2026-08-02T11:00:00.000Z", { status: "failed" }),
  at("s4", "2026-08-02T10:00:00.000Z"),
  at("s3", "2026-08-01T09:00:00.000Z", { runtime: "nomad-eu" }),
  at("s2", "2026-08-01T09:00:00.000Z"),
  at("s1", "2026-07-31T08:00:00.000Z", { harness: { id: "codex", version: "1" } }),
];

async function build() {
  const store = new InMemoryScorecardStore();
  for (const record of RECORDS) await store.create(record);
  const templates = new InMemoryHarnessTemplateRegistry();
  const scorecardService = new ScorecardService({
    dispatcher,
    store,
    datasets: new InMemoryDatasetRegistry(),
    harnesses: new InMemoryHarnessInstanceRegistry(templates),
  });
  return buildServer({
    service: new RunService({ dispatcher, store: new InMemoryRunStore() }),
    scorecardService,
    requireAuth: true,
    authenticator: {
      async authenticate() {
        return { subject: "u", workspace: "acme", roles: ["member"], via: "oidc" as const };
      },
    },
  });
}

const bearer = { authorization: "Bearer t" };
const idsOf = (res: { json: () => unknown }) => (res.json() as { id: string }[]).map((row) => row.id);

describe("GET /scorecards — bounded on request, unbounded by default", () => {
  it("still answers the whole collection when no page is asked for", async () => {
    const app = await build();

    const res = await app.inject({ method: "GET", url: "/scorecards", headers: bearer });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual(["s5", "s4", "s3", "s2", "s1"]);
    await app.close();
  });

  it("takes a page, newest first", async () => {
    const app = await build();

    const res = await app.inject({ method: "GET", url: "/scorecards?limit=2", headers: bearer });

    expect(idsOf(res)).toEqual(["s5", "s4"]);
    await app.close();
  });

  it("continues from the last row drawn, across an instant two batches share", async () => {
    const app = await build();

    // s3 and s2 share 09:00. A cursor at s3 must yield s2 — the id is what makes the position total.
    const res = await app.inject({
      method: "GET",
      url: "/scorecards?limit=2&beforeCreatedAt=2026-08-01T09:00:00.000Z&beforeId=s3",
      headers: bearer,
    });

    expect(idsOf(res)).toEqual(["s2", "s1"]);
    await app.close();
  });

  it("ignores a half cursor rather than guessing at a position", async () => {
    const app = await build();

    // A timestamp with no id is not a position in this ordering. Answering the whole set is the honest
    // reading of "you did not give me a cursor"; inventing one would silently skip or repeat a row.
    const res = await app.inject({
      method: "GET",
      url: "/scorecards?beforeCreatedAt=2026-08-01T09:00:00.000Z",
      headers: bearer,
    });

    expect(idsOf(res)).toEqual(["s5", "s4", "s3", "s2", "s1"]);
    await app.close();
  });

  it("refuses a page size outside the bound instead of clamping it quietly", async () => {
    const app = await build();

    expect((await app.inject({ method: "GET", url: "/scorecards?limit=5000", headers: bearer })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/scorecards?limit=0", headers: bearer })).statusCode).toBe(400);
    await app.close();
  });

  it("narrows on the list's own axes, server-side", async () => {
    const app = await build();

    const failed = await app.inject({ method: "GET", url: "/scorecards?status=failed", headers: bearer });
    expect(idsOf(failed)).toEqual(["s5"]);

    const runtime = await app.inject({ method: "GET", url: "/scorecards?runtime=nomad-eu", headers: bearer });
    expect(idsOf(runtime)).toEqual(["s3"]);

    const day = await app.inject({ method: "GET", url: "/scorecards?day=2026-08-01", headers: bearer });
    expect(idsOf(day)).toEqual(["s3", "s2"]);

    const search = await app.inject({ method: "GET", url: "/scorecards?q=CODEX", headers: bearer });
    expect(idsOf(search)).toEqual(["s1"]);
    await app.close();
  });
});

describe("GET /scorecards/counts — the number a page cannot know", () => {
  it("counts the whole set per bucket, with its total", async () => {
    const app = await build();

    const res = await app.inject({ method: "GET", url: "/scorecards/counts?groupBy=day", headers: bearer });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { groupBy: string; groups: { key: string | null; count: number }[]; total: number };
    expect(body.groupBy).toBe("day");
    expect(body.total).toBe(5);
    expect([...body.groups].sort((a, b) => `${a.key}`.localeCompare(`${b.key}`))).toEqual([
      { key: "2026-07-31", count: 1 },
      { key: "2026-08-01", count: 2 },
      { key: "2026-08-02", count: 2 },
    ]);
    await app.close();
  });

  it("narrows exactly as the list door does — the header describes the rows under it", async () => {
    const app = await build();

    const rows = await app.inject({ method: "GET", url: "/scorecards?day=2026-08-01&limit=1", headers: bearer });
    const counts = await app.inject({
      method: "GET",
      url: "/scorecards/counts?groupBy=day&day=2026-08-01",
      headers: bearer,
    });

    // One row drawn, two in the set: the page's own size must not become the count.
    expect(idsOf(rows)).toHaveLength(1);
    expect((counts.json() as { total: number }).total).toBe(2);
    await app.close();
  });

  it("refuses a grouping it does not have", async () => {
    const app = await build();

    const res = await app.inject({ method: "GET", url: "/scorecards/counts?groupBy=weather", headers: bearer });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("is a static path, not a scorecard called 'counts'", async () => {
    const app = await build();

    // Declared before /scorecards/:id — otherwise this reads as a detail lookup and 404s.
    const res = await app.inject({ method: "GET", url: "/scorecards/counts?groupBy=status", headers: bearer });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
