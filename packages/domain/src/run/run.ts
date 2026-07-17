import { type CaseResult, ConflictError, type EvalCase } from "@everdict/contracts";
import type { RunRecord } from "@everdict/contracts";

// The domain model for a run's lifecycle (queued → running → succeeded | failed). Wraps the persistence
// record (@everdict/db RunRecord — shapes unchanged); guard methods are the SSOT for what is legal, and
// transition methods guard then return the store patch. Illegal transitions throw from the domain.
// docs/architecture/rich-domain-core.md

// The patch a transition computes — the service persists it verbatim (store.update(id, patch)).
export type RunTransition = Partial<RunRecord>;

export interface NewQueuedRunInput {
  id: string;
  tenant: string;
  harness: { id: string; version: string };
  evalCase: EvalCase; // the (placement-injected) case body — persisted as the boot-recovery re-dispatch basis
  runtime?: string; // the placed runtime (work-queue axis); unset = default backend
  trigger?: string; // activity-view source axis (web|mcp|api…)
  submittedBy?: string; // executor stamp — notification-feed recipient
  now: string;
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
      createdAt: input.now,
      updatedAt: input.now,
    };
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
    return { status: "running", updatedAt: now };
  }

  // queued|running → succeeded (normal completion).
  succeed(result: CaseResult, now: string): RunTransition {
    this.assertNotTerminal("succeed");
    return { status: "succeeded", result, updatedAt: now };
  }

  // queued|running → failed (execution error, isolated as a run failure).
  fail(error: { code: string; message: string }, now: string): RunTransition {
    this.assertNotTerminal("fail");
    return { status: "failed", error, updatedAt: now };
  }

  // Boot-recovery adoption: settle with a result harvested from the still-alive job (zero re-run).
  adopt(result: CaseResult, now: string): RunTransition {
    if (!this.canAdopt())
      throw new ConflictError(
        "CONFLICT",
        { run: this.record.id, status: this.record.status },
        `run is already terminal (${this.record.status}) — adopt rejected`,
      );
    return { status: "succeeded", result, updatedAt: now };
  }

  // Boot-recovery re-drive: back onto the queue's running path before re-dispatch.
  redispatch(now: string): RunTransition {
    if (!this.canRedispatch())
      throw new ConflictError(
        "CONFLICT",
        { run: this.record.id, status: this.record.status },
        "run cannot be re-dispatched (terminal, or no persisted caseSpec)",
      );
    return { status: "running", updatedAt: now };
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
