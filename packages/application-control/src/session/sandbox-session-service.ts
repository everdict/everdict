import {
  BadRequestError,
  type ComputeHandle,
  ConflictError,
  type Driver,
  type EvaluableHarness,
  ForbiddenError,
  type HarnessSpec,
  NotFoundError,
  RateLimitError,
  type RunRecord,
  type RunStatus,
  type TraceEvent,
  UpstreamError,
} from "@everdict/contracts";
import { type BudgetTracker, Run, type UsageMeter } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";
import type { TrajectoryStore } from "../ports/trajectory-store.js";
import { scopedComputeHandle } from "./scoped-compute.js";
import { SessionTaskRunner } from "./session-task-runner.js";

// Session runs (execution-model.md P6, master plan W5): "run this environment image and shell in."
// The RECORD lives on the universal Run ledger (kind "sandbox", lifetime "session" — visible in the
// activity console, settled like any run); only the live ComputeHandle stays in this process-local map
// (the BrowserSessionService split, generalized). Disposal is the invariant: the container is provisioned
// BEFORE the record exists (no orphan record on a failed provision), torn down in a `finally` on every
// close path, and the hard deadline lives ON THE ROW (`session.expiresAt`) so the durable reaper rung can
// tear down from the row alone. Every exec is appended to the session's trajectory and sealed at teardown —
// a shell session leaves evidence, not just side effects.
const DEFAULT_TTL_SEC = 900; // the browser sessions' 15m prior
const MAX_TTL_SEC = 4 * 3600;
const DEFAULT_EXEC_TIMEOUT_SEC = 60;
const MAX_EXEC_TIMEOUT_SEC = 600;
const MAX_TRACE_OUTPUT_CHARS = 20_000;
const DEFAULT_TASK_TIMEOUT_SEC = 600;
const MAX_TASK_TIMEOUT_SEC = 3600;
const TASK_PREVIEW_CHARS = 200;
const TEARDOWN_TASK_GRACE_MS = 5_000;

export interface SandboxActor {
  tenant: string;
  subject: string;
  isAdmin: boolean;
}

export interface CreateSandboxInput {
  tenant: string;
  createdBy: string;
  // What to boot: an adopted environment capability (resolved to its image via the injected resolver), an
  // ad-hoc image ref, or a HARNESS to drive test cases through (the playground). Exactly one is required.
  environment?: { source?: string; id: string; version?: string };
  image?: string;
  harness?: { id: string; version?: string; image?: string };
  ttlSec?: number;
}

// A registered harness resolved for session use — built by the composition root (registry + secrets +
// model binding + makeHarness). Secret VALUES live only here (process memory): apiKeyEnv reaches the
// container via RunContext, spec env via the harness — never a record, a trace, or a marker.
export interface ResolvedSessionHarness {
  id: string;
  version: string;
  spec?: HarnessSpec; // fully resolved ({secretRef} + model binding already substituted to strings)
  harness: EvaluableHarness;
  apiKeyEnv: Record<string, string>;
  image?: string; // the spec's image (command kind); undefined = the caller must provide harness.image
}

// One submitted test case: its child run id + the live cursor buffer the web polls. Kept until the
// session closes (short-lived by TTL); after settle the sealed trajectory serves the same events.
interface TaskEntry {
  runId: string;
  caseId: string;
  task: string;
  submittedAt: string;
  status: RunStatus;
  events: TraceEvent[];
}

interface PlaygroundState {
  resolved: ResolvedSessionHarness;
  taskSeq: number;
  tasks: TaskEntry[];
  active?: { runId: string; abort: AbortController; done: Promise<void> };
}

interface LiveSession {
  handle: ComputeHandle;
  tenant: string;
  createdBy: string;
  expiresAtMs: number;
  trace: TraceEvent[];
  t: number; // monotonic trajectory step
  execCount: number;
  playground?: PlaygroundState; // present only for harness-target sessions
}

// The reattach/monitor read model (GET /sandboxes, GET /sandboxes/:id).
export interface SandboxTaskSummary {
  runId: string;
  caseId: string;
  status: RunStatus;
  taskPreview: string;
  submittedAt: string;
  eventCount: number;
}

