import {
  BadRequestError,
  type ComputeHandle,
  type Driver,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  type RunRecord,
  type TraceEvent,
  UpstreamError,
} from "@everdict/contracts";
import { Run } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";
import type { TrajectoryStore } from "../ports/trajectory-store.js";

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

export interface SandboxActor {
  tenant: string;
  subject: string;
  isAdmin: boolean;
}

export interface CreateSandboxInput {
  tenant: string;
  createdBy: string;
  // What to boot: an adopted environment capability (resolved to its image via the injected resolver), or
  // an ad-hoc image ref. Exactly one is required.
  environment?: { source?: string; id: string; version?: string };
  image?: string;
  ttlSec?: number;
}

interface LiveSession {
  handle: ComputeHandle;
  tenant: string;
  createdBy: string;
  expiresAtMs: number;
  trace: TraceEvent[];
  t: number; // monotonic trajectory step
  execCount: number;
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

  constructor(private readonly deps: SandboxSessionServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
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
      const record = Run.newSandboxSession({
        id: this.newId(),
        tenant: input.tenant,
        harness: resolved.harness,
        image: resolved.image,
        ttlSec,
        createdBy: input.createdBy,
        ...(handle.id !== undefined ? { computeId: handle.id } : {}),
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
        trace: [{ t: 0, kind: "env_action", action: "session.start", detail: { image: resolved.image, ttlSec } }],
        t: 1,
        execCount: 0,
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

  private async resolveTarget(
    input: CreateSandboxInput,
  ): Promise<{ image: string; harness: { id: string; version: string } }> {
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
    throw new BadRequestError("BAD_REQUEST", {}, "Either image or environment is required.");
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
