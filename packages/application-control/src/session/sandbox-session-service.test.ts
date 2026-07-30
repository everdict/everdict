import type { ComputeHandle, ComputeSpec, Driver, RunRecord, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { OutboxEvent, RunStore } from "../ports/run-store.js";
import type { TrajectoryMeta, TrajectoryStore } from "../ports/trajectory-store.js";
import { SandboxSessionService, type SandboxSessionServiceDeps } from "./sandbox-session-service.js";

// Local fakes — application-control cannot depend on @everdict/db (layer direction), so the store doubles
// live here, capturing the E0 events threaded into each write.
function fakeRunStore() {
  const rows = new Map<string, RunRecord>();
  const events: Array<{ op: "create" | "update"; kinds: string[] }> = [];
  const store: RunStore = {
    async create(record: RunRecord, evts?: OutboxEvent[]) {
      rows.set(record.id, record);
      events.push({ op: "create", kinds: (evts ?? []).map((e) => e.kind) });
    },
    async update(id: string, patch: Partial<RunRecord>, evts?: OutboxEvent[]) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      events.push({ op: "update", kinds: (evts ?? []).map((e) => e.kind) });
      return next;
    },
    async get(id: string) {
      return rows.get(id);
    },
    async list() {
      return [...rows.values()];
    },
    async deleteByScorecard() {
      return 0;
    },
  };
  return { store, rows, events };
}

function fakeTrajectories() {
  const sealed = new Map<string, { meta: TrajectoryMeta; events: TraceEvent[] }>();
  const store: TrajectoryStore = {
    async seal(input) {
      const meta: TrajectoryMeta = {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: input.events.length,
        sealedAt: "t",
      };
      if (!sealed.has(input.runId)) sealed.set(input.runId, { meta, events: input.events });
      const kept = sealed.get(input.runId);
      if (kept === undefined) throw new Error("unreachable");
      return kept.meta;
    },
    async get(tenant, runId) {
      const hit = sealed.get(runId);
      return hit && hit.meta.tenant === tenant ? hit : undefined;
    },
    async list(tenant) {
      return { items: [...sealed.values()].map((r) => r.meta).filter((m) => m.tenant === tenant) };
    },
  };
  return { store, sealed };
}

