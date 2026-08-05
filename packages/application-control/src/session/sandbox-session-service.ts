import {
  BadRequestError,
  type ComputeHandle,
  ConflictError,
  type Driver,
  type EvaluableHarness,
  ForbiddenError,
  GIT_MACHINE_IDENTITY,
  type HarnessSpec,
  IMAGE_GRANT_USERNAME,
  NotFoundError,
  RateLimitError,
  type RegistryAuth,
  type RunRecord,
  type RunStatus,
  type TraceEvent,
  UpstreamError,
  gitAuthEnv,
  shq,
} from "@everdict/contracts";
import { type BudgetTracker, IMAGE_REPOSITORY_NAME, Run, type UsageMeter, pinDigest } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";
import type { TrajectoryStore } from "../ports/trajectory-store.js";
import type { WorkspaceImages } from "../ports/workspace-images.js";
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
// The working directory a session's repository lands in — the same `work` every harness and grader already
// assumes, so a cloned session and an eval case agree on where "the code" is.
const DEFAULT_REPO_DIR = "work";
const GIT_TIMEOUT_SEC = 600; // a clone/push of a real repository is minutes, not the 60s exec default

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
  // Agent worlds (W1): open the session AS a world — boot the world's latest snapshot (its environment
  // capability), or found the world from `image` when it has no versions yet (the genesis base). The world
  // id doubles as the snapshot repository name, so it must be a valid single-segment repository.
  world?: { id: string };
  // Auto-snapshot at teardown (close and expiry both) — defaults ON for world sessions: an expiring world
  // session HIBERNATES instead of losing its filesystem. Meaningless without `world`.
  hibernate?: boolean;
  // Agent worlds (W2): clone a repository into the session before it is handed over. A private repo resolves a
  // read credential through the injected git seam; a public one clones anonymously. Combines with any target.
  repo?: { git: string; ref?: string; dir?: string };
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
  // What the browse row calls this session's evidence — the environment the member asked for. Kept here
  // because the seal happens at teardown, long after the request that knew it.
  label: string;
  expiresAtMs: number;
  trace: TraceEvent[];
  t: number; // monotonic trajectory step
  execCount: number;
  world?: string; // agent worlds (W1): the environment capability this session snapshots into
  hibernate: boolean; // auto-snapshot at teardown (world sessions default true)
  repo?: { git: string; ref?: string; dir: string }; // W2: what was cloned in, and where
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

