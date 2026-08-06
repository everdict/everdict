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
  let nowIso = "2026-07-30T00:00:00.000Z";
  const sandboxSessions = new SandboxSessionService({
    store,
    driver,
    trajectories,
    maxPerTenant: 1,
    newId: () => `sbx-${++n}`,
    now: () => nowIso,
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store, trajectories }),
    sandboxSessions,
    internalToken: "itok",
  });
  const setNow = (iso: string): void => {
    nowIso = iso;
  };
  return { app, disposed, setNow };
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

  it("the reaper's internal teardown: token-guarded; a PRE-deadline fire is a no-op; expires an overdue session (T-b)", async () => {
    const { app, disposed, setNow } = build();
    const created = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    const id = created.json().id;

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/internal/sandboxes/${id}/reap`,
      headers: { "content-type": "application/json", "x-internal-token": "wrong" },
      payload: { tenant: "acme" },
    });
    expect(unauthenticated.statusCode).toBe(403);

    // A stale timer (armed before a touch — extend is best-effort) fires before the authoritative deadline:
    // the session stays alive.
    const early = await app.inject({
      method: "POST",
      url: `/internal/sandboxes/${id}/reap`,
      headers: { "content-type": "application/json", "x-internal-token": "itok" },
      payload: { tenant: "acme" },
    });
    expect(early.json()).toEqual({ reaped: false });

    setNow("2026-07-30T00:16:00.000Z"); // past the 900s deadline
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
        ref.id === "cc"
          ? { id: "cc", version: "1.0.0", kind: "process" as const, harness, apiKeyEnv: {}, image: "cc-img:1" }
          : undefined,
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
    const session = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { harness: { id: "cc" } },
    });
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

  it("conversation fields traverse the transport: conversation boot on a non-resuming harness 400s, fresh on an independent-cases session 400s", async () => {
    const { app } = buildPlayground(); // its fake harness has no `conversational` marker
    const refused = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { harness: { id: "cc", conversation: true } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain("conversation");

    const session = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { harness: { id: "cc" } },
    });
    const fresh = await app.inject({
      method: "POST",
      url: `/sandboxes/${session.json().id}/tasks`,
      headers: H,
      payload: { task: "hello", fresh: true },
    });
    expect(fresh.statusCode).toBe(400);
    expect(fresh.json().message).toContain("fresh");
  });
});

describe("sandbox world routes — agent worlds (W1): snapshot, touch, close-without-saving", () => {
  function buildWorldApp() {
    const store = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    const pushed: Array<{ id: string; ref: string }> = [];
    let seq = 0;
    const driver: Driver = {
      id: "fake",
      async provision() {
        const cid = `c-${++seq}`;
        const handle: ComputeHandle = {
          id: cid,
          async exec(command) {
            return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async dispose() {},
        };
        return handle;
      },
      async snapshot(id, ref) {
        pushed.push({ id, ref });
      },
    };
    const tags = new Map<string, string[]>();
    let version = 0;
    let n = 0;
    let nowIso = "2026-07-30T00:00:00.000Z";
    const sandboxSessions = new SandboxSessionService({
      store,
      driver,
      trajectories,
      newId: () => `sbx-${++n}`,
      now: () => nowIso,
      images: {
        endpoint: "reg.local:5000",
        namespaceFor: (tenant) => `${tenant}-ns`,
        listTags: async (_t, repo) => tags.get(repo) ?? [],
        inspect: async (_t, repo, reference) => ({ reference, digest: `sha256:${repo}.${reference}` }),
        mintPushGrant: async (_t, repo) => ({
          endpoint: "reg.local:5000",
          repositories: [repo],
          actions: ["push" as const],
          token: "grant-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      },
      publishWorldVersion: async () => ({ version: `1.0.${version++}` }),
    });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store, trajectories }),
      sandboxSessions,
      internalToken: "itok",
    });
    const setNow = (iso: string): void => {
      nowIso = iso;
    };
    return { app, pushed, setNow };
  }

  it("found a world from a genesis image → snapshot publishes {world, version, image} → touch extends the deadline", async () => {
    const { app, pushed } = buildWorldApp();
    const created = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { world: { id: "proj" }, image: "debian:stable" },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    expect(session).toMatchObject({
      kind: "sandbox",
      harness: { id: "proj", version: "genesis" },
      session: { image: "debian:stable", world: "proj", hibernate: true },
    });

    const snapshot = await app.inject({
      method: "POST",
      url: `/sandboxes/${session.id}/snapshot`,
      headers: H,
      payload: { name: "My project" },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toEqual({
      world: "proj",
      version: "1.0.0",
      image: "reg.local:5000/acme-ns/proj:v1@sha256:proj.v1",
    });
    expect(pushed).toEqual([{ id: "c-1", ref: "reg.local:5000/acme-ns/proj:v1" }]);

    const touched = await app.inject({
      method: "POST",
      url: `/sandboxes/${session.id}/touch`,
      headers: H,
      payload: { ttlSec: 1800 },
    });
    expect(touched.statusCode).toBe(200);
    expect(touched.json()).toEqual({ expiresAt: "2026-07-30T00:30:00.000Z" });
  });

  it("close with snapshot:false skips hibernation; a snapshot on a non-world session is 400; foreign reads 404", async () => {
    const { app, pushed } = buildWorldApp();
    const world = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { world: { id: "proj" }, image: "img" },
    });
    const closed = await app.inject({
      method: "POST",
      url: `/sandboxes/${world.json().id}/close`,
      headers: H,
      payload: { snapshot: false },
    });
    expect(closed.statusCode).toBe(200);
    expect(pushed).toEqual([]); // close-without-saving captured nothing

    const plain = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "img" } });
    expect(
      (await app.inject({ method: "POST", url: `/sandboxes/${plain.json().id}/snapshot`, headers: H, payload: {} }))
        .statusCode,
    ).toBe(400);

    const rival = { ...H, "x-everdict-tenant": "rival" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/sandboxes/${plain.json().id}/snapshot`,
          headers: rival,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/sandboxes/${plain.json().id}/touch`, headers: rival, payload: {} }))
        .statusCode,
    ).toBe(404);
  });

  it("create validation: world excludes environment/harness; a bad world id (not a repository name) is 400", async () => {
    const { app } = buildWorldApp();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sandboxes",
          headers: H,
          payload: { world: { id: "proj" }, harness: { id: "cc" } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sandboxes",
          headers: H,
          payload: { world: { id: "Bad Name" }, image: "img" },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("sandbox git routes — agent worlds (W2): a repository in, commits out", () => {
  function buildGitApp() {
    const store = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    const writes: string[] = [];
    let seq = 0;
    const driver: Driver = {
      id: "fake",
      async provision() {
        const cid = `c-${++seq}`;
        const handle: ComputeHandle = {
          id: cid,
          async exec(command) {
            return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async dispose() {},
        };
        return handle;
      },
    };
    let n = 0;
    const sandboxSessions = new SandboxSessionService({
      store,
      driver,
      trajectories,
      newId: () => `sbx-${++n}`,
      git: {
        readToken: async () => "read-token",
        writeToken: async (_tenant, gitUrl) => {
          writes.push(gitUrl);
          return "write-token";
        },
        openPullRequest: async () => ({ url: "https://github.com/acme/app/pull/3", base: "main" }),
      },
    });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store, trajectories }),
      sandboxSessions,
      internalToken: "itok",
    });
    return { app, writes };
  }

  it("create with repo records what was cloned; push returns the branch and its pull request", async () => {
    const { app, writes } = buildGitApp();
    const created = await app.inject({
      method: "POST",
      url: "/sandboxes",
      headers: H,
      payload: { image: "debian", repo: { git: "https://github.com/acme/app.git", ref: "main" } },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().session.repo).toEqual({ git: "https://github.com/acme/app.git", ref: "main", dir: "work" });

    const pushed = await app.inject({
      method: "POST",
      url: `/sandboxes/${created.json().id}/git/push`,
      headers: H,
      payload: { pullRequest: { title: "Ship it" } },
    });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().pullRequest).toEqual({ url: "https://github.com/acme/app/pull/3", base: "main" });
    expect(writes).toHaveLength(1); // one write credential, minted for this one push
  });

  it("validates the create body (repo needs a target) and scopes push by workspace (404)", async () => {
    const { app } = buildGitApp();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sandboxes",
          headers: H,
          payload: { repo: { git: "https://github.com/acme/app.git" } },
        })
      ).statusCode,
    ).toBe(400);

    const created = await app.inject({ method: "POST", url: "/sandboxes", headers: H, payload: { image: "debian" } });
    const rival = { ...H, "x-everdict-tenant": "rival" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/sandboxes/${created.json().id}/git/push`,
          headers: rival,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