export interface SandboxSessionView {
  record: RunRecord;
  // Absent = not live on THIS control plane (settled, or lost to a restart — the reaper settles it).
  live?: {
    expiresAt: string;
    busy: boolean;
    harness?: { id: string; version: string };
    tasks: SandboxTaskSummary[];
  };
}

// One page of a task's live trace (the 2s poll target). `done` = terminal — stop polling; the same events
// then serve from the sealed trajectory (GET /runs/:id/trajectory).
export interface SandboxTaskTrace {
  status: RunStatus;
  events: TraceEvent[];
  nextCursor: number;
  done: boolean;
}

export interface SandboxSessionServiceDeps {
  store: RunStore;
  driver: Driver;
  trajectories?: TrajectoryStore; // sealed at teardown — the session's evidence
  events?: PlatformEventEmitter; // E0 facts ride the store writes; this is the latency nudge
  // environment ref → the concrete image + resolved version. apps/api wires the capability store + the
  // consume gate behind this; absent = ad-hoc images only (environment refs 404).
  resolveEnvironmentImage?: (
    tenant: string,
    subject: string,
    ref: { source?: string; id: string; version?: string },
  ) => Promise<{ image: string; version: string } | undefined>;
  // harness ref → a session-ready harness (registry get + secret resolution + model binding + makeHarness).
  // apps/api wires it; absent = harness sandboxes not configured (the playground 400s).
  resolveSessionHarness?: (
    tenant: string,
    subject: string,
    ref: { id: string; version?: string },
  ) => Promise<ResolvedSessionHarness | undefined>;
  budget?: BudgetTracker; // task admission (402 before a child run exists) + cost settle
  usage?: UsageMeter; // per-model metering of task cost lines (billingCharges)
  // The durable reaper (orchestration.md T-b): start reaper:<runId> at create (a deadline timer that
  // survives every process), signal it on close (prompt completion — correctness never depends on it,
  // reap skips a settled record). Absent = the in-process sweep is the only expiry (rung-1 behavior).
  reaper?: {
    start(input: { runId: string; tenant: string; expiresAt: string }): Promise<void>;
    signalClosed(runId: string): Promise<void>;
  };
  defaultTtlSec?: number;
  maxTtlSec?: number;
  maxPerTenant?: number; // undefined = unlimited (dev); production sets both
  maxTotal?: number;
  newId?: () => string;
  now?: () => string;
}

export class SandboxSessionService {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly taskRunner: SessionTaskRunner;

  constructor(private readonly deps: SandboxSessionServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.taskRunner = new SessionTaskRunner({
      store: deps.store,
      ...(deps.trajectories !== undefined ? { trajectories: deps.trajectories } : {}),
      ...(deps.events !== undefined ? { events: deps.events } : {}),
      ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
      ...(deps.usage !== undefined ? { usage: deps.usage } : {}),
      newId: this.newId,
      now: this.now,
    });
  }

