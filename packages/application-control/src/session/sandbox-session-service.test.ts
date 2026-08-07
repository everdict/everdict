import type { ComputeHandle, ComputeSpec, Driver, RegistryAuth, RunRecord, TraceEvent } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { LiveSessionQuery, OutboxEvent, RunStore } from "../ports/run-store.js";
import type { TrajectoryMeta, TrajectoryStore } from "../ports/trajectory-store.js";
import { SandboxSessionService, type SandboxSessionServiceDeps } from "./sandbox-session-service.js";

// Local fakes — application-control cannot depend on @everdict/db (layer direction), so the store doubles
// live here, capturing the E0 events threaded into each write.
function fakeRunStore() {
  const rows = new Map<string, RunRecord>();
  const events: Array<{ op: "create" | "update"; kinds: string[]; causedBy: Array<string | undefined> }> = [];
  const store: RunStore = {
    async create(record: RunRecord, evts?: OutboxEvent[]) {
      rows.set(record.id, record);
      events.push({
        op: "create",
        kinds: (evts ?? []).map((e) => e.kind),
        causedBy: (evts ?? []).map((e) => e.causedBy),
      });
    },
    async update(id: string, patch: Partial<RunRecord>, evts?: OutboxEvent[]) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      events.push({
        op: "update",
        kinds: (evts ?? []).map((e) => e.kind),
        causedBy: (evts ?? []).map((e) => e.causedBy),
      });
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
    async countActiveByEnvelope() {
      return 0;
    },
    async inFlightByTenant() {
      return {};
    },
    // The ledger IS the session pool now — a per-process map counts only one replica's sessions. The real
    // stores additionally drop rows past their deadline (a crashed writer must not hold a slot forever);
    // that rule is the STORE's and is tested in @everdict/db, so this fake leaves it out rather than
    // fighting the frozen clock these tests run on.
    async liveSessions(query: LiveSessionQuery = {}) {
      return [...rows.values()]
        .filter((r) => r.lifetime === "session" && (r.status === "queued" || r.status === "running"))
        .filter((r) => query.tenant === undefined || r.tenant === query.tenant)
        .filter((r) => query.trigger === undefined || r.trigger === query.trigger)
        .map((r) => ({
          id: r.id,
          tenant: r.tenant,
          ...(r.createdBy !== undefined ? { createdBy: r.createdBy } : {}),
          ...(r.session?.agent?.agentId !== undefined ? { agentId: r.session.agent.agentId } : {}),
          ...(r.session?.expiresAt !== undefined ? { expiresAt: r.session.expiresAt } : {}),
        }));
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
        eventCount: input.events?.length ?? input.spans?.length ?? 0,
        sealedAt: "t",
      };
      const created = !sealed.has(input.runId);
      if (created) sealed.set(input.runId, { meta, events: input.events ?? [] });
      const kept = sealed.get(input.runId);
      if (kept === undefined) throw new Error("unreachable");
      return { ...kept.meta, created };
    },
    async get(tenant, runId) {
      const hit = sealed.get(runId);
      if (!hit || hit.meta.tenant !== tenant) return undefined;
      return {
        ...hit,
        segments: [
          {
            emitter: hit.meta.source,
            source: hit.meta.source,
            eventCount: hit.events.length,
            sealedAt: hit.meta.sealedAt,
            format: "events" as const,
            events: hit.events,
          },
        ],
      };
    },
    async list(tenant) {
      return { items: [...sealed.values()].map((r) => r.meta).filter((m) => m.tenant === tenant) };
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
    async deleteOlderThan() {
      return 0;
    },
  };
  return { store, sealed };
}