function fakeDriver(opts: { failProvision?: boolean } = {}) {
  const provisioned: ComputeSpec[] = [];
  const disposed: string[] = [];
  const reaped: string[] = [];
  const execs: string[] = [];
  let seq = 0;
  const driver: Driver = {
    id: "fake",
    async reap(id) {
      reaped.push(id);
    },
    async provision(spec) {
      if (opts.failProvision) throw new Error("docker daemon unreachable");
      provisioned.push(spec);
      const cid = `c-${++seq}`;
      const handle: ComputeHandle = {
        id: cid,
        async exec(command) {
          execs.push(command);
          return command.includes("boom")
            ? { stdout: "", stderr: "kaboom", exitCode: 1 }
            : { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
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
  return { driver, provisioned, disposed, reaped, execs };
}

function build(over: Partial<SandboxSessionServiceDeps> = {}) {
  const runStore = fakeRunStore();
  const trajectories = fakeTrajectories();
  const driver = fakeDriver();
  let n = 0;
  let nowIso = "2026-07-30T00:00:00.000Z";
  const service = new SandboxSessionService({
    store: runStore.store,
    driver: driver.driver,
    trajectories: trajectories.store,
    newId: () => `sbx-${++n}`,
    now: () => nowIso,
    ...over,
  });
  const setNow = (iso: string): void => {
    nowIso = iso;
  };
  return { service, runStore, trajectories, driver, setNow };
}

const creator = { tenant: "acme", subject: "alice", isAdmin: false };

describe("SandboxSessionService — session runs on the universal ledger (P6)", () => {
  it("create boots the image and records a running sandbox run with its deadline ON THE ROW (run.submitted via E0)", async () => {
    const { service, runStore, driver } = build();
    const record = await service.create({ tenant: "acme", createdBy: "alice", image: "python:3.12-slim" });

    expect(driver.provisioned).toEqual([{ os: "linux", image: "python:3.12-slim", needs: ["shell"] }]);
    expect(record).toMatchObject({
      kind: "sandbox",
      lifetime: "session",
      class: "interactive",
      status: "running",
      harness: { id: "python:3.12-slim", version: "adhoc" },
      placement: { where: "driver", isolation: "container" },
      attach: ["exec"],
      createdBy: "alice",
      session: { image: "python:3.12-slim", ttlSec: 900, expiresAt: "2026-07-30T00:15:00.000Z" },
    });
    expect(runStore.events[0]).toEqual({ op: "create", kinds: ["run.submitted"] });
  });

  it("an environment ref resolves through the injected consume gate; unresolvable → 404; no resolver → 400", async () => {
    const { service } = build({
      resolveEnvironmentImage: async (_t, _s, ref) =>
        ref.id === "swe-env" ? { image: "ghcr.io/acme/swe:1.2.0", version: "1.2.0" } : undefined,
    });
    const record = await service.create({
      tenant: "acme",
      createdBy: "alice",
      environment: { id: "swe-env", version: "1.2.0" },
    });
    expect(record.harness).toEqual({ id: "swe-env", version: "1.2.0" }); // what the user ASKED for
    expect(record.session?.image).toBe("ghcr.io/acme/swe:1.2.0"); // what actually booted

    await expect(
      service.create({ tenant: "acme", createdBy: "alice", environment: { id: "ghost" } }),
    ).rejects.toMatchObject({ status: 404 });

    const bare = build(); // no resolver wired — environment-backed sandboxes are not configured here
    await expect(
      bare.service.create({ tenant: "acme", createdBy: "alice", environment: { id: "swe-env" } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("capacity is enforced per tenant (429) — another workspace is unaffected", async () => {
    const { service } = build({ maxPerTenant: 1 });
    await service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    await expect(service.create({ tenant: "acme", createdBy: "alice", image: "img" })).rejects.toMatchObject({
      status: 429,
    });
    await expect(service.create({ tenant: "rival", createdBy: "bob", image: "img" })).resolves.toMatchObject({
      kind: "sandbox",
    });
  });

  it("a failed provision is remapped to UPSTREAM_ERROR and leaves NO record", async () => {
    const runStore = fakeRunStore();
    const failing = fakeDriver({ failProvision: true });
    const service = new SandboxSessionService({ store: runStore.store, driver: failing.driver });
    await expect(service.create({ tenant: "acme", createdBy: "alice", image: "img" })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(await runStore.store.list("acme")).toEqual([]);
  });

  it("exec is creator-or-admin BEFORE anything runs, tenant-scoped, and lands on the trajectory", async () => {
    const { service, driver } = build();
    const record = await service.create({ tenant: "acme", createdBy: "alice", image: "img" });

    const result = await service.exec(creator, record.id, { command: "echo hi" });
    expect(result).toEqual({ stdout: "ran:echo hi", stderr: "", exitCode: 0 });

    await expect(
      service.exec({ tenant: "acme", subject: "mallory", isAdmin: false }, record.id, { command: "rm -rf /" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(driver.execs).toEqual(["echo hi"]); // the refused command NEVER ran

    await expect(
      service.exec({ tenant: "rival", subject: "alice", isAdmin: false }, record.id, { command: "ls" }),
    ).rejects.toMatchObject({ status: 404 }); // foreign workspace reads absence, not refusal

    await expect(
      service.exec({ tenant: "acme", subject: "root", isAdmin: true }, record.id, { command: "ls" }),
    ).resolves.toMatchObject({ exitCode: 0 }); // admin may exec
  });

  it("close settles succeeded{closedReason: closed}, seals the trajectory, disposes the container (the finally)", async () => {
    const { service, runStore, trajectories, driver } = build();
    const record = await service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    await service.exec(creator, record.id, { command: "echo hi" });
    await service.exec(creator, record.id, { command: "boom" });

    const closed = await service.close(creator, record.id);
    expect(closed).toMatchObject({ status: "succeeded", session: { closedReason: "closed" } });
    expect(driver.disposed).toEqual(["c-1"]);
    expect(runStore.events.at(-1)).toEqual({ op: "update", kinds: ["run.completed"] });

    const sealed = await trajectories.store.get("acme", record.id);
    expect(sealed?.meta).toMatchObject({ source: "run", eventCount: 6 }); // start + 2×(call+result) + close
    expect(sealed?.events.map((e) => e.kind)).toEqual([
      "env_action",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "env_action",
    ]);
    expect(sealed?.events.some((e) => e.kind === "tool_result" && !e.ok)).toBe(true); // the failed exec is evidence too

    // Idempotent over an already-settled session; the dead handle 404s on exec.
    await expect(service.close(creator, record.id)).resolves.toMatchObject({ status: "succeeded" });
    await expect(service.exec(creator, record.id, { command: "ls" })).rejects.toMatchObject({ status: 404 });
  });

  it("the TTL sweep expires an overdue session: disposed, sealed, settled as succeeded{expired}", async () => {
    const { service, runStore, driver, setNow } = build();
    const record = await service.create({ tenant: "acme", createdBy: "alice", image: "img", ttlSec: 60 });
    setNow("2026-07-30T00:02:00.000Z"); // past the 60s deadline
    service.sweep();
    await new Promise((r) => setTimeout(r, 0)); // the sweep tears down asynchronously
    expect(driver.disposed).toEqual(["c-1"]);
    expect((await runStore.store.get(record.id))?.session?.closedReason).toBe("expired");
    expect((await runStore.store.get(record.id))?.status).toBe("succeeded");
  });

  it("a running record whose live handle was lost (control-plane restart) closes as orphaned", async () => {
    const { service, runStore } = build();
    const record = await service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    // Simulate a restart: a NEW service instance shares the store but has no live handles.
    const reborn = new SandboxSessionService({ store: runStore.store, driver: fakeDriver().driver });
    const settled = await reborn.close(creator, record.id);
    expect(settled).toMatchObject({ status: "succeeded", session: { closedReason: "orphaned" } });
  });

  it("create starts reaper:<runId> with the row's deadline and persists the compute id; close signals it", async () => {
    const started: Array<{ runId: string; tenant: string; expiresAt: string }> = [];
    const signalled: string[] = [];
    const { service } = build({
      reaper: {
        start: async (input) => {
          started.push(input);
        },
        signalClosed: async (runId) => {
          signalled.push(runId);
        },
      },
    });
    const record = await service.create({ tenant: "acme", createdBy: "alice", image: "img", ttlSec: 60 });
    expect(record.session?.computeId).toBe("c-1"); // the row alone suffices for a later process to reap
    expect(started).toEqual([{ runId: record.id, tenant: "acme", expiresAt: "2026-07-30T00:01:00.000Z" }]);
    await service.close(creator, record.id);
    expect(signalled).toEqual([record.id]);
  });

  it("reap(): a live handle tears down as expired; a crash-orphaned row reaps the stray container by computeId; a settled row is a no-op", async () => {
    // Live handle — the reaper fired while this process still holds the session.
    const live = build();
    const first = await live.service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    await expect(live.service.reap("acme", first.id)).resolves.toEqual({ reaped: true });
    expect(live.driver.disposed).toEqual(["c-1"]);
    expect((await live.runStore.store.get(first.id))?.session?.closedReason).toBe("expired");

    // Crash case — a NEW process (fresh service, fresh driver double) finds only the row.
    const before = build();
    const second = await before.service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    const rebornDriver = fakeDriver();
    const reborn = new SandboxSessionService({ store: before.runStore.store, driver: rebornDriver.driver });
    await expect(reborn.reap("acme", second.id)).resolves.toEqual({ reaped: true });
    expect(rebornDriver.reaped).toEqual(["c-1"]); // the stray container removed by the RECORDED compute id
    expect((await before.runStore.store.get(second.id))?.session?.closedReason).toBe("orphaned");

    // Idempotent — a settled row (close won the race) skips; a foreign tenant reads absence.
    await expect(reborn.reap("acme", second.id)).resolves.toEqual({ reaped: false });
    await expect(reborn.reap("rival", second.id)).resolves.toEqual({ reaped: false });
  });
});