  // Boot a session: capacity → resolve the image → provision → ONLY THEN the ledger record (born running,
  // run.submitted fact via the E0 outbox). The id is minted before the record so the map and the row agree.
  async create(input: CreateSandboxInput): Promise<RunRecord> {
    this.sweep();
    this.enforceCapacity(input.tenant);
    const resolved = await this.resolveTarget(input);
    const ttlSec = Math.min(input.ttlSec ?? this.deps.defaultTtlSec ?? DEFAULT_TTL_SEC, this.maxTtl());
    let handle: ComputeHandle;
    try {
      handle = await this.deps.driver.provision({ os: "linux", image: resolved.image, needs: ["shell"] });
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { image: resolved.image },
        `Could not start '${resolved.image}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      // Warm install BEFORE the record exists (the provision-before-record rule, extended): a harness whose
      // install fails leaves no row and no leaked container — the thrown error is the whole story.
      if (resolved.playground) {
        try {
          await handle.exec("mkdir -p work");
          await resolved.playground.harness.install(handle);
        } catch (err) {
          throw new UpstreamError(
            "HARNESS_INSTALL_FAILED",
            { harness: resolved.harness.id, image: resolved.image },
            `Could not install '${resolved.harness.id}' into the session: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const record = Run.newSandboxSession({
        id: this.newId(),
        tenant: input.tenant,
        harness: resolved.harness,
        image: resolved.image,
        ttlSec,
        createdBy: input.createdBy,
        ...(handle.id !== undefined ? { computeId: handle.id } : {}),
        ...(resolved.playground ? { attach: ["exec" as const, "tasks" as const] } : {}),
        now: this.now(),
      });
      const stamped = stampFacts(input.tenant, Run.creationFacts(record), { newId: this.newId, now: this.now });
      await this.deps.store.create(
        record,
        stamped.map((f) => f.record),
      );
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
      this.sessions.set(record.id, {
        handle,
        tenant: input.tenant,
        createdBy: input.createdBy,
        expiresAtMs: new Date(this.now()).getTime() + ttlSec * 1000,
        trace: [
          // M3 — the sandbox's infra-plane record: the driver container identity, so the sealed trajectory says
          // WHERE this session physically ran (the sandbox twin of the backend's placement record).
          {
            t: 0,
            kind: "infra",
            scope: "placement",
            event: "provisioned",
            message: `sandbox container${handle.id !== undefined ? ` ${handle.id}` : ""} (image ${resolved.image})`,
            ...(handle.id !== undefined ? { unit: handle.id } : {}),
            at: this.now(),
          },
          {
            t: 0,
            kind: "env_action",
            action: "session.start",
            detail: {
              image: resolved.image,
              ttlSec,
              ...(resolved.playground ? { harness: `${resolved.harness.id}@${resolved.harness.version}` } : {}),
            },
          },
        ],
        t: 1,
        execCount: 0,
        ...(resolved.playground ? { playground: { resolved: resolved.playground, taskSeq: 0, tasks: [] } } : {}),
      });
      // Durable expiry (T-b): best-effort — a Temporal outage never blocks the session (the in-process
      // sweep still bounds the TTL while this process lives).
      if (record.session !== undefined) {
        const expiresAt = record.session.expiresAt;
        void this.deps.reaper?.start({ runId: record.id, tenant: input.tenant, expiresAt }).catch(() => {});
      }
      return record;
    } catch (err) {
      await handle.dispose().catch(() => undefined); // no record → no leak either
      throw err;
    }
  }

