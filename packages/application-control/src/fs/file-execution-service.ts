import { randomUUID } from "node:crypto";
import {
  AppError,
  BadRequestError,
  type ComputeHandle,
  DEFAULT_PLACEMENT_OS,
  type DomainFact,
  type Driver,
  FILE_EXECUTION_DEFAULT_TIMEOUT_SEC,
  FILE_EXECUTION_MAX_OUTPUT_CHARS,
  FILE_EXECUTION_MAX_PRODUCED_FILES,
  FILE_EXECUTION_MAX_TIMEOUT_SEC,
  FS_FILE_MAX_BYTES,
  type FileExecutionOutput,
  type FileExecutionRequest,
  type FileExecutionResult,
  type FsActor,
  NotFoundError,
  type RunEnvelope,
  type RunRecord,
  shq,
} from "@everdict/contracts";
import { Run, fileRunPlanFor } from "@everdict/domain";
import type { BudgetTracker } from "@everdict/domain";
import { admitCausedWork } from "../admission/admission.js";
import { stampFacts } from "../platform-event/outbox.js";
import type { EnvelopeStore } from "../ports/envelope-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

// The member a run belongs to. An agent's `run_file` acts AS the member that delegated it, so the row's owner
// is that member — WHOSE loop it was rides on the facts instead (`causedBy`), which is what keeps an agent
// from waking on its own file run.
function memberBehind(actor: FsActor | undefined): string {
  return actor?.onBehalfOf ?? actor?.subject ?? "system";
}

function attributedTo(facts: DomainFact[], actor: FsActor | undefined): DomainFact[] {
  if (actor?.kind !== "agent" || !actor.agentId) return facts;
  const causedBy = `agent:${actor.agentId}:${actor.conversationId ?? "unknown"}`;
  return facts.map((fact) => ({ ...fact, causedBy }));
}

// `timeout` exits 124 when it kills the command (GNU convention, and busybox follows it) — enforcing the limit
// INSIDE the sandbox makes "it ran too long" a deterministic exit code instead of a guess from wall-clock.
const TIMEOUT_EXIT_CODE = 124;
// The driver gets a slightly longer leash than the in-sandbox timeout, so the normal path is always the one that
// reports 124 rather than the driver killing the exec first.
const DRIVER_GRACE_SEC = 10;

// Run one file from the workspace filesystem and bring back what it printed and what it wrote.
//
// This is the viewer's "Run", not an eval: no harness, no grading. It does enter the run LEDGER as a `command`
// run — see openRun below for what the row keeps and what it deliberately does not. The isolation story is the
// Driver's — a container that exists for this one command and is disposed in a `finally`, whatever happened.
// The service is composed ONLY where a driver exists (`EVERDICT_FILE_EXECUTION_DRIVER`); everywhere else the
// route and the tool are simply absent, because "runs on the control-plane host" is not a fallback we offer.
export interface FileExecutionDeps {
  // WHERE the script runs. `compute` is the deployment's own; `computeFor` resolves one of the workspace's
  // registered runtimes — the same resolver agent worlds and browser sessions go through, so a member's
  // script lands inside the tenant's own trust zone instead of on the control-plane host by default.
  compute?: Driver;
  computeFor?: (tenant: string, runtime: string) => Promise<Driver | undefined>;
  // The run ledger. A file run is a `command` run: absent, the script still runs and nobody can later ask who
  // ran what, in which image, on whose cluster. Optional only so a unit test can leave it out.
  runs?: RunStore;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => number;
  // ── Admission (execution-model §5, the singular gate) ────────────────────────────────────────────────
  // A file run is compute someone pays for, so it answers the same two questions every other lane does: is
  // the tenant's budget still good for it (402), and — when an AGENT asked — is its causer's delegated
  // envelope good for it and the causal chain shallow enough (402/429)? Without this an agent could loop on
  // run_file forever: no depth guard, no envelope, spending against nobody.
  budget?: BudgetTracker;
  envelopes?: EnvelopeStore;
  admissionMaxInFlight?: number;
}

export class FileExecutionService {
  constructor(
    private readonly fs: WorkspaceFs,
    private readonly deps: FileExecutionDeps = {},
  ) {}

  private readonly newId = () => this.deps.newId?.() ?? randomUUID();
  private readonly now = () => new Date(this.deps.now?.() ?? Date.now()).toISOString();

  // A named runtime the workspace does not have is a 404 NAMING it — never a quiet fall back to the
  // deployment's compute, which would run a member's code somewhere they did not choose.
  private async computeIn(tenant: string, runtime?: string): Promise<Driver> {
    if (runtime === undefined) {
      if (!this.deps.compute)
        throw new BadRequestError(
          "BAD_REQUEST",
          {},
          "This deployment has no compute of its own — name one of the workspace's runtimes to run a file.",
        );
      return this.deps.compute;
    }
    const resolved = this.deps.computeFor ? await this.deps.computeFor(tenant, runtime) : undefined;
    if (!resolved)
      throw new NotFoundError("NOT_FOUND", { runtime }, `Runtime '${runtime}' is not registered in this workspace.`);
    return resolved;
  }

