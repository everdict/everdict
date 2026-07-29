import { type CaseResult, ConflictError, type EvalCase } from "@everdict/contracts";
import type { PlatformFact, RunClass, RunOrigin, RunRecord } from "@everdict/contracts";

// The domain model for a run's lifecycle (queued → running → succeeded | failed). Wraps the persistence
// record (@everdict/db RunRecord — shapes unchanged); guard methods are the SSOT for what is legal, and
// transition methods guard then return the store patch. Illegal transitions throw from the domain.
// docs/architecture/rich-domain-core.md

// What a transition computes: the store patch AND the facts describing it (event-plumbing.md E0 — the fact
// is born where the legality is decided, and the store persists both in the same transaction). An empty facts
// array is normal: the taxonomy has no kind for the change, or the flood-prevention gate applies.
export interface RunTransition {
  patch: Partial<RunRecord>;
  facts: PlatformFact[];
}

export interface NewQueuedRunInput {
  id: string;
  tenant: string;
  harness: { id: string; version: string };
  evalCase: EvalCase; // the (placement-injected) case body — persisted as the boot-recovery re-dispatch basis
  runtime?: string; // the placed runtime (work-queue axis); unset = default backend
  trigger?: string; // activity-view source axis (web|mcp|api…)
  submittedBy?: string; // executor stamp — notification-feed recipient
  // The universal-run shape (execution-model.md P0). origin = structured WHY (trigger stays dual-stamped for
  // the legacy source axis); class defaults to interactive — a standalone submit is a person waiting.
  origin?: RunOrigin;
  class?: RunClass;
  now: string;
}

// The inherited emission gate, now domain law: scorecard children are represented by the batch's own facts
// (flood prevention), and — as today's notification path behaved — a terminal fact needs a known initiator.
// Widening coverage (machine-fired runs, adopted settles) is an E2 taxonomy decision, not a silent change here.
function terminalFact(record: RunRecord, status: "succeeded" | "failed"): PlatformFact[] {
  if (!record.createdBy || record.parentScorecardId) return [];
  const kind = status === "succeeded" ? ("run.completed" as const) : ("run.failed" as const);
  return [
    {
      kind,
      subject: { type: "run", id: record.id },
      actor: record.createdBy,
      recipient: record.createdBy,
      payload: {
        status,
        harness: `${record.harness.id}@${record.harness.version}`,
        caseId: record.caseId,
      },
      message: `Run ${record.id} ${status} — ${record.harness.id}@${record.harness.version} (case ${record.caseId})`,
    },
  ];
}

export class Run {
  private constructor(private readonly record: RunRecord) {}

  static from(record: RunRecord): Run {
    return new Run(record);
  }

  // The only place a queued run is assembled — submit's record literal lives here, not in the service.
  static newQueued(input: NewQueuedRunInput): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: input.harness,
      caseId: input.evalCase.id,
      status: "queued",
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      caseSpec: input.evalCase,
      // P0 stamps — say what this activation IS; enforcement arrives with the P4 gate.
      kind: "eval",
      class: input.class ?? "interactive",
      lifetime: "task",
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.runtime ? { placement: { where: "runtime" as const, target: input.runtime } } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // The facts describing a record's CREATION (nothing → queued) — the same E0 rule as transitions, for the
  // factory: standalone runs announce run.submitted; scorecard children stay silent (the batch's facts cover them).
  static creationFacts(record: RunRecord): PlatformFact[] {
    if (record.parentScorecardId) return [];
    return [
      {
        kind: "run.submitted",
        subject: { type: "run", id: record.id },
        ...(record.createdBy !== undefined ? { actor: record.createdBy, recipient: record.createdBy } : {}),
        payload: {
          status: record.status,
          harness: `${record.harness.id}@${record.harness.version}`,
          caseId: record.caseId,
        },
        message: `Run ${record.id} submitted — ${record.harness.id}@${record.harness.version} (case ${record.caseId})`,
      },
    ];
  }

  // Terminal = the record's outcome is settled; nothing may rewrite it (first terminal write wins).
  isTerminal(): boolean {
    return this.record.status === "succeeded" || this.record.status === "failed";
  }

  // Boot recovery may adopt a still-alive backend job's result only while the run is not settled.
  canAdopt(): boolean {
    return !this.isTerminal();
  }

  // Boot recovery may re-drive only runs that persisted their case body (legacy records keep the tombstone path).
  canRedispatch(): boolean {
    return !this.isTerminal() && this.record.caseSpec !== undefined;
  }

  // queued → running — compute actually began (managed: the backend dispatched it; self-hosted: a runner leased it).
  // A run is born queued (a standalone run, and now a batch child too); this is the flip that makes "waiting for a
  // runner" (queued) distinct from "executing" (running) in the runs view + work queue. Idempotent over an already
  // running record; refused once terminal (a late lease flip must never resurrect a settled run).
  start(now: string): RunTransition {
    this.assertNotTerminal("start");
    return { patch: { status: "running", updatedAt: now }, facts: [] }; // no run.started kind in the taxonomy
  }

  // queued|running → succeeded (normal completion).
  succeed(result: CaseResult, now: string): RunTransition {
    this.assertNotTerminal("succeed");
    return { patch: { status: "succeeded", result, updatedAt: now }, facts: terminalFact(this.record, "succeeded") };
  }

  // queued|running → failed (execution error, isolated as a run failure).
  fail(error: { code: string; message: string }, now: string): RunTransition {
    this.assertNotTerminal("fail");
    return { patch: { status: "failed", error, updatedAt: now }, facts: terminalFact(this.record, "failed") };
  }

  // Boot-recovery adoption: settle with a result harvested from the still-alive job (zero re-run).
  adopt(result: CaseResult, now: string): RunTransition {
    if (!this.canAdopt())
      throw new ConflictError(
        "CONFLICT",
        { run: this.record.id, status: this.record.status },
        `run is already terminal (${this.record.status}) — adopt rejected`,
      );
    // Behavior-preserving: an adopted settle emitted no fact on the old path (resume bypassed onComplete) —
    // widening that is an E2 coverage decision.
    return { patch: { status: "succeeded", result, updatedAt: now }, facts: [] };
  }

  // Boot-recovery re-drive: back onto the queue's running path before re-dispatch.
  redispatch(now: string): RunTransition {
    if (!this.canRedispatch())
      throw new ConflictError(
        "CONFLICT",
        { run: this.record.id, status: this.record.status },
        "run cannot be re-dispatched (terminal, or no persisted caseSpec)",
      );
    return { patch: { status: "running", updatedAt: now }, facts: [] };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal())
      throw new ConflictError(
        "CONFLICT",
        { run: this.record.id, status: this.record.status, transition },
        `run is already terminal (${this.record.status}) — ${transition} rejected`,
      );
  }
}