  // Exec into the live session. Attach is not a read: creator-or-admin, checked BEFORE anything runs.
  // Every exec lands on the session's trajectory (the evidence a judge or a teammate later reads).
  async exec(
    actor: SandboxActor,
    runId: string,
    input: { command: string; timeoutSec?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can exec.");
    if (typeof input.command !== "string" || input.command.trim() === "")
      throw new BadRequestError("BAD_REQUEST", {}, "command is required.");
    const timeoutSec = Math.min(input.timeoutSec ?? DEFAULT_EXEC_TIMEOUT_SEC, MAX_EXEC_TIMEOUT_SEC);
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await live.handle.exec(input.command, { timeoutSec });
    } catch (err) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: runId },
        `exec failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const id = `exec-${++live.execCount}`;
    live.trace.push({ t: live.t++, kind: "tool_call", id, name: "exec", args: { command: input.command } });
    live.trace.push({
      t: live.t++,
      kind: "tool_result",
      id,
      ok: result.exitCode === 0,
      output: clamp(`${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`),
    });
    return result;
  }

  // Submit a test case into a live harness session (the playground). One task at a time per session: one
  // container workdir sequence, one warm toolchain — a second submit while one runs is a 409, not a queue.
  // The child run is born RUNNING on the ledger before the harness starts (its record is what the caller
  // monitors); the drive happens async — errors settle the child, never this call.
  async submitTask(
    actor: SandboxActor,
    runId: string,
    input: { task: string; timeoutSec?: number },
  ): Promise<RunRecord> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can submit tasks.");
    const playground = live.playground;
    if (!playground)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session has no harness — create it with harness:{id} to submit test cases.",
      );
    if (typeof input.task !== "string" || input.task.trim() === "")
      throw new BadRequestError("BAD_REQUEST", {}, "task is required.");
    if (playground.active)
      throw new ConflictError(
        "CONFLICT",
        { run: runId, activeRun: playground.active.runId },
        "A test case is already running in this session — wait for it to finish.",
      );
    this.deps.budget?.admit(actor.tenant); // 402 before any child record exists
    const timeoutSec = Math.min(input.timeoutSec ?? DEFAULT_TASK_TIMEOUT_SEC, MAX_TASK_TIMEOUT_SEC);
    const seq = ++playground.taskSeq;
    const caseId = `task-${seq}`;
    const id = this.newId();
    const record = Run.newSessionCase({
      id,
      tenant: actor.tenant,
      harness: { id: playground.resolved.id, version: playground.resolved.version },
      sessionRunId: runId,
      caseId,
      task: input.task,
      timeoutSec,
      createdBy: actor.subject,
      now: this.now(),
    });
    const stamped = stampFacts(actor.tenant, Run.creationFacts(record), { newId: this.newId, now: this.now });
    try {
      await this.deps.store.create(
        record,
        stamped.map((f) => f.record),
      );
    } catch (err) {
      this.deps.budget?.release(actor.tenant); // the admit reservation must not leak on a failed create
      throw err;
    }
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    const entry: TaskEntry = {
      runId: id,
      caseId,
      task: input.task,
      submittedAt: this.now(),
      status: "running",
      events: [],
    };
    playground.tasks.push(entry);
    // The session's own trajectory keeps POINTERS (task boundaries), never the events — the child run owns its trace.
    live.trace.push({ t: live.t++, kind: "env_action", action: "task.start", detail: { run: id, caseId } });
    const abort = new AbortController();
    const done = (async () => {
      const status = await this.taskRunner.drive({
        tenant: actor.tenant,
        record,
        harness: playground.resolved.harness,
        compute: scopedComputeHandle(live.handle, `tasks/${seq}`),
        apiKeyEnv: playground.resolved.apiKeyEnv,
        task: input.task,
        timeoutSec,
        events: entry.events,
        signal: abort.signal,
      });
      entry.status = status;
      live.trace.push({ t: live.t++, kind: "env_action", action: "task.end", detail: { run: id, status } });
    })()
      .catch(() => {
        entry.status = "failed";
      })
      .finally(() => {
        if (playground.active?.runId === id) playground.active = undefined;
      });
    playground.active = { runId: id, abort, done };
    return record;
  }

  // The reattach surface: every session live in THIS process for the tenant (bounded by maxTotal — no
  // pagination). Historical sessions stay on /runs.
  async listSessions(actor: SandboxActor): Promise<SandboxSessionView[]> {
    this.sweep();
    const views: SandboxSessionView[] = [];
    for (const [id, live] of this.sessions) {
      if (live.tenant !== actor.tenant) continue;
      const record = await this.deps.store.get(id);
      if (!record) continue;
      views.push({ record, live: this.liveView(live) });
    }
    return views;
  }

  // Read one session: the ledger record always answers (settled sessions included); `live` only while this
  // process holds the handle.
  async getSession(actor: SandboxActor, runId: string): Promise<SandboxSessionView> {
    this.sweep();
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== actor.tenant || record.kind !== "sandbox")
      throw new NotFoundError("NOT_FOUND", { run: runId }, "Sandbox session not found.");
    const live = this.sessions.get(runId);
    return { record, ...(live !== undefined ? { live: this.liveView(live) } : {}) };
  }

  // One page of a task's trace since a cursor (the 2s poll). Live buffer first; after settle the sealed
  // trajectory serves the SAME events (a refresh mid-completion still answers). Tenant-scoped read — the
  // same visibility as GET /runs/:id/trajectory.
  async readTaskTrace(
    actor: SandboxActor,
    sessionRunId: string,
    taskRunId: string,
    since: number,
  ): Promise<SandboxTaskTrace> {
    this.sweep();
    const live = this.sessions.get(sessionRunId);
    if (live && live.tenant === actor.tenant) {
      const entry = live.playground?.tasks.find((t) => t.runId === taskRunId);
      if (entry) {
        const events = entry.events.slice(since);
        return {
          status: entry.status,
          events,
          nextCursor: since + events.length,
          done: entry.status !== "running" && entry.status !== "queued",
        };
      }
    }
    // Sealed fallback: the child run must exist, belong to the tenant, and group to this session.
    const record = await this.deps.store.get(taskRunId);
    if (!record || record.tenant !== actor.tenant || record.group?.id !== sessionRunId)
      throw new NotFoundError("NOT_FOUND", { run: taskRunId }, "No such test case in this session.");
    const sealed = await this.deps.trajectories?.get(actor.tenant, taskRunId);
    const all = sealed?.events ?? record.result?.trace ?? [];
    const events = all.slice(since);
    return {
      status: record.status,
      events,
      nextCursor: since + events.length,
      done: Run.from(record).isTerminal(),
    };
  }

  private liveView(live: LiveSession): NonNullable<SandboxSessionView["live"]> {
    return {
      expiresAt: new Date(live.expiresAtMs).toISOString(),
      busy: live.playground?.active !== undefined,
      ...(live.playground !== undefined
        ? {
            harness: { id: live.playground.resolved.id, version: live.playground.resolved.version },
            tasks: live.playground.tasks.map((t) => ({
              runId: t.runId,
              caseId: t.caseId,
              status: t.status,
              taskPreview: t.task.length > TASK_PREVIEW_CHARS ? `${t.task.slice(0, TASK_PREVIEW_CHARS)}…` : t.task,
              submittedAt: t.submittedAt,
              eventCount: t.events.length,
            })),
          }
        : { tasks: [] }),
    };
  }

  // Member close. Idempotent over an already-settled record; a running record with NO live handle here
  // (a control-plane restart) is adopted as "orphaned" — the row settles even though the container is gone
  // from our reach (the durable reaper rung makes that teardown crash-proof).
  async close(actor: SandboxActor, runId: string): Promise<RunRecord | undefined> {
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== actor.tenant || record.kind !== "sandbox")
      throw new NotFoundError("NOT_FOUND", { run: runId }, "Sandbox session not found.");
    if (record.createdBy && record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can close it.");
    const live = this.sessions.get(runId);
    if (!live) {
      if (Run.from(record).isTerminal()) return record;
      return this.settle(runId, record.tenant, "orphaned");
    }
    return this.teardown(runId, live, "closed");
  }

  // The durable reaper's teardown (T-b, called over the internal bridge when reaper:<runId> fires). Three
  // cases: a live handle here → the normal expiry teardown; a running row with NO handle → the crash case,
  // where the ROW still remembers enough (session.computeId → Driver.reap the stray container) and the
  // ledger settles as orphaned (the in-memory trajectory died with the old process — that loss is the
  // documented rung-1 cost); an already-settled row → the timer fired a no-op (close won the race).
  async reap(tenant: string, runId: string): Promise<{ reaped: boolean }> {
    const live = this.sessions.get(runId);
    if (live && live.tenant === tenant) {
      await this.teardown(runId, live, "expired");
      return { reaped: true };
    }
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== tenant || record.kind !== "sandbox") return { reaped: false };
    if (Run.from(record).isTerminal()) return { reaped: false };
    const computeId = record.session?.computeId;
    if (computeId !== undefined && this.deps.driver.reap) await this.deps.driver.reap(computeId).catch(() => undefined);
    await this.settle(runId, tenant, "orphaned");
    return { reaped: true };
  }

  // TTL sweep — called at the top of every public method and from the composition root's interval. The
  // in-process half of "the reaper is the finally"; the Temporal reaper rung survives this process dying.
  sweep(): void {
    const nowMs = new Date(this.now()).getTime();
    for (const [id, live] of this.sessions) {
      if (live.expiresAtMs <= nowMs) void this.teardown(id, live, "expired").catch(() => undefined);
    }
  }

  liveCount(): number {
    return this.sessions.size;
  }

  private async teardown(
    runId: string,
    live: LiveSession,
    reason: "closed" | "expired",
  ): Promise<RunRecord | undefined> {
    this.sessions.delete(runId); // delete first — a concurrent close finds no handle and stays idempotent
    try {
      // A task mid-flight when the session ends: abort it and give the drive a short grace to settle the
      // child (failed{CANCELLED}) BEFORE the session seals and the container dies. If the drive is stuck on
      // an exec, the dispose below kills the container, the exec settles, and the child still settles late —
      // the grace only bounds how long teardown waits, never whether the child gets its terminal write.
      const active = live.playground?.active;
      if (active) {
        active.abort.abort();
        await Promise.race([active.done, new Promise((r) => setTimeout(r, TEARDOWN_TASK_GRACE_MS))]);
      }
      live.trace.push({ t: live.t++, kind: "env_action", action: "session.close", detail: { reason } });
      // Seal the session's trajectory (P5 discipline: evidence before anything reads it; first write wins).
      await this.deps.trajectories
        ?.seal({ runId, tenant: live.tenant, source: "run", events: live.trace })
        .catch(() => undefined);
      const settled = await this.settle(runId, live.tenant, reason);
      // Prompt reaper completion (best-effort) — a missed signal just lets the timer fire a no-op later.
      void this.deps.reaper?.signalClosed(runId).catch(() => {});
      return settled;
    } finally {
      await live.handle.dispose().catch(() => undefined); // the reaper IS the finally
    }
  }

  private async settle(
    runId: string,
    tenant: string,
    reason: "closed" | "expired" | "orphaned",
  ): Promise<RunRecord | undefined> {
    const current = await this.deps.store.get(runId);
    if (!current || Run.from(current).isTerminal()) return current;
    const transition = Run.from(current).closeSession(reason, this.now());
    const stamped = stampFacts(tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      runId,
      transition.patch,
      stamped.map((f) => f.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated ?? (await this.deps.store.get(runId));
  }

  private async resolveTarget(input: CreateSandboxInput): Promise<{
    image: string;
    harness: { id: string; version: string };
    playground?: ResolvedSessionHarness;
  }> {
    if (input.harness) {
      if (!this.deps.resolveSessionHarness)
        throw new BadRequestError("BAD_REQUEST", {}, "Harness sandboxes are not configured.");
      const resolved = await this.deps.resolveSessionHarness(input.tenant, input.createdBy, {
        id: input.harness.id,
        ...(input.harness.version !== undefined ? { version: input.harness.version } : {}),
      });
      if (!resolved)
        throw new NotFoundError("NOT_FOUND", { harness: input.harness.id }, "Harness not found in this workspace.");
      const image = resolved.image ?? input.harness.image;
      if (image === undefined || image.trim() === "")
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: input.harness.id },
          `Harness '${input.harness.id}' declares no image — provide harness.image to boot it into a session.`,
        );
      return {
        image,
        harness: { id: resolved.id, version: resolved.version },
        playground: { ...resolved, image },
      };
    }
    if (input.environment) {
      if (!this.deps.resolveEnvironmentImage)
        throw new BadRequestError("BAD_REQUEST", {}, "Environment-backed sandboxes are not configured.");
      const resolved = await this.deps.resolveEnvironmentImage(input.tenant, input.createdBy, input.environment);
      if (!resolved)
        throw new NotFoundError(
          "NOT_FOUND",
          { environment: input.environment.id },
          "Environment not found (or not consumable by this workspace).",
        );
      return { image: resolved.image, harness: { id: input.environment.id, version: resolved.version } };
    }
    if (input.image !== undefined && input.image.trim() !== "")
      return { image: input.image, harness: { id: input.image, version: "adhoc" } };
    throw new BadRequestError("BAD_REQUEST", {}, "Either image, environment, or harness is required.");
  }

  private enforceCapacity(tenant: string): void {
    if (this.deps.maxTotal !== undefined && this.sessions.size >= this.deps.maxTotal)
      throw new RateLimitError(
        "RATE_LIMITED",
        { scope: "global", limit: this.deps.maxTotal },
        "Sandbox session capacity is full — close a session or retry shortly.",
      );
    if (this.deps.maxPerTenant === undefined) return;
    let owned = 0;
    for (const live of this.sessions.values()) if (live.tenant === tenant) owned++;
    if (owned >= this.deps.maxPerTenant)
      throw new RateLimitError(
        "RATE_LIMITED",
        { scope: "tenant", limit: this.deps.maxPerTenant },
        `This workspace already has ${owned} open sandbox session(s) — close one first.`,
      );
  }

  private maxTtl(): number {
    return this.deps.maxTtlSec ?? MAX_TTL_SEC;
  }
}

function clamp(text: string): string {
  return text.length > MAX_TRACE_OUTPUT_CHARS ? `${text.slice(0, MAX_TRACE_OUTPUT_CHARS)}…[truncated]` : text;
}