  async run(
    tenant: string,
    input: FileExecutionRequest,
    actor?: FsActor,
    // The agent's CURRENT ledger run, when an agent asked. Never client-supplied — it rides the same
    // attribution header the fs actor does, so a caller cannot name someone else's envelope to spend it.
    causedByRunId?: string,
  ): Promise<FileExecutionResult> {
    const plan = fileRunPlanFor(input.path, input.image);
    if (!plan) {
      throw new BadRequestError("BAD_REQUEST", { path: input.path }, `No interpreter for '${input.path}'.`);
    }
    const file = await this.fs.read(tenant, input.path);
    if (!file) throw new NotFoundError("NOT_FOUND", { path: input.path }, `'${input.path}' does not exist`);
    const source = decodeUtf8(file.data);
    if (source === undefined) {
      throw new BadRequestError("BAD_REQUEST", { path: input.path }, "Only a text file can be run.");
    }

    const name = input.path.split("/").at(-1) ?? input.path;
    const directory = input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "";
    const timeoutSec = Math.min(input.timeoutSec ?? FILE_EXECUTION_DEFAULT_TIMEOUT_SEC, FILE_EXECUTION_MAX_TIMEOUT_SEC);
    const command = `timeout ${timeoutSec} sh -c ${shq(plan.command)}`;

    // The gate, in §5.1 order: the causal leg first (caused work draws from its causer), then the tenant's
    // own budget. Before any compute is taken — a refusal must cost nothing. The run id is minted BEFORE the
    // gate and doubles as the admission's request identity (H6) — a re-admission of this same execution is
    // the same right, never a second charge.
    const runs = this.deps.runs;
    const execRunId = this.newId();
    const envelope =
      causedByRunId && runs
        ? await admitCausedWork(
            {
              runStore: runs,
              ...(this.deps.envelopes ? { envelopes: this.deps.envelopes } : {}),
              ...(this.deps.events ? { events: this.deps.events } : {}),
              ...(this.deps.admissionMaxInFlight !== undefined ? { maxInFlight: this.deps.admissionMaxInFlight } : {}),
            },
            tenant,
            causedByRunId,
            1,
            { requestId: `adm:file-exec:${execRunId}` },
          )
        : undefined; // no ledger composed = no causer to verify against (the composition always wires one)
    this.deps.budget?.admit(tenant); // 402 past the tenant cap — no container, no row

    const target = await this.computeIn(tenant, input.runtime);
    // The row exists BEFORE the container does. A control plane that dies mid-run then leaves a record saying
    // what was started and where — which is the only thing that makes an orphaned container findable.
    const runId = await this.openRun(
      tenant,
      {
        id: execRunId,
        path: input.path,
        image: plan.image,
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        ...(causedByRunId !== undefined ? { causedByRunId } : {}),
        ...(envelope !== undefined ? { envelope } : {}),
      },
      actor,
    );
    // Provisioning is INSIDE the guarded region: a container that never came up is exactly the case the
    // ledger exists for, and leaving that row at `running` forever would be an orphan record of its own.
    let compute: ComputeHandle | undefined;
    let startedAt = Date.now();
    try {
      // DELIBERATELY the default world: a workspace file runs in the linux interpreter image fileRunPlanFor
      // chose (python/node/sh). There is no case here to declare an os, so this is a decision rather than a
      // resolution — named, so it reads as one and greps alongside resolvePlacementOs's call sites.
      compute = await target.provision({ os: DEFAULT_PLACEMENT_OS, image: plan.image, needs: ["shell"] });
      startedAt = Date.now();
      await compute.writeFile(name, source);
      const result = await compute.exec(command, { timeoutSec: timeoutSec + DRIVER_GRACE_SEC });
      const outputs = await this.collectOutputs(compute, tenant, directory, name, actor);
      await this.settleRun(runId, result.exitCode, outputs, actor);
      return {
        path: input.path,
        image: plan.image,
        command,
        exitCode: result.exitCode,
        stdout: clamp(result.stdout),
        stderr: clamp(result.stderr),
        truncated:
          result.stdout.length > FILE_EXECUTION_MAX_OUTPUT_CHARS ||
          result.stderr.length > FILE_EXECUTION_MAX_OUTPUT_CHARS,
        timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
        durationMs: Date.now() - startedAt,
        outputs,
      };
    } catch (e) {
      // We could not run it — not "the script disagreed with us". The row says so with the reason, so a
      // sandbox that never came up is distinguishable from a test suite that legitimately exits non-zero.
      await this.failRun(runId, e, actor);
      throw e;
    } finally {
      await compute?.dispose();
    }
  }

  // ─── The run ledger ─────────────────────────────────────────────────────────────────────────────────────
  // Best-effort by contract: a ledger that is down must not turn a working "Run" into an error the member
  // cannot act on. It is loud in the log instead, which is where an operator looks for a store that is failing.

