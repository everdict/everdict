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
    async countActiveByEnvelope() {
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
      const created = !sealed.has(input.runId);
      if (created) sealed.set(input.runId, { meta, events: input.events });
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
    harness,
    apiKeyEnv: { ANTHROPIC_API_KEY: "sk-test" },
    ...("image" in opts ? (opts.image !== undefined ? { image: opts.image } : {}) : { image: "harness-img:1" }),
  };
  return { resolved, installs, runCwds };
}

function fakeBudget(opts: { admitError?: boolean } = {}) {
  const settles: Array<{ tenant: string; usd: number }> = [];
  let admits = 0;
  let releases = 0;
  const budget: BudgetTracker = {
    admit() {
      admits++;
      if (opts.admitError) throw new PaymentRequiredError("BUDGET_EXCEEDED", {}, "over budget");
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
    const { budget, admits } = fakeBudget({ admitError: true });
    const { service, runStore, session } = await boot({ budget });
    const before = runStore.rows.size;
    await expect(service.submitTask(creator, session.id, { task: "x" })).rejects.toMatchObject({ status: 402 });
    expect(runStore.rows.size).toBe(before);
    expect(admits()).toBe(1);
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
    expect(mine[0]?.live?.harness).toEqual({ id: "cc", version: "1.0.0" });
    expect(mine[0]?.live?.tasks[0]?.taskPreview.length).toBeLessThanOrEqual(201);
    const other = await service.listSessions({ tenant: "zeta", subject: "bob", isAdmin: false });
    expect(other).toEqual([]);
  });
});
