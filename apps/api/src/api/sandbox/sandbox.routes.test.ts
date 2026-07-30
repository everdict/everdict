import { RunService, SandboxSessionService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { ComputeHandle, Driver } from "@everdict/contracts";
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
    expect(trajectory.json().meta).toMatchObject({ source: "run", eventCount: 4 }); // start + call + result + close
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

  it("without a configured driver the routes are absent (404 not configured)", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("not configured");
  });
});