  private async openRun(
    tenant: string,
    // `id` is minted by the caller BEFORE the admission gate — it doubles as the admission request identity.
    what: { id: string; path: string; image: string; runtime?: string; causedByRunId?: string; envelope?: RunEnvelope },
    actor?: FsActor,
  ): Promise<string | undefined> {
    const runs = this.deps.runs;
    if (!runs) return undefined;
    const record = Run.newFileCommand({
      tenant,
      ...what,
      createdBy: memberBehind(actor),
      now: this.now(),
    });
    const stamped = stampFacts(tenant, attributedTo(Run.creationFacts(record), actor), {
      newId: this.newId,
      now: this.now,
    });
    try {
      await runs.create(
        record,
        stamped.map((f) => f.record),
      );
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
      return record.id;
    } catch (e) {
      console.warn(`[fs] file run ledger write failed (${record.id}):`, e);
      return undefined;
    }
  }

  private async settleRun(
    runId: string | undefined,
    exitCode: number,
    outputs: FileExecutionOutput[],
    actor?: FsActor,
  ): Promise<void> {
    await this.closeRun(runId, actor, (run, now) =>
      run.settleCommand({ exitCode, files: outputs.filter((o) => o.skipped !== true).map((o) => o.path) }, now),
    );
  }

  private async failRun(runId: string | undefined, cause: unknown, actor?: FsActor): Promise<void> {
    const error =
      cause instanceof AppError
        ? { code: cause.code, message: cause.message }
        : { code: "INTERNAL", message: cause instanceof Error ? cause.message : String(cause) };
    await this.closeRun(runId, actor, (run, now) => run.fail(error, now));
  }

  private async closeRun(
    runId: string | undefined,
    actor: FsActor | undefined,
    transition: (run: Run, now: string) => { patch: Partial<RunRecord>; facts: DomainFact[] },
  ): Promise<void> {
    const runs = this.deps.runs;
    if (!runs || runId === undefined) return;
    try {
      const record = await runs.get(runId);
      if (!record) return;
      const { patch, facts } = transition(Run.from(record), this.now());
      const stamped = stampFacts(record.tenant, attributedTo(facts, actor), {
        newId: this.newId,
        now: this.now,
      });
      const settled = await runs.update(
        runId,
        patch,
        stamped.map((f) => f.record),
        // The settle CAS (arch-review 26 P1) — the domain guard above refuses a terminal record in THIS
        // process; the row can also be settled by another one.
        { expectNonTerminal: true },
      );
      // A CAS LOSER PUBLISHES NOTHING (arch-review 27 P1). `pushPersisted` means "these events are already in
      // the ledger" — and when the guarded write matches no row, the Pg adapter inserts none. Pushing the
      // pre-stamped batch anyway announced a settlement that did not happen, to a bus whose consumers are
      // agent activations rather than a toast in a UI.
      if (settled === undefined) return;
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    } catch (e) {
      console.warn(`[fs] file run settle failed (${runId}):`, e);
    }
  }

  // Files the script left in its working directory, carried back NEXT TO the script — that is what makes a run
  // productive rather than merely observable (a chart, a converted document, a generated report). An existing
  // path is never overwritten: a run is not an edit, so a collision is reported, not resolved.
  private async collectOutputs(
    compute: ComputeHandle,
    tenant: string,
    directory: string,
    scriptName: string,
    actor?: FsActor,
  ): Promise<FileExecutionOutput[]> {
    const listing = await compute.exec("find . -type f");
    if (listing.exitCode !== 0) return [];
    const produced = listing.stdout
      .split("\n")
      .map((line) => line.trim().replace(/^\.\//, ""))
      .filter((line) => line !== "" && line !== scriptName)
      .sort()
      .slice(0, FILE_EXECUTION_MAX_PRODUCED_FILES);

    const outputs: FileExecutionOutput[] = [];
    for (const name of produced) {
      const measured = await compute.exec(`wc -c < ${shq(name)}`);
      const size = Number.parseInt(measured.stdout.trim(), 10);
      if (!Number.isFinite(size) || size > FS_FILE_MAX_BYTES) continue; // too big for the filesystem's own cap
      const target = directory === "" ? name : `${directory}/${name}`;
      const output: FileExecutionOutput = { path: target, name, size };
      // base64 so a produced PNG or spreadsheet survives the trip — `cat` would corrupt anything non-text.
      const encoded = await compute.exec(`base64 ${shq(name)}`);
      if (encoded.exitCode !== 0) continue;
      const data = new Uint8Array(Buffer.from(encoded.stdout.replace(/\s+/g, ""), "base64"));
      try {
        if (await this.fs.stat(tenant, target)) {
          outputs.push({ ...output, skipped: true });
          continue;
        }
        await this.fs.write(tenant, target, data, undefined, actor !== undefined ? { actor } : undefined);
        outputs.push(output);
      } catch {
        // An unrepresentable name (charset/depth) or a losing race — reported as skipped, never fatal to the run.
        outputs.push({ ...output, skipped: true });
      }
    }
    return outputs;
  }
}

function decodeUtf8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

function clamp(stream: string): string {
  return stream.length > FILE_EXECUTION_MAX_OUTPUT_CHARS ? stream.slice(0, FILE_EXECUTION_MAX_OUTPUT_CHARS) : stream;
}