// What a snapshot published, and what retention removed to make room for it (W3). `prunedVersions` is
// present only when something was actually dropped — a caller reporting a bound must be able to name it.
export interface WorldSnapshotResult {
  world: string;
  version: string;
  image: string;
  prunedVersions?: string[];
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
  // `extend` re-arms the deadline on touch (W1) — optional and best-effort like the other two.
  reaper?: {
    start(input: { runId: string; tenant: string; expiresAt: string }): Promise<void>;
    signalClosed(runId: string): Promise<void>;
    extend?(input: { runId: string; tenant: string; expiresAt: string }): Promise<void>;
  };
  // Agent worlds (W1): the managed image store the snapshots publish into, and the closure that registers a
  // pushed snapshot as an environment-capability version (apps/api wires CapabilityService behind it — the
  // same injected-closure seam as resolveEnvironmentImage). Either absent = world sessions 400 at create.
  images?: Pick<WorkspaceImages, "endpoint" | "namespaceFor" | "listTags" | "inspect" | "mintPushGrant">;
  // Pull credentials for the image this session boots — the SAME seam the dispatch lane uses
  // (`buildImagePullAuths`: managed grants + BYO registries). Without it a session cannot boot an image from
  // our own registry, which is every world snapshot and every managed-store environment. Best-effort by
  // contract: no credential just means the pull is anonymous, and the registry says what it thinks of that.
  resolvePullAuths?: (tenant: string, imageRefs: string[]) => Promise<RegistryAuth[]>;
  // Agent worlds (W2): the workspace's git access, injected as a seam (apps/api binds the GitHub App service
  // behind it — peer services never call each other). Read and write are SEPARATE calls on purpose: a session
  // clones with a read credential and holds nothing, and a push mints a write credential at the moment of the
  // push. Nothing here is ever stored on the session — a token that outlives its command is a token that
  // travels inside a snapshot.
  git?: {
    // Read credential for a clone. `undefined` = no installation covers this repo → clone anonymously (a
    // public repo still works; a private one fails at git with the remote's own message).
    readToken(tenant: string, gitUrl: string): Promise<string | undefined>;
    // Write credential for a push, minted per call. Throws when no installation covers the repo.
    writeToken(tenant: string, gitUrl: string): Promise<string>;
    openPullRequest(
      tenant: string,
      gitUrl: string,
      input: { branch: string; title: string; body?: string },
    ): Promise<{ url: string; base: string }>;
  };
  publishWorldVersion?: (
    tenant: string,
    actor: { subject: string; isAdmin: boolean },
    world: string,
    input: { image: string; sessionRunId: string; name?: string; description?: string; instructions?: string },
  ) => Promise<{ version: string }>;
  // Retention (W3): drop the world's oldest snapshots past the operator's bound, image bytes included. A world
  // gains a version per hibernate and the registry has no GC, so autonomy without this is a disk that fills.
  // Best-effort AFTER a successful publish: pruning failure never fails the snapshot the caller is waiting on.
  pruneWorldVersions?: (
    tenant: string,
    actor: { subject: string; isAdmin: boolean },
    world: string,
  ) => Promise<{ prunedVersions: string[] }>;
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
    const registryAuths = await this.deps
      .resolvePullAuths?.(input.tenant, [resolved.image])
      .catch(() => [] as RegistryAuth[]);
    let handle: ComputeHandle;
    try {
      handle = await this.deps.driver.provision({
        os: "linux",
        image: resolved.image,
        needs: ["shell"],
        ...(registryAuths !== undefined && registryAuths.length > 0 ? { registryAuths } : {}),
      });
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
      // Clone BEFORE the record too, and for the same reason: a session handed over without the repo it was
      // asked for is a lie the member would only discover by looking.
      const repo = input.repo !== undefined ? await this.cloneRepo(input.tenant, handle, input.repo) : undefined;
      const hibernate = resolved.world !== undefined ? (input.hibernate ?? true) : false;
      const record = Run.newSandboxSession({
        id: this.newId(),
        tenant: input.tenant,
        harness: resolved.harness,
        image: resolved.image,
        ttlSec,
        createdBy: input.createdBy,
        ...(handle.id !== undefined ? { computeId: handle.id } : {}),
        ...(resolved.world !== undefined ? { world: resolved.world, hibernate } : {}),
        ...(repo !== undefined ? { repo } : {}),
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
        label: record.harness.id,
        ...(resolved.world !== undefined ? { world: resolved.world } : {}),
        hibernate,
        ...(repo !== undefined ? { repo } : {}),
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
              ...(resolved.world !== undefined ? { world: resolved.world } : {}),
              ...(repo !== undefined ? { repo: repo.git, dir: repo.dir } : {}),
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

  // Agent worlds (W1): publish this session's filesystem as the world's next snapshot — an image in the
  // managed store plus a new environment-capability version pinned to its digest. Creator-or-admin; refused
  // while a playground task runs (a mid-task capture is a half-written world, a foot-gun not a feature).
  async snapshot(
    actor: SandboxActor,
    runId: string,
    input: { name?: string; description?: string; instructions?: string } = {},
  ): Promise<WorldSnapshotResult> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can snapshot.");
    if (live.playground?.active)
      throw new ConflictError(
        "CONFLICT",
        { run: runId, activeRun: live.playground.active.runId },
        "A test case is running in this session — snapshot after it finishes.",
      );
    return this.snapshotLive(runId, live, { subject: actor.subject, isAdmin: actor.isAdmin }, input);
  }

  // Agent worlds (W2): push the session's working tree to its remote, optionally opening a pull request.
  // The credential is minted HERE, used for this one command, and discarded — it is never stored on the
  // session and never enters an image. Committing stays the caller's job through exec (it needs no
  // credential); the one thing a container cannot do for itself is authenticate.
  async gitPush(
    actor: SandboxActor,
    runId: string,
    input: { dir?: string; branch?: string; remote?: string; pullRequest?: { title: string; body?: string } },
  ): Promise<{ branch: string; remote: string; pushed: string; pullRequest?: { url: string; base: string } }> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can push.");
    const git = this.deps.git;
    if (!git) throw new BadRequestError("BAD_REQUEST", {}, "Git access is not configured for this deployment.");
    const dir = input.dir ?? live.repo?.dir ?? DEFAULT_REPO_DIR;
    const remote = input.remote ?? "origin";
    // The remote URL comes from the CONTAINER, not from the create-time record: the working tree is the truth
    // about what is being pushed, and a session may have cloned or re-pointed a second repo through exec.
    const remoteUrl = (await live.handle.exec(`git remote get-url ${shq(remote)}`, { cwd: dir })).stdout.trim();
    if (remoteUrl === "")
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId, dir, remote },
        `No git remote '${remote}' in '${dir}' — clone a repository into the session first.`,
      );
    const branch =
      input.branch ?? (await live.handle.exec("git rev-parse --abbrev-ref HEAD", { cwd: dir })).stdout.trim();
    if (branch === "" || branch === "HEAD")
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId, dir },
        "The working tree is on no branch (detached HEAD) — name a branch to push.",
      );
    const token = await git.writeToken(actor.tenant, remoteUrl);
    const push = await live.handle.exec(`git push ${shq(remote)} HEAD:refs/heads/${shq(branch)}`, {
      cwd: dir,
      env: gitAuthEnv(token),
      timeoutSec: GIT_TIMEOUT_SEC,
    });
    if (push.exitCode !== 0)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: runId, branch },
        `git push failed: ${clamp(push.stderr || push.stdout)}`,
      );
    const pullRequest = input.pullRequest
      ? await git.openPullRequest(actor.tenant, remoteUrl, { branch, ...input.pullRequest })
      : undefined;
    // Evidence, never the credential: what was pushed and where, on the session's own trajectory.
    live.trace.push({
      t: live.t++,
      kind: "env_action",
      action: "git.push",
      detail: { remote: remoteUrl, branch, ...(pullRequest ? { pullRequest: pullRequest.url } : {}) },
    });
    return {
      branch,
      remote: remoteUrl,
      pushed: push.stderr.trim() || push.stdout.trim(),
      ...(pullRequest !== undefined ? { pullRequest } : {}),
    };
  }

  // Keep-alive (touch): push the session's hard deadline out to now+ttl (never in — extendSession's max
  // rule), in all three places it lives: process memory, the row, and the durable reaper's timer.
  async touch(actor: SandboxActor, runId: string, input: { ttlSec?: number } = {}): Promise<{ expiresAt: string }> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can touch it.");
    const ttlSec = Math.min(input.ttlSec ?? this.deps.defaultTtlSec ?? DEFAULT_TTL_SEC, this.maxTtl());
    live.expiresAtMs = Math.max(live.expiresAtMs, new Date(this.now()).getTime() + ttlSec * 1000);
    let expiresAt = new Date(live.expiresAtMs).toISOString();
    const current = await this.deps.store.get(runId);
    if (current) {
      const transition = Run.from(current).extendSession(ttlSec, this.now());
      await this.deps.store.update(runId, transition.patch, []);
      const patched = transition.patch.session;
      if (patched?.expiresAt !== undefined) expiresAt = patched.expiresAt;
    }
    // Re-arm the durable deadline — best-effort like start/signalClosed. A missed extend leaves the OLD
    // timer armed; reap() guards against exactly that by re-checking the authoritative deadline before
    // tearing anything down, so a stale timer fires a no-op, never an early teardown.
    void this.deps.reaper?.extend?.({ runId, tenant: live.tenant, expiresAt }).catch(() => {});
    live.trace.push({ t: live.t++, kind: "env_action", action: "session.touch", detail: { ttlSec, expiresAt } });
    return { expiresAt };
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
  // from our reach (the durable reaper rung makes that teardown crash-proof). `snapshot` overrides the
  // session's hibernate default for THIS teardown (close-without-saving, or save-a-non-hibernate-session).
  async close(actor: SandboxActor, runId: string, input: { snapshot?: boolean } = {}): Promise<RunRecord | undefined> {
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
    return this.teardown(runId, live, "closed", input);
  }

  // The durable reaper's teardown (T-b, called over the internal bridge when reaper:<runId> fires). Three
  // cases: a live handle here → the normal expiry teardown; a running row with NO handle → the crash case,
  // where the ROW still remembers enough (session.computeId → Driver.reap the stray container) and the
  // ledger settles as orphaned (the in-memory trajectory died with the old process — that loss is the
  // documented rung-1 cost); an already-settled row → the timer fired a no-op (close won the race).
  async reap(tenant: string, runId: string): Promise<{ reaped: boolean }> {
    const nowMs = new Date(this.now()).getTime();
    const live = this.sessions.get(runId);
    if (live && live.tenant === tenant) {
      // A touched session outlives the timer armed before the touch (extend is best-effort) — the deadline
      // HERE is authoritative, so a stale timer fires a no-op instead of tearing down live work.
      if (live.expiresAtMs > nowMs) return { reaped: false };
      await this.teardown(runId, live, "expired");
      return { reaped: true };
    }
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== tenant || record.kind !== "sandbox") return { reaped: false };
    if (Run.from(record).isTerminal()) return { reaped: false };
    // Same stale-timer guard for the crash case — the row's deadline was touched too (extendSession).
    const rowExpiry = record.session?.expiresAt;
    if (rowExpiry !== undefined && new Date(rowExpiry).getTime() > nowMs) return { reaped: false };
    const computeId = record.session?.computeId;
    // Crash-path hibernate (W1): the row remembers enough (world + hibernate + computeId + creator) to
    // capture the orphan's filesystem BEFORE removing it — a control plane dying with the live handle no
    // longer costs the world its state. Best-effort: a snapshot failure still reaps (the leak would be worse).
    if (
      computeId !== undefined &&
      record.createdBy !== undefined &&
      record.session?.world !== undefined &&
      record.session.hibernate === true
    ) {
      await this.publishSnapshot({
        tenant,
        runId,
        world: record.session.world,
        computeId,
        actor: { subject: record.createdBy, isAdmin: false },
      }).catch(() => undefined);
    }
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

  // Clone a repository into a fresh session (W2). A read credential is resolved through the git seam and
  // reaches git through the environment only (never argv, never `.git/config` — a token written into the
  // clone's config would travel inside every later snapshot of this world). Full clone, not depth-1: this
  // tree is meant to be worked in and pushed from, and a shallow tree cannot do either well.
  private async cloneRepo(
    tenant: string,
    handle: ComputeHandle,
    repo: { git: string; ref?: string; dir?: string },
  ): Promise<{ git: string; ref?: string; dir: string }> {
    const dir = repo.dir ?? DEFAULT_REPO_DIR;
    const token = await this.deps.git?.readToken(tenant, repo.git).catch(() => undefined);
    const env = token !== undefined ? gitAuthEnv(token) : {};
    const fail = (step: string, result: { stdout: string; stderr: string }): never => {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { repo: repo.git, step },
        `Could not ${step} '${repo.git}': ${clamp(result.stderr || result.stdout)}`,
      );
    };
    const cloned = await handle.exec(`rm -rf ${shq(dir)} && git clone ${shq(repo.git)} ${shq(dir)}`, {
      env,
      timeoutSec: GIT_TIMEOUT_SEC,
    });
    if (cloned.exitCode !== 0) fail("clone", cloned);
    if (repo.ref !== undefined) {
      const checkout = await handle.exec(`git checkout ${shq(repo.ref)}`, {
        cwd: dir,
        env,
        timeoutSec: GIT_TIMEOUT_SEC,
      });
      if (checkout.exitCode !== 0) fail(`check out '${repo.ref}' in`, checkout);
    }
    // A committer identity, so `git commit` inside the session works without the caller discovering it doesn't.
    await handle
      .exec(
        `git config user.email ${shq(GIT_MACHINE_IDENTITY.email)} && git config user.name ${shq(GIT_MACHINE_IDENTITY.name)}`,
        { cwd: dir },
      )
      .catch(() => undefined);
    return { git: repo.git, ...(repo.ref !== undefined ? { ref: repo.ref } : {}), dir };
  }

  // The live-session snapshot path: the core publisher plus the trajectory record (the sealed evidence of
  // what this shell published).
  private async snapshotLive(
    runId: string,
    live: LiveSession,
    actor: { subject: string; isAdmin: boolean },
    input: { name?: string; description?: string; instructions?: string },
  ): Promise<WorldSnapshotResult> {
    const world = live.world;
    if (world === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session has no world — create it with world:{id} to snapshot.",
      );
    const computeId = live.handle.id;
    if (computeId === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session's driver exposes no compute identity — snapshots need one.",
      );
    const result = await this.publishSnapshot({ tenant: live.tenant, runId, world, computeId, actor, ...input });
    live.trace.push({ t: live.t++, kind: "env_action", action: "session.snapshot", detail: { ...result } });
    return result;
  }

  // The snapshot core (live and crash paths share it): mint the next v<n> tag → commit+push HOST-side with
  // a transient grant (the credential never enters the container, so it can never be captured INTO the
  // snapshot) → read the digest back from the registry (authoritative — what it actually stored) → publish
  // the environment-capability version → append the snapshot to the session row with its fact.
  private async publishSnapshot(input: {
    tenant: string;
    runId: string;
    world: string;
    computeId: string;
    actor: { subject: string; isAdmin: boolean };
    name?: string;
    description?: string;
    instructions?: string;
  }): Promise<WorldSnapshotResult> {
    const images = this.deps.images;
    const publish = this.deps.publishWorldVersion;
    const snapshot = this.deps.driver.snapshot?.bind(this.deps.driver);
    if (!images || !publish || !snapshot)
      throw new BadRequestError("BAD_REQUEST", {}, "World snapshots are not configured.");
    const tags = await images.listTags(input.tenant, input.world).catch(() => [] as string[]);
    let next = 1;
    for (const tag of tags) {
      const m = /^v(\d+)$/.exec(tag);
      if (m) next = Math.max(next, Number(m[1]) + 1);
    }
    const tag = `v${next}`;
    const ref = `${images.endpoint}/${images.namespaceFor(input.tenant)}/${input.world}:${tag}`;
    const grant = await images.mintPushGrant(input.tenant, input.world);
    await snapshot(input.computeId, ref, {
      host: grant.endpoint,
      username: IMAGE_GRANT_USERNAME,
      password: grant.token,
    });
    // Pin the digest WITH the tag (pinDigest) so a human still reads a version off the ref. No digest →
    // the tag ref stands and the capability publish itself warns mutable-tag.
    const digest = await images
      .inspect(input.tenant, input.world, tag)
      .then((i) => i.digest)
      .catch(() => undefined);
    const image = digest !== undefined ? pinDigest(ref, digest) : ref;
    const published = await publish(input.tenant, input.actor, input.world, {
      image,
      sessionRunId: input.runId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    });
    const current = await this.deps.store.get(input.runId);
    if (current && !Run.from(current).isTerminal()) {
      const transition = Run.from(current).recordSnapshot({
        world: input.world,
        version: published.version,
        image,
        now: this.now(),
      });
      const stamped = stampFacts(input.tenant, transition.facts, { newId: this.newId, now: this.now });
      await this.deps.store.update(
        input.runId,
        transition.patch,
        stamped.map((f) => f.record),
      );
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    }
    // Retention runs AFTER the publish and never blocks it: the snapshot the caller asked for already
    // exists, and a registry that refuses a delete must not turn that success into a failure. What it
    // removed is reported, not swallowed — a bound that silently eats versions is indistinguishable from
    // data loss (no silent caps).
    const pruned = await this.deps.pruneWorldVersions?.(input.tenant, input.actor, input.world).catch(() => undefined);
    return {
      world: input.world,
      version: published.version,
      image,
      ...(pruned !== undefined && pruned.prunedVersions.length > 0 ? { prunedVersions: pruned.prunedVersions } : {}),
    };
  }

  private async teardown(
    runId: string,
    live: LiveSession,
    reason: "closed" | "expired",
    opts?: { snapshot?: boolean },
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
      // Hibernate (agent worlds W1): a world session's teardown captures the filesystem BEFORE the container
      // dies — expiry stops meaning loss. A failure never blocks teardown (the trajectory records it; the
      // world simply gains no new version this time).
      const wantSnapshot = live.world !== undefined && (opts?.snapshot ?? live.hibernate);
      if (wantSnapshot) {
        await this.snapshotLive(runId, live, { subject: live.createdBy, isAdmin: false }, {}).catch((err) => {
          live.trace.push({
            t: live.t++,
            kind: "env_action",
            action: "session.snapshot_failed",
            detail: { message: err instanceof Error ? err.message : String(err) },
          });
        });
      }
      live.trace.push({ t: live.t++, kind: "env_action", action: "session.close", detail: { reason } });
      // Seal the session's trajectory (P5 discipline: evidence before anything reads it; first write wins).
      await this.deps.trajectories
        // A shell session is personal work (`runAudience`), so its record is the member's — the browse ledger
        // must not hand one member's terminal history to the workspace.
        ?.seal({
          runId,
          tenant: live.tenant,
          source: "run",
          events: live.trace,
          owner: live.createdBy,
          // What the browse row calls it: a shell session, named by the environment the member asked for.
          kind: "sandbox",
          label: live.label,
        })
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
    world?: string;
  }> {
    if (input.world) {
      // A world session is snapshot-bound by definition — refuse at CREATE when the deployment cannot
      // snapshot, not at the first snapshot hours of work later.
      if (input.harness)
        throw new BadRequestError("BAD_REQUEST", {}, "world and harness are mutually exclusive on one session.");
      if (!this.deps.images || !this.deps.publishWorldVersion || this.deps.driver.snapshot === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          {},
          "World sessions are not configured (a managed image store and a snapshot-capable driver are required).",
        );
      const world = input.world.id;
      // The world id doubles as its snapshot repository — the managed store's single-segment rule applies.
      if (!IMAGE_REPOSITORY_NAME.test(world))
        throw new BadRequestError(
          "BAD_REQUEST",
          { world },
          `world '${world}' is not a usable repository name — lowercase letters, digits, '.', '_', '-'.`,
        );
      // Boot the world's latest snapshot when it exists; otherwise `image` is the genesis base it is
      // founded from. The environment resolver goes through the same consume gate as any capability boot.
      if (this.deps.resolveEnvironmentImage) {
        const resolved = await this.deps.resolveEnvironmentImage(input.tenant, input.createdBy, { id: world });
        if (resolved) return { image: resolved.image, harness: { id: world, version: resolved.version }, world };
      }
      if (input.image !== undefined && input.image.trim() !== "")
        return { image: input.image, harness: { id: world, version: "genesis" }, world };
      throw new NotFoundError(
        "NOT_FOUND",
        { world },
        "World not found — provide image to found it (the genesis base this session starts from).",
      );
    }
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
