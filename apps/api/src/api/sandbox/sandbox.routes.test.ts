import { RunService, SandboxSessionService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { ComputeHandle, Driver, EvaluableHarness } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryTrajectoryStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme", "content-type": "application/json" };

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in sandbox tests");
  },
};

function fakeDriver() {
  const disposed: string[] = [];
  let seq = 0;
  const driver: Driver = {
    id: "fake",
    async provision() {
      const cid = `c-${++seq}`;
      const handle: ComputeHandle = {
        async exec(command) {
          return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
        },
        async writeFile() {},
        async readFile() {
          return "";
        },
        async dispose() {
          disposed.push(cid);
        },
      };
      return handle;
    },
  };
  return { driver, disposed };
}

function build() {
  const store = new InMemoryRunStore();
  const trajectories = new InMemoryTrajectoryStore();
  const { driver, disposed } = fakeDriver();
  let n = 0;
  const sandboxSessions = new SandboxSessionService({
    store,
    driver,
    trajectories,
    maxPerTenant: 1,
    newId: () => `sbx-${++n}`,
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store, trajectories }),
    sandboxSessions,
    internalToken: "itok",
  });
  return { app, disposed };
}

describe("sandbox session routes — run an environment image and shell in (P6)", () => {
  it("create → exec → close roundtrip: a Run on the ledger whose sealed trajectory the run routes serve", async () => {
    const { app, disposed } = build();

    const created = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { image: "python:3.12-slim", ttlSec: 300 },
    });
    expect(created.statusCode).toBe(200);
    const record = created.json();
    expect(record).toMatchObject({
      kind: "sandbox",
      lifetime: "session",
      status: "running",
      session: { image: "python:3.12-slim", ttlSec: 300 },
    });

    const exec = await app.inject({
      method: "POST",
      url: `/sandboxes/${record.id}/exec`,
      headers: H,
      payload: { command: "echo hi" },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json()).toEqual({ stdout: "ran:echo hi", stderr: "", exitCode: 0 });

    const closed = await app.inject({ method: "POST", url: `/sandboxes/${record.id}/close`, headers: H });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "succeeded", session: { closedReason: "closed" } });
    expect(disposed).toEqual(["c-1"]); // the container did not outlive the session

    // The session's evidence serves through the EXISTING run surface — no new read endpoint.
    const trajectory = await app.inject({ method: "GET", url: `/runs/${record.id}/trajectory`, headers: H });
    expect(trajectory.statusCode).toBe(200);
    expect(trajectory.json().meta).toMatchObject({ source: "run", eventCount: 5 }); // start + call + result + close
  });

  it("validates the body: image XOR environment, and rejects an empty command", async () => {
    const { app } = build();
    expect((await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: {} })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sandboxes",
          headers: H,
          payload: { image: "img", environment: { id: "e" } },
        })
      ).statusCode,
    ).toBe(400);
    const created = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    const exec = await app.inject({
      method: "POST",
      url: `/sandboxes/${created.json().id}/exec`,
      headers: H,
      payload: { command: "" },
    });
    expect(exec.statusCode).toBe(400);
  });

  it("scopes by workspace (foreign exec/close read 404) and enforces the per-tenant cap (429)", async () => {
    const { app } = build();
    const created = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    const rival = { ...H, "x-everdict-tenant": "rival" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/sandboxes/${created.json().id}/exec`,
          headers: rival,
          payload: { command: "ls" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/sandboxes/${created.json().id}/close`, headers: rival })).statusCode,
    ).toBe(404);
    // The cap: acme already holds its one session.
    expect(
      (await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } })).statusCode,
    ).toBe(429);
  });

  it("the reaper's internal teardown: token-guarded; expires a live session and no-ops a settled one (T-b)", async () => {
    const { app, disposed } = build();
    const created = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    const id = created.json().id;

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/internal/sandboxes/${id}/reap`,
      headers: { "content-type": "application/json", "x-internal-token": "wrong" },
      payload: { tenant: "acme" },
    });
    expect(unauthenticated.statusCode).toBe(403);

    const reap = await app.inject({
      method: "POST",
      url: `/internal/sandboxes/${id}/reap`,
      headers: { "content-type": "application/json", "x-internal-token": "itok" },
      payload: { tenant: "acme" },
    });
    expect(reap.statusCode).toBe(200);
    expect(reap.json()).toEqual({ reaped: true });
    expect(disposed).toEqual(["c-1"]);
    const record = await app.inject({ method: "GET", url: `/runs/${id}`, headers: H });
    expect(record.json()).toMatchObject({ status: "succeeded", session: { closedReason: "expired" } });

    // The timer firing after a close (or a second delivery) is a visible no-op.
    const again = await app.inject({
      method: "POST",
      url: `/internal/sandboxes/${id}/reap`,
      headers: { "content-type": "application/json", "x-internal-token": "itok" },
      payload: { tenant: "acme" },
    });
    expect(again.json()).toEqual({ reaped: false });
  });

  it("without a configured driver the routes are absent (404 not configured)", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("not configured");
  });
});

describe("sandbox playground routes — a harness in the session, test cases through it", () => {
  function buildPlayground() {
    const store = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    const { driver, disposed } = fakeDriver();
    const harness: EvaluableHarness = {
      id: "cc",
      version: "1.0.0",
      async install(compute) {
        await compute.exec("npm i -g cc");
      },
      async *run(_compute, task) {
        yield { t: 1, kind: "message" as const, role: "assistant" as const, text: `did: ${task}` };
      },
    };
    let n = 0;
    const sandboxSessions = new SandboxSessionService({
      store,
      driver,
      trajectories,
      newId: () => `sbx-${++n}`,
      resolveSessionHarness: async (_tenant, _subject, ref) =>
        ref.id === "cc" ? { id: "cc", version: "1.0.0", harness, apiKeyEnv: {}, image: "cc-img:1" } : undefined,
    });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store, trajectories }),
      sandboxSessions,
      internalToken: "itok",
    });
    return { app, disposed };
  }

  async function until(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!(await cond())) {
      if (Date.now() - start > ms) throw new Error("condition not reached in time");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("boot(harness) → submit task (202 grouped child) → trace poll pages to done → run surfaces serve the evidence", async () => {
    const { app } = buildPlayground();
    const created = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { harness: { id: "cc" } },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    expect(session).toMatchObject({
      kind: "sandbox",
      harness: { id: "cc", version: "1.0.0" },
      attach: ["exec", "tasks"],
      session: { image: "cc-img:1" },
    });

    const submitted = await app.inject({
      method: "POST",
      url: `/sandboxes/${session.id}/tasks`,
      headers: H,
      payload: { task: "add a README" },
    });
    expect(submitted.statusCode).toBe(202);
    const child = submitted.json();
    expect(child).toMatchObject({
      kind: "eval",
      class: "interactive",
      status: "running",
      group: { id: session.id, role: "case" },
      harness: { id: "cc", version: "1.0.0" },
    });

    await until(async () => {
      const res = await app.inject({
        method: "GET",
        url: `/sandboxes/${session.id}/tasks/${child.id}/trace`,
        headers: H,
      });
      return res.json().done === true;
    });
    const page = await app.inject({
      method: "GET",
      url: `/sandboxes/${session.id}/tasks/${child.id}/trace`,
      headers: H,
    });
    expect(page.json()).toMatchObject({ status: "succeeded", done: true });
    expect(page.json().events.some((e: { kind: string }) => e.kind === "message")).toBe(true);
    const next = await app.inject({
      method: "GET",
      url: `/sandboxes/${session.id}/tasks/${child.id}/trace?since=${page.json().nextCursor}`,
      headers: H,
    });
    expect(next.json().events).toEqual([]);

    // The session view reflects the settled task; the child's sealed trajectory serves on the run surface.
    const view = await app.inject({ method: "GET", url: `/sandboxes/${session.id}`, headers: H });
    expect(view.json().live).toMatchObject({ busy: false, harness: { id: "cc", version: "1.0.0" } });
    expect(view.json().live.tasks).toMatchObject([{ runId: child.id, status: "succeeded" }]);
    const trajectory = await app.inject({ method: "GET", url: `/runs/${child.id}/trajectory`, headers: H });
    expect(trajectory.statusCode).toBe(200);
    expect(trajectory.json().meta.source).toBe("run");
  });

  it("GET /sandboxes lists only the caller's live sessions; foreign reads are 404", async () => {
    const { app } = buildPlayground();
    const created = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { harness: { id: "cc" } },
    });
    const mine = await app.inject({ method: "GET", url: "/sandboxes", headers: H });
    expect(mine.json().sessions.map((s: { record: { id: string } }) => s.record.id)).toEqual([created.json().id]);
    const rival = { ...H, "x-everdict-tenant": "rival" };
    expect((await app.inject({ method: "GET", url: "/sandboxes", headers: rival })).json().sessions).toEqual([]);
    expect(
      (await app.inject({ method: "GET", url: `/sandboxes/${created.json().id}`, headers: rival })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/sandboxes/${created.json().id}/tasks`,
          headers: rival,
          payload: { task: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("body validation: 3-way XOR on create, empty task 400, unknown harness 404, non-harness session task 400", async () => {
    const { app } = buildPlayground();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sandboxes",
          headers: H,
          payload: { image: "img", harness: { id: "cc" } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { harness: { id: "ghost" } } }))
        .statusCode,
    ).toBe(404);
    const session = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { harness: { id: "cc" } } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/sandboxes/${session.json().id}/tasks`,
          headers: H,
          payload: { task: "" },
        })
      ).statusCode,
    ).toBe(400);
    const plain = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/sandboxes/${plain.json().id}/tasks`,
          headers: H,
          payload: { task: "x" },
        })
      ).statusCode,
    ).toBe(400);
  });
});