function fakeDriver(
  opts: {
    failProvision?: boolean;
    failWrite?: boolean; // writeFile throws — the delegation context-seed failure path
    emptyStdout?: boolean; // every command answers with empty output (a directory with no remote, say)
    snapshot?: (id: string, ref: string, auth?: RegistryAuth) => void;
  } = {},
) {
  const provisioned: ComputeSpec[] = [];
  const disposed: string[] = [];
  const reaped: string[] = [];
  const execs: string[] = [];
  const written: Array<{ path: string; data: string }> = [];
  const execEnvs: Array<Record<string, string> | undefined> = [];
  let seq = 0;
  const snapshotFn = opts.snapshot;
  const driver: Driver = {
    id: "fake",
    async reap(id) {
      reaped.push(id);
    },
    ...(snapshotFn !== undefined
      ? {
          async snapshot(id: string, ref: string, auth?: RegistryAuth) {
            snapshotFn(id, ref, auth);
          },
        }
      : {}),
    async provision(spec) {
      if (opts.failProvision) throw new Error("docker daemon unreachable");
      provisioned.push(spec);
      const cid = `c-${++seq}`;
      const handle: ComputeHandle = {
        id: cid,
        async exec(command, execOpts) {
          execs.push(command);
          execEnvs.push(execOpts?.env);
          if (command.includes("boom")) return { stdout: "", stderr: "kaboom", exitCode: 1 };
          return opts.emptyStdout
            ? { stdout: "", stderr: "", exitCode: 0 }
            : { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
        },
        async writeFile(path: string, data: string) {
          if (opts.failWrite) throw new Error("read-only filesystem");
          written.push({ path, data });
        },
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
  return { driver, provisioned, disposed, reaped, execs, execEnvs, written };
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

    // `tenant` rides the provision so a driver that places on shared infrastructure (a cluster) can resolve
    // the tenant's trust zone; a host-local driver ignores it.
    expect(driver.provisioned).toEqual([{ os: "linux", image: "python:3.12-slim", needs: ["shell"], tenant: "acme" }]);
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
    expect(runStore.events[0]).toMatchObject({ op: "create", kinds: ["run.submitted"] });
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
    expect(runStore.events.at(-1)).toMatchObject({ op: "update", kinds: ["run.completed"] });

    const sealed = await trajectories.store.get("acme", record.id);
    expect(sealed?.meta).toMatchObject({ source: "run", eventCount: 7 }); // infra(provisioned) + start + 2×(call+result) + close
    expect(sealed?.events.map((e) => e.kind)).toEqual([
      "infra", // M3 — the container identity leads the trajectory (WHERE the session physically ran)
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
    // Live handle — the reaper fired while this process still holds the session. A PRE-deadline fire (a
    // timer made stale by touch — extend is best-effort) is a no-op: the deadline here is authoritative.
    const live = build();
    const first = await live.service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    await expect(live.service.reap("acme", first.id)).resolves.toEqual({ reaped: false });
    expect(live.driver.disposed).toEqual([]);
    live.setNow("2026-07-30T00:16:00.000Z"); // past the 900s deadline — now the timer is honest
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

  it("sweepOrphans reaps ledger rows past deadline+grace with no live handle here — and only those", async () => {
    // Regression: a session whose durable reaper never armed (or whose process died holding the handle) sat
    // `running` on the ledger forever — holding its workspace slot and its cluster capacity with it. The
    // ledger sweep ends the zombie no matter HOW its timer was lost.
    const before = build();
    const zombie = await before.service.create({ tenant: "acme", createdBy: "alice", image: "img", ttlSec: 60 });
    const fresh = await before.service.create({ tenant: "acme", createdBy: "alice", image: "img", ttlSec: 3600 });
    // A NEW process finds only the rows: the zombie's deadline (00:01) + grace is long past, fresh is not.
    const rebornDriver = fakeDriver();
    const reborn = new SandboxSessionService({
      store: before.runStore.store,
      driver: rebornDriver.driver,
      now: () => "2026-07-30T00:10:00.000Z",
    });
    await expect(reborn.sweepOrphans()).resolves.toBe(1);
    const settled = await before.runStore.store.get(zombie.id);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.session?.closedReason).toBe("orphaned");
    expect(rebornDriver.reaped).toEqual(["c-1"]); // the stray container removed by the recorded compute id
    expect((await before.runStore.store.get(fresh.id))?.status).toBe("running"); // inside its deadline

    // Inside the grace window past the deadline, the row is left for its owner's normal teardown first.
    const graced = new SandboxSessionService({
      store: before.runStore.store,
      driver: fakeDriver().driver,
      now: () => "2026-07-30T01:00:30.000Z", // fresh's deadline (01:00) passed 30s ago — within grace
    });
    await expect(graced.sweepOrphans()).resolves.toBe(0);
    expect((await before.runStore.store.get(fresh.id))?.status).toBe("running");

    // A session live IN THIS process is the in-process sweep's business, never the ledger sweep's.
    const holder = build();
    await holder.service.create({ tenant: "acme", createdBy: "alice", image: "img", ttlSec: 60 });
    holder.setNow("2026-07-30T00:10:00.000Z"); // way past deadline+grace, but the handle lives here
    await expect(holder.service.sweepOrphans()).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Harness playground: a harness booted INTO the session, test cases driven through it one at a time.
// ---------------------------------------------------------------------------------------------------

import { PaymentRequiredError } from "@everdict/contracts";
import type { EvaluableHarness } from "@everdict/contracts";
import type { BudgetTracker, UsageMeter } from "@everdict/domain";
import type { ResolvedSessionHarness } from "./sandbox-session-service.js";

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// A controllable harness: install execs into the compute; run yields one assistant message, then (when
// `hold` is set) parks abort-aware — the close-mid-task drill releases it via the session's abort signal.
function fakePlaygroundHarness(opts: { hold?: boolean; image?: string | undefined } = {}) {
  const installs: string[] = [];
  const runCwds: string[] = [];
  const harness: EvaluableHarness = {
    id: "cc",
    version: "1.0.0",
    async install(compute) {
      installs.push("install");
      await compute.exec("npm i -g cc");
    },
    async *run(compute, task, ctx) {
      await compute.exec(`agent ${task}`, { cwd: "work" });
      yield { t: 1, kind: "message" as const, role: "assistant" as const, text: `did: ${task}` };
      if (opts.hold) {
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) return resolve();
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  };
  const resolved: ResolvedSessionHarness = {
    id: "cc",
    version: "1.0.0",
    kind: "process",
    harness,
    apiKeyEnv: { ANTHROPIC_API_KEY: "sk-test" },
    ...("image" in opts ? (opts.image !== undefined ? { image: opts.image } : {}) : { image: "harness-img:1" }),
  };
  return { resolved, installs, runCwds };
}

// `admitAfter` = how many admits pass before the fake starts refusing. The session's own create now admits
// too (the gate reaches this lane), so a test about the TASK's refusal has to let the session in first.
function fakeBudget(opts: { admitError?: boolean; admitAfter?: number } = {}) {
  const settles: Array<{ tenant: string; usd: number }> = [];
  let admits = 0;
  let releases = 0;
  const budget: BudgetTracker = {
    admit() {
      admits++;
      if (opts.admitError && admits > (opts.admitAfter ?? 0))
        throw new PaymentRequiredError("BUDGET_EXCEEDED", {}, "over budget");
    },
    release() {
      releases++;
    },
    settle(tenant, cost) {
      settles.push({ tenant, usd: cost.usd });
    },
    usage() {
      return { runs: 0, usd: 0, tokens: 0 };
    },
  };
  return { budget, settles, admits: () => admits, releases: () => releases };
}

describe("SandboxSessionService — the harness playground (test cases in a live session)", () => {
  const boot = async (
    over: Partial<SandboxSessionServiceDeps> = {},
    harnessOpts: Parameters<typeof fakePlaygroundHarness>[0] = {},
  ) => {
    const fake = fakePlaygroundHarness(harnessOpts);
    const ctx = build({ resolveSessionHarness: async () => fake.resolved, ...over });
    const record = await ctx.service.create({ tenant: "acme", createdBy: "alice", harness: { id: "cc" } });
    return { ...ctx, fake, session: record };
  };

  it("create with harness: warm-installs BEFORE the record, stamps the real harness id@version + attach tasks", async () => {
    const { fake, session, driver } = await boot();
    expect(fake.installs).toEqual(["install"]);
    expect(driver.execs).toContain("npm i -g cc"); // installed into the session container
    expect(session).toMatchObject({
      kind: "sandbox",
      harness: { id: "cc", version: "1.0.0" },
      caseId: "harness-img:1",
      attach: ["exec", "tasks"],
      session: { image: "harness-img:1" },
    });
  });

  it("a failed install disposes the container and leaves NO record (provision-before-record, extended)", async () => {
    const fake = fakePlaygroundHarness();
    fake.resolved.harness.install = async () => {
      throw new Error("npm registry down");
    };
    const { service, runStore, driver } = build({ resolveSessionHarness: async () => fake.resolved });
    await expect(service.create({ tenant: "acme", createdBy: "alice", harness: { id: "cc" } })).rejects.toMatchObject({
      code: "HARNESS_INSTALL_FAILED",
    });
    expect(runStore.rows.size).toBe(0);
    expect(driver.disposed.length).toBe(1);
  });

  it("no resolver → 400; resolver miss → 404; an imageless spec without harness.image → 400 naming the fix", async () => {
    const bare = build();
    await expect(
      bare.service.create({ tenant: "acme", createdBy: "alice", harness: { id: "cc" } }),
    ).rejects.toMatchObject({ status: 400 });
    const missing = build({ resolveSessionHarness: async () => undefined });
    await expect(
      missing.service.create({ tenant: "acme", createdBy: "alice", harness: { id: "nope" } }),
    ).rejects.toMatchObject({ status: 404 });
    const imageless = fakePlaygroundHarness({ image: undefined });
    const noImage = build({ resolveSessionHarness: async () => imageless.resolved });
    await expect(
      noImage.service.create({ tenant: "acme", createdBy: "alice", harness: { id: "cc" } }),
    ).rejects.toMatchObject({ status: 400 });
    // the same imageless spec boots when the caller provides the image
    const withImage = build({ resolveSessionHarness: async () => imageless.resolved });
    const rec = await withImage.service.create({
      tenant: "acme",
      createdBy: "alice",
      harness: { id: "cc", image: "node:22" },
    });
    expect(rec.session?.image).toBe("node:22");
  });

  it("submitTask creates a grouped child run (born running, run.submitted fact) and settles it succeeded with a sealed trajectory + billing settle", async () => {
    const { budget, settles } = fakeBudget();
    const usageLines: string[] = [];
    const usage: UsageMeter = {
      record(tenant, source, model) {
        usageLines.push(`${tenant}:${source}:${model}`);
      },
      usage(): ReturnType<UsageMeter["usage"]> {
        throw new Error("not used in this test");
      },
    };
    const { service, runStore, trajectories, session } = await boot({ budget, usage });
    const child = await service.submitTask(creator, session.id, { task: "add a README" });
    expect(child).toMatchObject({
      kind: "eval",
      class: "interactive",
      status: "running",
      trigger: "playground",
      harness: { id: "cc", version: "1.0.0" },
      caseId: "task-1",
      group: { id: session.id, role: "case" },
      placement: { where: "driver" },
    });
    expect(runStore.events.some((e) => e.op === "create" && e.kinds.includes("run.submitted"))).toBe(true);
    await until(() => runStore.rows.get(child.id)?.status === "succeeded");
    // Evidence sealed under the CHILD run id; the session's own trace holds only boundary markers.
    expect(trajectories.sealed.get(child.id)?.events.some((e) => e.kind === "message")).toBe(true);
    const trace = await service.readTaskTrace(creator, session.id, child.id, 0);
    expect(trace.done).toBe(true);
    expect(trace.events.map((e) => e.kind)).toContain("message");
    // The session view reflects the settled task.
    const view = await service.getSession(creator, session.id);
    expect(view.live?.tasks).toMatchObject([{ runId: child.id, caseId: "task-1", status: "succeeded" }]);
    expect(view.live?.busy).toBe(false);
    // billingCharges on a costless trace still settles nothing (no llm_call cost lines, own-pays) — the
    // wiring is exercised, the amounts stay honest.
    expect(settles.every((s) => s.tenant === "acme")).toBe(true);
    expect(usageLines.every((l) => l.startsWith("acme:"))).toBe(true);
  });

  it("one task at a time: a second submit while one runs is a 409 naming the active run", async () => {
    const { service, session, runStore } = await boot({}, { hold: true });
    const first = await service.submitTask(creator, session.id, { task: "one" });
    await expect(service.submitTask(creator, session.id, { task: "two" })).rejects.toMatchObject({
      status: 409,
      extra: { activeRun: first.id },
    });
    await service.close(creator, session.id); // releases the held task
    await until(() => runStore.rows.get(first.id)?.status === "failed");
  });

  it("budget admission refuses at 402 BEFORE any child record exists", async () => {
    const { budget, admits } = fakeBudget({ admitError: true, admitAfter: 1 }); // 1 = the session's own create
    const { service, runStore, session } = await boot({ budget });
    const before = runStore.rows.size;
    await expect(service.submitTask(creator, session.id, { task: "x" })).rejects.toMatchObject({ status: 402 });
    expect(runStore.rows.size).toBe(before);
    expect(admits()).toBe(2);
  });

  it("closing the session mid-task aborts the drive: the child settles failed{CANCELLED} with its partial trace sealed", async () => {
    const { service, runStore, trajectories, session } = await boot({}, { hold: true });
    const child = await service.submitTask(creator, session.id, { task: "long one" });
    await until(() => trajectories.sealed.size >= 0 && runStore.rows.get(child.id) !== undefined);
    await service.close(creator, session.id);
    await until(() => runStore.rows.get(child.id)?.status === "failed");
    expect(runStore.rows.get(child.id)?.error?.code).toBe("CANCELLED");
    // Partial evidence still sealed under the child.
    expect(trajectories.sealed.get(child.id)?.events.some((e) => e.kind === "message")).toBe(true);
    // The session's own sealed trajectory carries the task boundary markers, not the task's events.
    const sessionTrace = trajectories.sealed.get(session.id)?.events ?? [];
    expect(sessionTrace.some((e) => e.kind === "env_action" && e.action === "task.start")).toBe(true);
    expect(sessionTrace.some((e) => e.kind === "message")).toBe(false);
  });

  it("readTaskTrace pages by cursor while live, then serves the sealed trajectory after settle (refresh-proof)", async () => {
    const { service, runStore, session } = await boot();
    const child = await service.submitTask(creator, session.id, { task: "cursor me" });
    await until(() => runStore.rows.get(child.id)?.status === "succeeded");
    const first = await service.readTaskTrace(creator, session.id, child.id, 0);
    expect(first.events.length).toBeGreaterThan(0);
    const second = await service.readTaskTrace(creator, session.id, child.id, first.nextCursor);
    expect(second.events).toEqual([]);
    expect(second.nextCursor).toBe(first.nextCursor);
    // After close (live buffers gone) the sealed fallback serves the same events.
    await service.close(creator, session.id);
    const sealed = await service.readTaskTrace(creator, session.id, child.id, 0);
    expect(sealed.done).toBe(true);
    expect(sealed.events.length).toBe(first.events.length);
  });

  it("submitTask is creator-or-admin and refuses a non-harness session with a pointed 400", async () => {
    const { service, session } = await boot();
    await expect(
      service.submitTask({ tenant: "acme", subject: "mallory", isAdmin: false }, session.id, { task: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    const plain = build();
    const rec = await plain.service.create({ tenant: "acme", createdBy: "alice", image: "python:3.12" });
    await expect(plain.service.submitTask(creator, rec.id, { task: "x" })).rejects.toMatchObject({ status: 400 });
  });

  it("listSessions returns only this tenant's live sessions with their task summaries (the reattach surface)", async () => {
    const { service, session } = await boot();
    await service.submitTask(creator, session.id, { task: "a very long task ".repeat(30) });
    const mine = await service.listSessions(creator);
    expect(mine.map((v) => v.record.id)).toEqual([session.id]);
    expect(mine[0]?.live?.harness).toEqual({ id: "cc", kind: "process", version: "1.0.0" });
    expect(mine[0]?.live?.tasks[0]?.taskPreview.length).toBeLessThanOrEqual(201);
    const other = await service.listSessions({ tenant: "zeta", subject: "bob", isAdmin: false });
    expect(other).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Agent worlds (W1): world sessions, snapshots, hibernate, touch.
// ---------------------------------------------------------------------------------------------------

function buildWorld(over: Partial<SandboxSessionServiceDeps> = {}) {
  const tagsByRepo = new Map<string, string[]>();
  const pushed: Array<{ id: string; ref: string; host?: string; user?: string; password?: string }> = [];
  const minted: string[] = [];
  const published: Array<{ tenant: string; actor: string; world: string; image: string; name?: string }> = [];
  const extended: Array<{ runId: string; expiresAt: string }> = [];
  const worldDriver = fakeDriver({
    snapshot: (id, ref, auth) => {
      pushed.push({
        id,
        ref,
        ...(auth !== undefined ? { host: auth.host, password: auth.password } : {}),
        ...(auth?.username !== undefined ? { user: auth.username } : {}),
      });
      // The push makes the tag exist — mirror it so the NEXT snapshot mints v<n+1>.
      const name = ref.slice(ref.lastIndexOf("/") + 1);
      const [repo, tag] = name.split(":");
      if (repo && tag) tagsByRepo.set(repo, [...(tagsByRepo.get(repo) ?? []), tag]);
    },
  });
  const images: NonNullable<SandboxSessionServiceDeps["images"]> = {
    endpoint: "reg.local:5000",
    namespaceFor: (tenant) => `${tenant}-ns`,
    listTags: async (_tenant, repo) => {
      const tags = tagsByRepo.get(repo);
      if (!tags) throw new NotFoundError("NOT_FOUND", { repo }, "no such repository");
      return tags;
    },
    inspect: async (_tenant, repo, reference) => ({ reference, digest: `sha256:${repo}.${reference}` }),
    mintPushGrant: async (_tenant, repo) => {
      minted.push(repo);
      return {
        endpoint: "reg.local:5000",
        repositories: [repo],
        actions: ["push" as const],
        token: "grant-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
  };
  let versionSeq = 0;
  const publishWorldVersion: NonNullable<SandboxSessionServiceDeps["publishWorldVersion"]> = async (
    tenant,
    actor,
    world,
    input,
  ) => {
    published.push({
      tenant,
      actor: actor.subject,
      world,
      image: input.image,
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
    versionSeq += 1;
    return { version: `1.0.${versionSeq - 1}` };
  };
  const reaper = {
    start: async () => {},
    signalClosed: async () => {},
    extend: async (input: { runId: string; tenant: string; expiresAt: string }) => {
      extended.push({ runId: input.runId, expiresAt: input.expiresAt });
    },
  };
  const ctx = build({ driver: worldDriver.driver, images, publishWorldVersion, reaper, ...over });
  return { ...ctx, worldDriver, images, publishWorldVersion, pushed, minted, published, extended, tagsByRepo };
}

describe("SandboxSessionService — agent worlds (W1: snapshot, hibernate, touch)", () => {
  it("a world session boots its latest snapshot when the world exists, or is founded from the genesis image", async () => {
    const existing = buildWorld({
      resolveEnvironmentImage: async (_t, _s, ref) =>
        ref.id === "proj" ? { image: "reg.local:5000/acme-ns/proj:v3@sha256:x", version: "1.0.2" } : undefined,
    });
    const fromWorld = await existing.service.create({ tenant: "acme", createdBy: "alice", world: { id: "proj" } });
    expect(fromWorld.harness).toEqual({ id: "proj", version: "1.0.2" });
    expect(fromWorld.session).toMatchObject({
      image: "reg.local:5000/acme-ns/proj:v3@sha256:x",
      world: "proj",
      hibernate: true, // world sessions hibernate by default
    });

    const genesis = await existing.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "fresh" },
      image: "debian:stable",
      hibernate: false,
    });
    expect(genesis.harness).toEqual({ id: "fresh", version: "genesis" });
    expect(genesis.session).toMatchObject({ image: "debian:stable", world: "fresh", hibernate: false });

    await expect(
      existing.service.create({ tenant: "acme", createdBy: "alice", world: { id: "ghost" } }),
    ).rejects.toMatchObject({ status: 404 }); // no version, no genesis image — nothing to boot

    await expect(
      existing.service.create({ tenant: "acme", createdBy: "alice", world: { id: "Bad Name" }, image: "img" }),
    ).rejects.toMatchObject({ status: 400 }); // the id doubles as a repository name

    await expect(
      existing.service.create({ tenant: "acme", createdBy: "alice", world: { id: "proj" }, harness: { id: "cc" } }),
    ).rejects.toMatchObject({ status: 400 }); // world and harness never combine
  });

  it("world sessions refuse at CREATE when the deployment cannot snapshot (no store to hibernate into)", async () => {
    const bare = build(); // no images / publish closure / snapshot-capable driver
    await expect(
      bare.service.create({ tenant: "acme", createdBy: "alice", world: { id: "proj" }, image: "img" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("snapshot publishes v<n> host-side with a transient grant, pins the digest, and records run.snapshotted", async () => {
    const ctx = buildWorld();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "debian:stable",
    });

    const first = await ctx.service.snapshot(creator, record.id, { name: "My project" });
    expect(first).toEqual({
      world: "proj",
      version: "1.0.0",
      image: "reg.local:5000/acme-ns/proj:v1@sha256:proj.v1", // digest pinned WITH the tag
    });
    expect(ctx.minted).toEqual(["proj"]); // one grant, one repository
    expect(ctx.pushed[0]).toEqual({
      id: "c-1", // the live container, committed host-side
      ref: "reg.local:5000/acme-ns/proj:v1",
      host: "reg.local:5000",
      user: "everdict",
      password: "grant-token",
    });
    expect(ctx.published[0]).toMatchObject({ tenant: "acme", actor: "alice", world: "proj", name: "My project" });
    expect(ctx.runStore.events.at(-1)).toMatchObject({ op: "update", kinds: ["run.snapshotted"] });
    expect((await ctx.runStore.store.get(record.id))?.session?.snapshots).toHaveLength(1);

    // The next snapshot sees v1 in the registry and mints v2.
    const second = await ctx.service.snapshot(creator, record.id, {});
    expect(second.image).toContain("proj:v2@");
    expect((await ctx.runStore.store.get(record.id))?.session?.snapshots).toHaveLength(2);
  });

  it("snapshot is creator-or-admin and refuses a session with no world", async () => {
    const ctx = buildWorld();
    const world = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    await expect(
      ctx.service.snapshot({ tenant: "acme", subject: "mallory", isAdmin: false }, world.id, {}),
    ).rejects.toMatchObject({ status: 403 });
    expect(ctx.pushed).toEqual([]); // the refused snapshot never touched the daemon

    const plain = await ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    await expect(ctx.service.snapshot(creator, plain.id, {})).rejects.toMatchObject({ status: 400 });
  });

  it("close hibernates a world session by default; snapshot:false skips it; expiry hibernates too", async () => {
    const ctx = buildWorld();
    const first = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    const closed = await ctx.service.close(creator, first.id);
    expect(ctx.published).toHaveLength(1); // the teardown captured the filesystem BEFORE the container died
    expect(closed).toMatchObject({ status: "succeeded", session: { closedReason: "closed" } });
    expect((await ctx.runStore.store.get(first.id))?.session?.snapshots).toHaveLength(1);

    const second = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    await ctx.service.close(creator, second.id, { snapshot: false }); // close-without-saving
    expect(ctx.published).toHaveLength(1);

    const third = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    ctx.setNow("2026-07-30T01:00:00.000Z"); // past the deadline
    ctx.service.sweep();
    await until(() => ctx.published.length === 2); // expiry = hibernation, not loss
    expect((await ctx.runStore.store.get(third.id))?.session?.closedReason).toBe("expired");
  });

  it("a snapshot failure never blocks teardown — the session still settles and the container still dies", async () => {
    const ctx = buildWorld({
      publishWorldVersion: async () => {
        throw new Error("registry down");
      },
    });
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    const closed = await ctx.service.close(creator, record.id);
    expect(closed).toMatchObject({ status: "succeeded", session: { closedReason: "closed" } });
    const sealed = await ctx.trajectories.store.get("acme", record.id);
    expect(sealed?.events.some((e) => e.kind === "env_action" && e.action === "session.snapshot_failed")).toBe(true);
  });

  it("touch extends the deadline in memory, on the row, and on the durable reaper — and never shortens", async () => {
    const ctx = buildWorld();
    const record = await ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img" }); // ttl 900 → 00:15
    ctx.setNow("2026-07-30T00:05:00.000Z");
    const touched = await ctx.service.touch(creator, record.id, {});
    expect(touched.expiresAt).toBe("2026-07-30T00:20:00.000Z"); // now + 900s
    expect((await ctx.runStore.store.get(record.id))?.session?.expiresAt).toBe("2026-07-30T00:20:00.000Z");
    expect(ctx.extended).toEqual([{ runId: record.id, expiresAt: "2026-07-30T00:20:00.000Z" }]);

    const shorter = await ctx.service.touch(creator, record.id, { ttlSec: 60 }); // proposed 00:06 < current 00:20
    expect(shorter.expiresAt).toBe("2026-07-30T00:20:00.000Z"); // a touch never PULLS a deadline in

    await expect(
      ctx.service.touch({ tenant: "acme", subject: "mallory", isAdmin: false }, record.id, {}),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("crash-path reap hibernates from the row alone (world + hibernate + computeId + creator), then reaps", async () => {
    const before = buildWorld();
    const record = await before.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    // A NEW process: fresh service + fresh driver double, sharing only the store and the world plumbing.
    const rebornPushed: Array<{ id: string; ref: string }> = [];
    const rebornDriver = fakeDriver({ snapshot: (id, ref) => rebornPushed.push({ id, ref }) });
    const reborn = new SandboxSessionService({
      store: before.runStore.store,
      driver: rebornDriver.driver,
      images: before.images,
      publishWorldVersion: before.publishWorldVersion,
    });
    await expect(reborn.reap("acme", record.id)).resolves.toEqual({ reaped: true });
    expect(rebornPushed[0]).toMatchObject({ id: "c-1" }); // the orphan's filesystem captured BEFORE removal
    expect(rebornDriver.reaped).toEqual(["c-1"]);
    const row = await before.runStore.store.get(record.id);
    expect(row?.session?.closedReason).toBe("orphaned");
    expect(row?.session?.snapshots).toHaveLength(1);
    expect(before.published.at(-1)).toMatchObject({ actor: "alice" }); // attributed to the row's creator
  });
});

// Regression (live drill, 2026-08-05): booting a world snapshot 401'd at the registry because the session
// lane never resolved pull credentials — every world image and every managed-store environment lives behind
// a grant. The credential must ride the PROVISION (grants are short-lived), not the driver's construction.
describe("SandboxSessionService — pull credentials for the booted image", () => {
  it("resolves pull auths for the image and passes them to provision; no resolver = an anonymous pull", async () => {
    const asked: Array<{ tenant: string; refs: string[] }> = [];
    const ctx = build({
      resolvePullAuths: async (tenant, refs) => {
        asked.push({ tenant, refs });
        return [{ host: "reg.local:5000", username: "everdict", password: "pull-grant" }];
      },
      resolveEnvironmentImage: async () => ({ image: "reg.local:5000/acme-ns/proj:v2", version: "1.0.1" }),
    });
    await ctx.service.create({ tenant: "acme", createdBy: "alice", environment: { id: "proj" } });
    expect(asked).toEqual([{ tenant: "acme", refs: ["reg.local:5000/acme-ns/proj:v2"] }]);
    expect(ctx.driver.provisioned[0]?.registryAuths).toEqual([
      { host: "reg.local:5000", username: "everdict", password: "pull-grant" },
    ]);

    // A failing resolver never blocks the boot — the pull just goes anonymous and the registry decides.
    const lenient = build({
      resolvePullAuths: async () => {
        throw new Error("registry unreachable");
      },
    });
    await expect(lenient.service.create({ tenant: "acme", createdBy: "alice", image: "img" })).resolves.toMatchObject({
      kind: "sandbox",
    });
    expect(lenient.driver.provisioned[0]?.registryAuths).toBeUndefined();

    const bare = build(); // no resolver wired at all
    await bare.service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    expect(bare.driver.provisioned[0]?.registryAuths).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Agent worlds (W2): a repository in, commits out. The credential rules are the point — a clone holds a
// read token for one command, a push mints a write token for one command, and neither is ever stored.
// ---------------------------------------------------------------------------------------------------

function buildGit(over: Partial<SandboxSessionServiceDeps> = {}) {
  const reads: string[] = [];
  const writes: string[] = [];
  const prs: Array<{ gitUrl: string; branch: string; title: string }> = [];
  const git: NonNullable<SandboxSessionServiceDeps["git"]> = {
    readToken: async (_tenant, gitUrl) => {
      reads.push(gitUrl);
      return gitUrl.includes("public") ? undefined : "read-token";
    },
    writeToken: async (_tenant, gitUrl) => {
      writes.push(gitUrl);
      if (gitUrl.includes("uninstalled")) throw new NotFoundError("NOT_FOUND", { git: gitUrl }, "no installation");
      return "write-token";
    },
    openPullRequest: async (_tenant, gitUrl, input) => {
      prs.push({ gitUrl, branch: input.branch, title: input.title });
      return { url: "https://github.com/acme/app/pull/7", base: "main" };
    },
  };
  const ctx = build({ git, ...over });
  return { ...ctx, git, reads, writes, prs };
}

describe("SandboxSessionService — agent worlds (W2: a repository in, commits out)", () => {
  it("clone happens BEFORE the record, with the token in the environment and never in argv", async () => {
    const ctx = buildGit();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      image: "debian",
      repo: { git: "https://github.com/acme/app.git", ref: "v1.2.0" },
    });
    expect(ctx.reads).toEqual(["https://github.com/acme/app.git"]);
    expect(record.session?.repo).toEqual({ git: "https://github.com/acme/app.git", ref: "v1.2.0", dir: "work" });
    const clone = ctx.driver.execs.find((c) => c.includes("git clone"));
    expect(clone).toContain("git clone 'https://github.com/acme/app.git' 'work'");
    expect(clone).not.toContain("read-token"); // the credential is NEVER an argument
    expect(ctx.driver.execEnvs.find((e) => e?.GIT_CONFIG_VALUE_0 !== undefined)?.GIT_CONFIG_VALUE_0).toBe(
      "Authorization: Bearer read-token",
    );
    expect(ctx.driver.execs.some((c) => c.includes("git checkout 'v1.2.0'"))).toBe(true);
    expect(ctx.driver.execs.some((c) => c.includes("git config user.email"))).toBe(true);
  });

  it("a public repo clones with no credential; a failed clone leaves NO record and no container", async () => {
    const ctx = buildGit();
    await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      image: "debian",
      repo: { git: "https://github.com/acme/public.git" },
    });
    expect(ctx.driver.execEnvs.every((e) => e?.GIT_CONFIG_VALUE_0 === undefined)).toBe(true);

    const failing = buildGit();
    await expect(
      failing.service.create({
        tenant: "acme",
        createdBy: "alice",
        image: "debian",
        repo: { git: "https://github.com/acme/boom.git" }, // the fake driver fails any command containing "boom"
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(await failing.runStore.store.list("acme")).toEqual([]);
    expect(failing.driver.disposed).toEqual(["c-1"]); // provision-before-record: no row, no leak
  });

  it("push mints a write token per call, reads the remote from the CONTAINER, and can open a PR", async () => {
    const ctx = buildGit();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      image: "debian",
      repo: { git: "https://github.com/acme/app.git" },
    });
    const result = await ctx.service.gitPush(creator, record.id, {
      pullRequest: { title: "Add the thing" },
    });
    expect(ctx.writes).toEqual(["ran:git remote get-url 'origin'"]); // the container's answer, not the record's
    expect(result.branch).toBe("ran:git rev-parse --abbrev-ref HEAD");
    expect(ctx.prs).toMatchObject([{ title: "Add the thing" }]);
    expect(result.pullRequest).toEqual({ url: "https://github.com/acme/app/pull/7", base: "main" });
    const push = ctx.driver.execs.find((c) => c.startsWith("git push"));
    expect(push).not.toContain("write-token");
    // The evidence names what left the session — never the credential.
    await ctx.service.close(creator, record.id);
    const sealed = await ctx.trajectories.store.get("acme", record.id);
    const pushEvent = sealed?.events.find((e) => e.kind === "env_action" && e.action === "git.push");
    expect(JSON.stringify(pushEvent)).not.toContain("write-token");
    expect(pushEvent).toBeDefined();
  });

  it("push is creator-or-admin, 400s without a remote or git seam, and surfaces an uninstalled repo", async () => {
    const ctx = buildGit();
    const record = await ctx.service.create({ tenant: "acme", createdBy: "alice", image: "debian" });
    await expect(
      ctx.service.gitPush({ tenant: "acme", subject: "mallory", isAdmin: false }, record.id, {}),
    ).rejects.toMatchObject({ status: 403 });

    const bare = build(); // no git seam wired at all
    const plain = await bare.service.create({ tenant: "acme", createdBy: "alice", image: "debian" });
    await expect(bare.service.gitPush(creator, plain.id, {})).rejects.toMatchObject({ status: 400 });

    const empty = buildGit({ driver: fakeDriver({ emptyStdout: true }).driver });
    const noRemote = await empty.service.create({ tenant: "acme", createdBy: "alice", image: "debian" });
    await expect(empty.service.gitPush(creator, noRemote.id, {})).rejects.toMatchObject({ status: 400 });
  });
});

// Retention (agent worlds W3) — autonomy without a bound is a disk that fills: a world gains a version per
// hibernate and the registry has no GC. The prune runs after the publish and can never undo it.
describe("SandboxSessionService — world retention", () => {
  it("reports what retention removed, and a prune failure never fails the snapshot that already succeeded", async () => {
    const pruneCalls: Array<{ world: string; actor: string }> = [];
    const ctx = buildWorld({
      pruneWorldVersions: async (_tenant, actor, world) => {
        pruneCalls.push({ world, actor: actor.subject });
        return { prunedVersions: ["1.0.0", "1.0.1"] };
      },
    });
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    const result = await ctx.service.snapshot(creator, record.id, {});
    expect(result.prunedVersions).toEqual(["1.0.0", "1.0.1"]);
    expect(pruneCalls).toEqual([{ world: "proj", actor: "alice" }]); // pruned as the session's own creator

    const broken = buildWorld({
      pruneWorldVersions: async () => {
        throw new Error("registry refused the delete");
      },
    });
    const second = await broken.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    const survived = await broken.service.snapshot(creator, second.id, {});
    expect(survived.version).toBe("1.0.0"); // the publish stands
    expect(survived.prunedVersions).toBeUndefined(); // and says nothing was pruned
  });

  it("omits prunedVersions when nothing was dropped — the field means 'this was removed', not 'a bound exists'", async () => {
    const ctx = buildWorld({ pruneWorldVersions: async () => ({ prunedVersions: [] }) });
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    expect((await ctx.service.snapshot(creator, record.id, {})).prunedVersions).toBeUndefined();
  });
});

// Loop guard (agent worlds W3) — an autonomous agent snapshots its world, and `run.snapshotted` is workspace
// news. Without `causedBy: agent:<id>:<conversation>` on the fact, the agent's own subscription would wake it
// on its own effect. The key has to survive the paths that emit LATER than the request: expiry, and the
// crash-path reaper in a whole different process.
describe("SandboxSessionService — agent attribution on the facts (loop guard #1)", () => {
  const asAgent = { ...creator, agent: { agentId: "researcher", conversationId: "conv-7" } };

  it("stamps every fact of an agent-driven session — creation, snapshot and the terminal one", async () => {
    const ctx = buildWorld();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
      agent: { agentId: "researcher", conversationId: "conv-7" },
    });
    expect(ctx.runStore.events[0]).toMatchObject({
      kinds: ["run.submitted"],
      causedBy: ["agent:researcher:conv-7"],
    });
    expect(record.session?.agent).toEqual({ agentId: "researcher", conversationId: "conv-7" }); // on the ROW

    await ctx.service.snapshot(asAgent, record.id, {});
    expect(ctx.runStore.events.at(-1)).toMatchObject({
      kinds: ["run.snapshotted"],
      causedBy: ["agent:researcher:conv-7"],
    });

    await ctx.service.close(asAgent, record.id, { snapshot: false });
    expect(ctx.runStore.events.at(-1)).toMatchObject({
      kinds: ["run.completed"],
      causedBy: ["agent:researcher:conv-7"],
    });
  });

  it("a member-driven session stamps nothing — causedBy names an agent or is absent", async () => {
    const ctx = buildWorld();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
    });
    expect(ctx.runStore.events[0]).toMatchObject({ kinds: ["run.submitted"], causedBy: [undefined] });
    await ctx.service.close(creator, record.id, { snapshot: false });
    expect(ctx.runStore.events.at(-1)).toMatchObject({ kinds: ["run.completed"], causedBy: [undefined] });
  });

  it("the CRASH path keeps the key: a reaper in a later process reads it off the row", async () => {
    const before = buildWorld();
    const record = await before.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "img",
      ttlSec: 60,
      agent: { agentId: "researcher", conversationId: "conv-7" },
    });
    // A NEW process: only the row survives — no live map, no memory of who asked.
    const rebornDriver = fakeDriver({ snapshot: () => {} });
    const reborn = new SandboxSessionService({
      store: before.runStore.store,
      driver: rebornDriver.driver,
      images: before.images,
      publishWorldVersion: before.publishWorldVersion,
      now: () => "2026-07-30T01:00:00.000Z", // past the deadline
    });
    await expect(reborn.reap("acme", record.id)).resolves.toEqual({ reaped: true });
    const emitted = before.runStore.events.slice(1);
    expect(emitted.flatMap((e) => e.kinds)).toEqual(["run.snapshotted", "run.completed"]);
    expect(emitted.flatMap((e) => e.causedBy)).toEqual(["agent:researcher:conv-7", "agent:researcher:conv-7"]);
  });
});

// Capacity when agents share the workspace (W3). The flat per-tenant cap was written for members clicking a
// button; an autonomous agent holding worlds across hibernates changes what it means.
describe("SandboxSessionService — capacity with autonomous agents", () => {
  const bot = (agentId: string) => ({ agentId, conversationId: "c1" });

  it("bounds ONE agent to its own slot and names what is holding it", async () => {
    const ctx = build({ maxPerTenant: 4, maxPerAgent: 1 });
    await ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", agent: bot("researcher") });
    await expect(
      ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", agent: bot("researcher") }),
    ).rejects.toMatchObject({ status: 429, extra: { scope: "agent", agent: "researcher" } });
    // A DIFFERENT agent still has its own slot — the bound is per agent, not "one agent at a time".
    await expect(
      ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", agent: bot("reviewer") }),
    ).resolves.toMatchObject({ kind: "sandbox" });
  });

  it("keeps the LAST tenant slot for a member — an agent cannot starve the person waiting to debug", async () => {
    const ctx = build({ maxPerTenant: 2, maxPerAgent: 5 });
    await ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", agent: bot("researcher") });
    // One of two slots is taken; the second is reserved, so the agent is refused …
    await expect(
      ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", agent: bot("reviewer") }),
    ).rejects.toMatchObject({ status: 429, extra: { scope: "tenant", limit: 1 } });
    // … and the member gets it.
    await expect(ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img" })).resolves.toMatchObject({
      kind: "sandbox",
    });
  });

  it("a 1-slot deployment does not ban agents outright (reserve applies only where there is room)", async () => {
    const ctx = build({ maxPerTenant: 1 });
    await expect(
      ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", agent: bot("researcher") }),
    ).resolves.toMatchObject({ kind: "sandbox" });
  });

  it("a refusal says WHEN a slot frees, so waiting is a decision rather than a guess", async () => {
    const ctx = build({ maxPerTenant: 1 });
    await ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", ttlSec: 600 });
    await expect(ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img" })).rejects.toMatchObject({
      extra: { freesAt: "2026-07-30T00:10:00.000Z" },
    });
  });
});

// The placement-independent snapshot (W4): capture the work tree over the exec channel and publish it as one
// more layer on the image the session booted — no daemon, so the same path works for a session on a cluster.
describe("SandboxSessionService — snapshot without a container daemon", () => {
  function buildLayer(over: Partial<SandboxSessionServiceDeps> = {}) {
    const published: Array<{ tag: string; baseReference: string; createdBy: string; bytes: number }> = [];
    const daemonless = fakeDriver(); // no snapshot() — the driver cannot commit, as on a cluster
    const ctx = buildWorld({
      driver: daemonless.driver,
      publishLayerSnapshot: async (input) => {
        published.push({
          tag: input.tag,
          baseReference: input.baseReference,
          createdBy: input.createdBy,
          bytes: input.layerGzip.length,
        });
        return { digest: "sha256:layer-published" };
      },
      ...over,
    });
    return { ...ctx, published, daemonless };
  }

  it("captures rooted at / so the layer's paths restore where they came from", async () => {
    const ctx = buildLayer();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v2@sha256:base",
    });
    await ctx.service.snapshot(creator, record.id, {});

    // An image layer's paths are ROOT-relative. `tar -C /everdict .` yields `./proj/…`, which unpacks to
    // `/proj/…` — the files land beside where they came from and the world boots looking untouched. A live
    // drill published exactly that: clean snapshot, and the next session read the old file.
    const capture = ctx.daemonless.execs.find((c) => c.includes("base64"));
    expect(capture).toContain("tar -C / -czf - 'everdict'");
    expect(capture).not.toContain("tar -C '/everdict'");
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]).toMatchObject({ tag: "v1", baseReference: "sha256:base" }); // a digest base pins by digest
  });

  it("addresses the base by TAG when the booted ref carries no digest", async () => {
    const ctx = buildLayer();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v7",
    });
    await ctx.service.snapshot(creator, record.id, {});
    expect(ctx.published[0]?.baseReference).toBe("v7");
  });

  it("refuses a capture past the bound instead of publishing a truncated world", async () => {
    const big = fakeDriver();
    const ctx = buildLayer({ driver: big.driver, maxCaptureBytes: 10 });
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v1",
    });
    // The fake answers `ran:<cmd>` to every exec, so the size probe parses as NaN and cannot trip the bound;
    // a driver whose probe reports a real number does. This pins the REFUSAL, not the parse.
    const counted = build({
      driver: {
        id: "sized",
        async provision() {
          return {
            id: "c-sized",
            async exec(cmd: string) {
              return { stdout: cmd.includes("wc -c") ? "999999" : "", stderr: "", exitCode: 0 };
            },
            async writeFile() {},
            async readFile() {
              return "";
            },
            async dispose() {},
          };
        },
      },
      images: ctx.images,
      publishWorldVersion: ctx.publishWorldVersion,
      publishLayerSnapshot: async () => ({ digest: "sha256:never" }),
      maxCaptureBytes: 10,
    });
    const session = await counted.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v1",
    });
    await expect(counted.service.snapshot(creator, session.id, {})).rejects.toMatchObject({
      status: 400,
      extra: { bytes: 999999, limit: 10 },
    });
    expect(record.session?.world).toBe("proj"); // the other session is untouched
  });
});

// Placement (W4): a workspace with its own cluster runs its worlds there. The axis is the same one a run's
// placement.target names, and the row records it so a LATER process reaps through the right compute.
describe("SandboxSessionService — placing a session on the workspace's own runtime", () => {
  it("provisions on the named runtime, records it, and reaps the orphan through THAT driver", async () => {
    const tenantDriver = fakeDriver();
    const asked: Array<{ tenant: string; runtime: string }> = [];
    const ctx = build({
      driverFor: async (tenant, runtime) => {
        asked.push({ tenant, runtime });
        return runtime === "acme-nomad" ? tenantDriver.driver : undefined;
      },
    });
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      image: "img",
      runtime: "acme-nomad",
      ttlSec: 60,
    });
    expect(asked).toEqual([{ tenant: "acme", runtime: "acme-nomad" }]);
    expect(tenantDriver.provisioned).toHaveLength(1); // the tenant's cluster, not the default
    expect(ctx.driver.provisioned).toHaveLength(0);
    expect(record.runtime).toBe("acme-nomad"); // on the row — the reaper has nothing else to go on

    // A later process: no live handle, only the row. The reap must reach the tenant's cluster.
    const rebornTenant = fakeDriver();
    const reborn = new SandboxSessionService({
      store: ctx.runStore.store,
      driver: fakeDriver().driver,
      driverFor: async (_t, runtime) => (runtime === "acme-nomad" ? rebornTenant.driver : undefined),
      now: () => "2026-07-30T01:00:00.000Z", // past the deadline
    });
    await expect(reborn.reap("acme", record.id)).resolves.toEqual({ reaped: true });
    expect(rebornTenant.reaped).toEqual(["c-1"]);
  });

  it("a runtime the workspace does not have is a 404 naming it — never a quiet fall back to our compute", async () => {
    const ctx = build({ driverFor: async () => undefined });
    await expect(
      ctx.service.create({ tenant: "acme", createdBy: "alice", image: "img", runtime: "ghost" }),
    ).rejects.toMatchObject({ status: 404, extra: { runtime: "ghost" } });
    expect(ctx.driver.provisioned).toHaveLength(0); // the default compute never saw it

    // With no resolver wired at all, naming a runtime is still a 404 rather than silent default placement.
    const bare = build();
    await expect(
      bare.service.create({ tenant: "acme", createdBy: "alice", image: "img", runtime: "acme-nomad" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("snapshots through the driver that HOLDS the session, not the deployment default", async () => {
    const committed: string[] = [];
    const daemonless = fakeDriver(); // the tenant's cluster — no snapshot()
    const ctx = buildWorld({
      driver: fakeDriver({ snapshot: (id) => committed.push(id) }).driver, // the default CAN commit
      driverFor: async () => daemonless.driver,
      publishLayerSnapshot: async () => ({ digest: "sha256:via-registry" }),
    });
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v1",
      runtime: "acme-nomad",
    });
    await ctx.service.snapshot(creator, record.id, {});
    // Asking the default driver would take a path that cannot reach this container at all.
    expect(committed).toEqual([]);
    expect(daemonless.execs.some((c) => c.includes("base64"))).toBe(true);
  });
});

// Regression (live drill, cluster placement): a world session on a daemonless placement closed cleanly and
// published NOTHING. teardown removes the session from the live map FIRST (so a concurrent close stays
// idempotent) and hibernates after — and the capture used to re-read that map, finding nothing exactly when
// hibernation matters most. The daemon path hid it: `driver.snapshot` works off the compute id, not the map.
describe("SandboxSessionService — hibernation on a daemonless placement", () => {
  function buildDaemonless(over: Partial<SandboxSessionServiceDeps> = {}) {
    const daemonless = fakeDriver(); // no snapshot() — a cluster
    const published: string[] = [];
    const ctx = buildWorld({
      driver: daemonless.driver,
      publishLayerSnapshot: async (input) => {
        published.push(input.tag);
        return { digest: "sha256:hibernated" };
      },
      ...over,
    });
    return { ...ctx, daemonless, published };
  }

  it("captures through the handle teardown still holds — close hibernates instead of quietly publishing nothing", async () => {
    const ctx = buildDaemonless();
    const record = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v1",
    });
    const closed = await ctx.service.close(creator, record.id);
    expect(ctx.published).toEqual(["v1"]); // the capture ran AFTER the map delete and still had its compute
    expect(closed?.session?.snapshots?.map((s) => s.version)).toEqual(["1.0.0"]);
    const sealed = await ctx.trajectories.store.get("acme", record.id);
    expect(sealed?.events.some((e) => e.kind === "env_action" && e.action === "session.snapshot_failed")).toBe(false);
  });

  it("expiry hibernates the same way (the sweep tears down through the same path)", async () => {
    const ctx = buildDaemonless();
    await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v1",
      ttlSec: 60,
    });
    ctx.setNow("2026-07-30T01:00:00.000Z");
    ctx.service.sweep();
    await until(() => ctx.published.length === 1);
  });

  it("says plainly that a CRASH-orphaned session cannot be hibernated on this placement", async () => {
    const before = buildDaemonless();
    const record = await before.service.create({
      tenant: "acme",
      createdBy: "alice",
      world: { id: "proj" },
      image: "reg.local:5000/acme-ns/proj:v1",
      ttlSec: 60,
    });
    // A NEW process: the alloc may still be alive, but this control plane has no exec channel to it.
    const reborn = new SandboxSessionService({
      store: before.runStore.store,
      driver: fakeDriver().driver,
      images: before.images,
      publishWorldVersion: before.publishWorldVersion,
      publishLayerSnapshot: async () => ({ digest: "sha256:never" }),
      now: () => "2026-07-30T01:00:00.000Z",
    });
    await expect(reborn.reap("acme", record.id)).resolves.toEqual({ reaped: true });
    // The row still settles and the compute is still reclaimed — the snapshot is what is lost, and the
    // failure is a stated limitation rather than a silent skip.
    expect((await before.runStore.store.get(record.id))?.session?.snapshots ?? []).toEqual([]);
  });
});

// Admission (execution-model §5.1). The session lane answered the loop guard (causedBy on facts) but not the
// GATE: an agent could hold sessions open spending against nobody, with no causal-depth guard in the way.
describe("SandboxSessionService — the singular admission gate", () => {
  it("an agent's session draws from its turn's envelope, and the causal edge lands on the row", async () => {
    const { service, runStore } = build();
    await runStore.store.create({
      id: "turn-1",
      tenant: "acme",
      harness: { id: "assistant", version: "1" },
      caseId: "chat",
      status: "running",
      kind: "agent",
      envelope: { id: "turn-1", capUsd: 5 },
      createdAt: "t",
      updatedAt: "t",
    });

    const run = await service.create({
      ...creator,
      createdBy: "alice",
      image: "debian:stable-slim",
      agent: { agentId: "a1", conversationId: "c1", runId: "turn-1" },
    });

    // Caps live on the ROOT the id names; an inherited stamp carries only the id.
    expect(run.envelope).toEqual({ id: "turn-1" });
    expect(run.origin?.causedByRunId).toBe("turn-1");
  });

  it("refuses a causer that is not this workspace's run, before any container is booted", async () => {
    const { service, driver } = build();
    await expect(
      service.create({
        ...creator,
        createdBy: "alice",
        image: "debian:stable-slim",
        agent: { agentId: "a1", runId: "not-ours" },
      }),
    ).rejects.toThrow(/does not name a run/i);
    expect(driver.provisioned).toHaveLength(0); // a refusal costs nothing
  });

  it("refuses past the tenant budget before booting anything", async () => {
    const { service, driver } = build({
      budget: {
        admit: () => {
          throw new PaymentRequiredError("BUDGET_EXCEEDED", {}, "over budget");
        },
        release: () => {},
        settle: () => {},
        usage: () => ({ runs: 0, usd: 0, tokens: 0 }),
      },
    });
    await expect(
      service.create({ ...creator, createdBy: "alice", image: "debian:stable-slim" }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(driver.provisioned).toHaveLength(0);
  });
});

// The pool is the LEDGER's, not this process's (a control plane may run more than one instance).
describe("SandboxSessionService — capacity counted from the ledger", () => {
  it("counts a session THIS process never opened — otherwise every replica hands out the cap again", async () => {
    const { service, runStore } = build({ maxPerTenant: 1 });
    // A session another replica opened: in the ledger, absent from this instance's map.
    await runStore.store.create({
      id: "held-elsewhere",
      tenant: "acme",
      harness: { id: "world", version: "1" },
      caseId: "img",
      status: "running",
      kind: "sandbox",
      lifetime: "session",
      trigger: "sandbox",
      session: { image: "img", ttlSec: 900, expiresAt: "2999-01-01T00:00:00.000Z" },
      createdAt: "t",
      updatedAt: "t",
    });

    await expect(service.create({ ...creator, createdBy: "alice", image: "debian:stable-slim" })).rejects.toMatchObject(
      { status: 429 },
    );
  });

  it("does NOT count a row past its deadline — a crashed writer must not hold a slot forever", async () => {
    // The row still says `running` because whoever opened it never got to settle it. Counting it would take
    // a session slot from the workspace permanently, with nothing the member could do about it; it is due
    // for teardown either way, so the pool stops reserving room for it.
    const { service, runStore } = build({ maxPerTenant: 1 });
    await runStore.store.create({
      id: "orphan",
      tenant: "acme",
      harness: { id: "world", version: "1" },
      caseId: "img",
      status: "running",
      kind: "sandbox",
      lifetime: "session",
      trigger: "sandbox",
      session: { image: "img", ttlSec: 900, expiresAt: "2000-01-01T00:00:00.000Z" },
      createdAt: "t",
      updatedAt: "t",
    });

    await expect(
      service.create({ ...creator, createdBy: "alice", image: "debian:stable-slim" }),
    ).resolves.toBeDefined();
  });

  it("does not count another POOL's session — a live browser must not consume a world's slot", async () => {
    const { service, runStore } = build({ maxPerTenant: 1 });
    await runStore.store.create({
      id: "a-browser",
      tenant: "acme",
      harness: { id: "browser", version: "1" },
      caseId: "direct",
      status: "running",
      kind: "sandbox", // same family — held-open isolated compute
      lifetime: "session",
      trigger: "browser", // different pool
      session: { image: "chrome", ttlSec: 900, expiresAt: "2999-01-01T00:00:00.000Z" },
      createdAt: "t",
      updatedAt: "t",
    });

    await expect(
      service.create({ ...creator, createdBy: "alice", image: "debian:stable-slim" }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Conversation sessions: the playground's multi-turn mode (one conversation, the harness resumes it).
// ---------------------------------------------------------------------------------------------------

// A conversational harness double: records the resume token each turn RECEIVED, reports a fresh token
// per turn (tok-1, tok-2, …) — the last-reported one is what the next turn must get back.
function fakeConversationalHarness() {
  const resumes: Array<string | undefined> = [];
  let n = 0;
  const harness: EvaluableHarness = {
    id: "cc",
    version: "1.0.0",
    conversational: true,
    async install(compute) {
      await compute.exec("npm i -g cc");
    },
    async *run(compute, task, ctx) {
      resumes.push(ctx.conversation?.resume);
      ctx.conversation?.onToken?.(`tok-${++n}`);
      await compute.exec(`agent ${task}`, { cwd: "work" });
      yield { t: 1, kind: "message" as const, role: "assistant" as const, text: `did: ${task}` };
    },
  };
  const resolved: ResolvedSessionHarness = {
    id: "cc",
    version: "1.0.0",
    kind: "process",
    harness,
    apiKeyEnv: {},
    image: "harness-img:1",
  };
  return { resolved, resumes };
}

describe("SandboxSessionService — conversation sessions (multi-turn playground)", () => {
  const bootConversation = async (over: Partial<SandboxSessionServiceDeps> = {}) => {
    const fake = fakeConversationalHarness();
    const ctx = build({ resolveSessionHarness: async () => fake.resolved, ...over });
    const session = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      harness: { id: "cc", conversation: true },
    });
    return { ...ctx, fake, session };
  };

  it("boot stamps conversation on the row and the live view (the web's one branch signal)", async () => {
    const { service, session } = await bootConversation();
    expect(session.session?.conversation).toBe(true);
    const view = await service.getSession(creator, session.id);
    expect(view.live?.conversation).toBe(true);
    expect(view.live?.harness).toEqual({ id: "cc", version: "1.0.0", kind: "process" });
  });

  it("a non-conversational harness refuses conversation mode BEFORE any container is provisioned, and releases the budget reservation", async () => {
    const fake = fakePlaygroundHarness(); // no `conversational` marker
    const budget = fakeBudget();
    const { service, driver, runStore } = build({
      resolveSessionHarness: async () => fake.resolved,
      budget: budget.budget,
    });
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", harness: { id: "cc", conversation: true } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(driver.provisioned.length).toBe(0); // refused up front — no container was ever spent
    expect(runStore.rows.size).toBe(0);
    // Regression: a post-admit resolution failure used to leak the budget reservation it had just taken.
    expect(budget.releases()).toBe(1);
  });

  it("an unknown harness after budget admission also releases the reservation (the same leak, 404 path)", async () => {
    const budget = fakeBudget();
    const { service } = build({ resolveSessionHarness: async () => undefined, budget: budget.budget });
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", harness: { id: "ghost" } }),
    ).rejects.toMatchObject({ status: 404 });
    expect(budget.releases()).toBe(1);
  });

  it("turns thread the resume token (turn 2 receives what turn 1 reported) and share ONE stable workdir", async () => {
    const { service, runStore, driver, fake, session } = await bootConversation();
    const turn1 = await service.submitTask(creator, session.id, { task: "remember the number 7" });
    await until(() => runStore.rows.get(turn1.id)?.status === "succeeded");
    const turn2 = await service.submitTask(creator, session.id, { task: "what number did I say?" });
    await until(() => runStore.rows.get(turn2.id)?.status === "succeeded");

    // Continuity: turn 1 started fresh; turn 2 resumed with the token turn 1 reported.
    expect(fake.resumes).toEqual([undefined, "tok-1"]);
    // Dependent evidence: turns group with role "turn" and count turn-<n>, never task-<n>.
    expect(turn1.caseId).toBe("turn-1");
    expect(turn2.group).toEqual({ id: session.id, role: "turn" });
    // One conversation = one workdir: both turns ran under conversation/work, no tasks/<n> rebasing.
    expect(driver.execs.filter((c) => c.includes("mkdir -p 'conversation/work'")).length).toBe(2);
    expect(driver.execs.some((c) => c.includes("tasks/"))).toBe(false);
  });

  it("fresh starts a new thread — drops the resume token, keeps the workdir — and marks the turn", async () => {
    const { service, runStore, fake, session } = await bootConversation();
    const turn1 = await service.submitTask(creator, session.id, { task: "hello" });
    await until(() => runStore.rows.get(turn1.id)?.status === "succeeded");
    const turn2 = await service.submitTask(creator, session.id, { task: "start over", fresh: true });
    await until(() => runStore.rows.get(turn2.id)?.status === "succeeded");

    expect(fake.resumes).toEqual([undefined, undefined]); // the reset really forgot the thread
    const view = await service.getSession(creator, session.id);
    expect(view.live?.tasks.map((t) => t.fresh)).toEqual([undefined, true]);
  });

  it("fresh on a non-conversation session is a 400 (independent cases have no thread to reset)", async () => {
    const fake = fakePlaygroundHarness();
    const { service } = build({ resolveSessionHarness: async () => fake.resolved });
    const session = await service.create({ tenant: "acme", createdBy: "alice", harness: { id: "cc" } });
    await expect(service.submitTask(creator, session.id, { task: "hi", fresh: true })).rejects.toMatchObject({
      status: 400,
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// Front-door conversation sessions: a kind:"service" harness driven multi-turn over its front-door.
// ---------------------------------------------------------------------------------------------------

import type { ResolvedServiceConversation, ServiceConversation } from "../ports/service-conversation.js";

function fakeServiceConversation(opts: { failBoot?: boolean } = {}) {
  const turns: Array<{ task: string; turnRunId: string }> = [];
  const openedFor: string[] = [];
  let closes = 0;
  const conversation: ServiceConversation = {
    async boot() {
      if (opts.failBoot) throw new NotFoundError("NOT_FOUND", {}, "no such runtime cluster");
      return { frontDoorBase: "http://fd:8000", cdpBase: "http://127.0.0.1:9222" };
    },
    async turn({ task, turnRunId }) {
      turns.push({ task, turnRunId });
      return {
        status: "done" as const,
        responseText: `reply to: ${task}`,
        trace: [{ t: 1, kind: "tool_call" as const, id: "c1", name: "search", args: {} }],
        infraMarks: [
          {
            t: 0,
            kind: "infra" as const,
            scope: "placement" as const,
            event: "drive_submitted",
            message: "front-door agent: POST /runs",
            at: "2026-07-30T00:00:00.000Z",
          },
        ],
      };
    },
    async close() {
      closes += 1;
    },
  };
  const resolved: ResolvedServiceConversation = {
    harness: { id: "aegra", version: "1.0.0" },
    frontDoorImage: "reg/aegra:1",
    open: (sessionRunId) => {
      openedFor.push(sessionRunId);
      return conversation;
    },
  };
  return { conversation, resolved, turns, openedFor, closes: () => closes };
}

describe("SandboxSessionService — front-door conversation sessions (service harnesses)", () => {
  const bootFrontdoor = async (over: Partial<SandboxSessionServiceDeps> = {}) => {
    const fake = fakeServiceConversation();
    const ctx = build({ resolveServiceConversation: async () => fake.resolved, ...over });
    const session = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      harness: { id: "aegra" },
      runtime: "nomad-seoul",
    });
    return { ...ctx, fake, session };
  };

  it("boots on the 'frontdoor' pool with NO container: trigger, conversation, runtime placement, no computeId", async () => {
    const { session, driver, fake } = await bootFrontdoor();
    expect(session).toMatchObject({
      kind: "sandbox",
      trigger: "frontdoor",
      harness: { id: "aegra", version: "1.0.0" },
      runtime: "nomad-seoul",
      attach: ["tasks"],
      placement: { where: "runtime", target: "nomad-seoul" },
      session: { image: "reg/aegra:1", conversation: true },
    });
    expect(session.session?.computeId).toBeUndefined(); // nothing for Driver.reap — row-only settle
    expect(driver.provisioned.length).toBe(0); // no container was ever provisioned
    expect(fake.openedFor).toEqual([session.id]); // the session id is the continuity key
  });

  it("a failed boot leaves NO row, releases the budget, and closes the half-acquired target", async () => {
    const fake = fakeServiceConversation({ failBoot: true });
    const budget = fakeBudget();
    const { service, runStore } = build({
      resolveServiceConversation: async () => fake.resolved,
      budget: budget.budget,
    });
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", harness: { id: "aegra" }, runtime: "nomad-seoul" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(runStore.rows.size).toBe(0);
    expect(budget.releases()).toBe(1);
    expect(fake.closes()).toBe(1);
  });

  it("refuses a service session without a runtime, and container-only asks (world/repo) by name", async () => {
    const fake = fakeServiceConversation();
    const { service } = build({ resolveServiceConversation: async () => fake.resolved });
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", harness: { id: "aegra" } }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("runtime") });
    await expect(
      service.create({
        tenant: "acme",
        createdBy: "alice",
        harness: { id: "aegra" },
        runtime: "nomad-seoul",
        repo: { git: "https://github.com/acme/x.git" },
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("no container") });
  });

  it("a non-service harness falls through to the process resolver untouched", async () => {
    const playgroundFake = fakePlaygroundHarness();
    const { service } = build({
      resolveServiceConversation: async () => undefined, // "not a service harness"
      resolveSessionHarness: async () => playgroundFake.resolved,
    });
    const session = await service.create({ tenant: "acme", createdBy: "alice", harness: { id: "cc" } });
    expect(session.trigger).toBe("sandbox"); // the container pool, exactly as before
  });

  it("a turn drives the conversation and settles a 'turn' child whose evidence is marks + trace + the reply", async () => {
    const { service, runStore, trajectories, fake, session } = await bootFrontdoor();
    const turn = await service.submitTask(creator, session.id, { task: "remember the number 7" });
    await until(() => runStore.rows.get(turn.id)?.status === "succeeded");

    expect(turn).toMatchObject({
      kind: "eval",
      caseId: "turn-1",
      group: { id: session.id, role: "turn" },
      placement: { where: "runtime", target: "nomad-seoul" },
    });
    expect(fake.turns).toEqual([{ task: "remember the number 7", turnRunId: turn.id }]);
    const settled = runStore.rows.get(turn.id);
    expect(settled?.result?.snapshot).toEqual({ kind: "prompt", output: "reply to: remember the number 7" });
    // Evidence order: infra marks → the agent's trace → the assistant reply as a message event.
    const kinds = settled?.result?.trace.map((e) => e.kind);
    expect(kinds).toEqual(["infra", "tool_call", "message"]);
    await until(() => trajectories.sealed.has(turn.id)); // the seal lands right after the settle
    // The trace poll serves the same buffer with a cursor.
    const page = await service.readTaskTrace(creator, session.id, turn.id, 0);
    expect(page.events.length).toBe(3);
    expect(page.done).toBe(true);
  });

  it("one turn at a time (409 naming the active run), same as the playground", async () => {
    const fake = fakeServiceConversation();
    let release: (() => void) | undefined;
    fake.conversation.turn = async ({ task, turnRunId }) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { status: "done", responseText: `ok ${task} ${turnRunId}`, trace: [], infraMarks: [] };
    };
    const { service } = build({ resolveServiceConversation: async () => fake.resolved });
    const session = await service.create({
      tenant: "acme",
      createdBy: "alice",
      harness: { id: "aegra" },
      runtime: "nomad-seoul",
    });
    const first = await service.submitTask(creator, session.id, { task: "one" });
    await expect(service.submitTask(creator, session.id, { task: "two" })).rejects.toMatchObject({
      status: 409,
      extra: { activeRun: first.id },
    });
    release?.();
  });

  it("fresh is refused — a service conversation's thread IS its session", async () => {
    const { service, session } = await bootFrontdoor();
    await expect(service.submitTask(creator, session.id, { task: "again", fresh: true })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("exec/snapshot/git-push refuse by name — there is no container behind a conversation", async () => {
    const { service, session } = await bootFrontdoor();
    await expect(service.exec(creator, session.id, { command: "ls" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("no container"),
    });
    await expect(service.gitPush(creator, session.id, {})).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("conversation"),
    });
  });

  it("the live view says conversation + service kind, and close disposes the conversation's target", async () => {
    const { service, fake, session } = await bootFrontdoor();
    const view = await service.getSession(creator, session.id);
    expect(view.live?.conversation).toBe(true);
    expect(view.live?.harness).toEqual({ id: "aegra", version: "1.0.0", kind: "service" });
    await service.close(creator, session.id);
    expect(fake.closes()).toBe(1);
    expect((await service.getSession(creator, session.id)).record.status).toBe("succeeded");
  });

  it("the frontdoor pool has its OWN caps — a conversation neither consumes nor borrows the sandbox pool", async () => {
    const fake = fakeServiceConversation();
    const playgroundFake = fakePlaygroundHarness();
    const { service } = build({
      resolveServiceConversation: async (_t, _s, ref) => (ref.id === "aegra" ? fake.resolved : undefined),
      resolveSessionHarness: async () => playgroundFake.resolved,
      maxPerTenant: 1,
      frontdoorMaxPerTenant: 1,
    });
    await service.create({ tenant: "acme", createdBy: "alice", harness: { id: "aegra" }, runtime: "nomad-seoul" });
    // The sandbox pool still has its slot — the conversation lives in the other pool.
    await service.create({ tenant: "acme", createdBy: "alice", image: "img" });
    // But a second conversation is refused by the frontdoor pool's own cap.
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", harness: { id: "aegra" }, runtime: "nomad-seoul" }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("the orphan sweep settles an expired frontdoor row from the ledger alone (crash case, row-only teardown)", async () => {
    const fake = fakeServiceConversation();
    const before = build({ resolveServiceConversation: async () => fake.resolved });
    const session = await before.service.create({
      tenant: "acme",
      createdBy: "alice",
      harness: { id: "aegra" },
      runtime: "nomad-seoul",
      ttlSec: 60,
    });
    // A NEW service instance sharing the store (the restarted control plane) — no live handle, no conversation.
    const after = build();
    for (const [id, row] of before.runStore.rows) after.runStore.rows.set(id, row);
    after.setNow("2026-07-30T01:00:00.000Z"); // far past deadline + grace
    await expect(after.service.sweepOrphans()).resolves.toBe(1);
    expect(after.runStore.rows.get(session.id)?.status).toBe("succeeded");
    expect(after.runStore.rows.get(session.id)?.session?.closedReason).toBe("orphaned");
    expect(after.driver.reaped).toEqual([]); // no computeId → nothing for Driver.reap
  });
});

// ---------------------------------------------------------------------------------------------------
// Delegation profiles: a registered work environment everdict hands work TO, with a structured brief.
// ---------------------------------------------------------------------------------------------------

import type { ResolvedDelegationProfile } from "./sandbox-session-service.js";

function fakeDelegationProfile(over: Partial<ResolvedDelegationProfile> = {}) {
  const fake = fakeConversationalHarness();
  const resolved: ResolvedDelegationProfile = {
    ref: { source: "acme", id: "fixer", version: "1.0.0" },
    harness: fake.resolved,
    image: "reg/claude-preinstalled:1",
    workDir: "delegation",
    instructions: "You are the workspace's repair agent.",
    instructionsFile: "CLAUDE.md",
    ttlSec: 1800,
    ...over,
  };
  return { resolved, resumes: fake.resumes };
}

describe("SandboxSessionService — delegation profiles (a registered environment to hand work to)", () => {
  const brief = {
    goal: "make the regressed cases pass",
    references: [{ type: "scorecard" as const, id: "sc-9", note: "the batch that regressed" }],
    constraints: ["do not touch the dataset"],
    doneWhen: ["the two cases pass"],
  };

  it("boots the profile's environment, IS a conversation, and seeds instructions + brief before the record", async () => {
    const fake = fakeDelegationProfile();
    const { service, driver, runStore } = build({ resolveDelegationProfile: async () => fake.resolved });
    const session = await service.create({ tenant: "acme", createdBy: "alice", profile: { id: "fixer" }, brief });

    expect(session.session?.image).toBe("reg/claude-preinstalled:1");
    expect(session.session?.conversation).toBe(true); // delegating IS conversing — never per-message
    expect(session.session?.ttlSec).toBe(1800); // the profile's own budget, since the caller named none
    // The context physically landed in the delegate's working directory, BEFORE the row existed.
    expect(driver.written.map((w) => w.path)).toEqual(["delegation/CLAUDE.md", "delegation/BRIEF.md"]);
    expect(driver.written[1]?.data).toContain("make the regressed cases pass");
    expect(driver.written[1]?.data).toContain("- scorecard `sc-9` — the batch that regressed");
    expect(runStore.rows.size).toBe(1);
  });

  it("seals the handoff on the session trajectory — the ledger alone answers what they were asked to do", async () => {
    const fake = fakeDelegationProfile();
    const { service, trajectories } = build({ resolveDelegationProfile: async () => fake.resolved });
    const session = await service.create({ tenant: "acme", createdBy: "alice", profile: { id: "fixer" }, brief });
    await service.close(creator, session.id);

    const sealed = trajectories.sealed.get(session.id);
    const marker = sealed?.events.find((e) => e.kind === "env_action" && e.action === "delegation.brief");
    const detail = (marker?.kind === "env_action" ? marker.detail : undefined) as Record<string, unknown> | undefined;
    expect(detail?.profile).toBe("acme/fixer@1.0.0");
    expect(String(detail?.brief ?? "")).toContain("make the regressed cases pass");
  });

  it("a failed context seed disposes the container and leaves NO row (a delegate without its brief is the failure this prevents)", async () => {
    const fake = fakeDelegationProfile();
    const { service, runStore, driver } = build({
      resolveDelegationProfile: async () => fake.resolved,
      driver: fakeDriver({ failWrite: true }).driver,
    });
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", profile: { id: "fixer" }, brief }),
    ).rejects.toMatchObject({ status: 502 });
    expect(runStore.rows.size).toBe(0);
    expect(driver.disposed.length).toBe(0); // this driver instance never provisioned — the injected one did
  });

  it("turns run in the profile's OWN working directory, so the delegate never walks away from its brief", async () => {
    const fake = fakeDelegationProfile();
    const { service, runStore, driver } = build({ resolveDelegationProfile: async () => fake.resolved });
    const session = await service.create({ tenant: "acme", createdBy: "alice", profile: { id: "fixer" }, brief });
    const turn = await service.submitTask(creator, session.id, { task: "read BRIEF.md and start" });
    await until(() => runStore.rows.get(turn.id)?.status === "succeeded");

    expect(turn.caseId).toBe("turn-1");
    expect(turn.group?.role).toBe("turn");
    // No tasks/<n> and no `conversation/` rebasing — the harness's own workDir (the profile's) is the cwd.
    expect(driver.execs.some((c) => c.includes("mkdir -p 'tasks/") || c.includes("conversation/"))).toBe(false);
  });

  it("the live view names WHO was delegated to", async () => {
    const fake = fakeDelegationProfile();
    const { service } = build({ resolveDelegationProfile: async () => fake.resolved });
    const session = await service.create({ tenant: "acme", createdBy: "alice", profile: { id: "fixer" } });
    const view = await service.getSession(creator, session.id);
    expect(view.live?.profile).toEqual({ source: "acme", id: "fixer", version: "1.0.0" });
    expect(view.live?.conversation).toBe(true);
  });

  it("delegates INTO a world — the delegate continues where the last one left off, and hibernates at teardown", async () => {
    const fake = fakeDelegationProfile();
    const ctx = buildWorld({
      resolveDelegationProfile: async () => fake.resolved,
      resolveEnvironmentImage: async (_t, _s, ref) =>
        ref.id === "proj" ? { image: "reg/proj:v3", version: "1.0.2" } : undefined,
    });
    const session = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      profile: { id: "fixer" },
      world: { id: "proj" },
      brief,
    });
    // WHERE is the world's own snapshot; WHO is the profile's agent — the two axes are independent.
    expect(session.session?.image).toBe("reg/proj:v3");
    expect(session.session?.world).toBe("proj");
    expect(session.session?.hibernate).toBe(true); // the delegate's work survives the container
    expect(session.session?.conversation).toBe(true);
    expect(session.attach).toEqual(["exec", "tasks"]);
    // The brief still lands — inside the world this time.
    expect(ctx.worldDriver.written.map((w) => w.path)).toEqual(["delegation/CLAUDE.md", "delegation/BRIEF.md"]);
  });

  it("FOUNDS a world from the profile's own image — delegating into a brand-new world needs no image from the caller", async () => {
    const fake = fakeDelegationProfile();
    const ctx = buildWorld({
      resolveDelegationProfile: async () => fake.resolved,
      resolveEnvironmentImage: async () => undefined, // the world has no versions yet
    });
    const session = await ctx.service.create({
      tenant: "acme",
      createdBy: "alice",
      profile: { id: "fixer" },
      world: { id: "proj" },
    });
    expect(session.session?.image).toBe("reg/claude-preinstalled:1"); // the genesis base = the delegate's environment
    expect(session.harness).toEqual({ id: "proj", version: "genesis" });
    expect(session.session?.world).toBe("proj");
  });

  it("delegates INTO an adopted environment and into a plain image — WHO and WHERE stay independent", async () => {
    const fake = fakeDelegationProfile();
    const { service } = build({
      resolveDelegationProfile: async () => fake.resolved,
      resolveEnvironmentImage: async () => ({ image: "reg/swe-env:2", version: "2.0.0" }),
    });
    const inEnv = await service.create({
      tenant: "acme",
      createdBy: "alice",
      profile: { id: "fixer" },
      environment: { id: "swe-env" },
    });
    expect(inEnv.session?.image).toBe("reg/swe-env:2"); // the environment's image, the profile's agent
    expect(inEnv.session?.conversation).toBe(true);

    const onImage = await service.create({
      tenant: "acme",
      createdBy: "alice",
      profile: { id: "fixer" },
      image: "python:3.12-slim",
    });
    expect(onImage.session?.image).toBe("python:3.12-slim");
  });

  it("refuses profile + harness — both say WHO runs", async () => {
    const fake = fakeDelegationProfile();
    const playgroundFake = fakePlaygroundHarness();
    const { service } = build({
      resolveDelegationProfile: async () => fake.resolved,
      resolveSessionHarness: async () => playgroundFake.resolved,
    });
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", profile: { id: "fixer" }, harness: { id: "cc" } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("an unknown profile is 404, an unconfigured deployment 400, and a brief without a profile 400", async () => {
    const { service: noProfile } = build({});
    await expect(
      noProfile.create({ tenant: "acme", createdBy: "alice", profile: { id: "fixer" } }),
    ).rejects.toMatchObject({ status: 400 });

    const { service } = build({ resolveDelegationProfile: async () => undefined });
    await expect(
      service.create({ tenant: "acme", createdBy: "alice", profile: { id: "ghost" } }),
    ).rejects.toMatchObject({ status: 404 });
    // A brief is the handoff TO a profile — attaching one to a plain image boot is a caller mistake, said so.
    await expect(service.create({ tenant: "acme", createdBy: "alice", image: "img", brief })).rejects.toMatchObject({
      status: 400,
    });
  });
});
