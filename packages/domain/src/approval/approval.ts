import type { ApprovalRecord, PlatformFact } from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";

// The domain model for a parked agent mutation's decision lifecycle (agent-automation A6):
// pending → approved | denied | expired, decided exactly once. Transitions return {patch, facts}
// (E0, same shape as Run/ScorecardBatch) — the approval facts are born where the legality of the
// decision is decided, and the store persists both in one transaction. Transitions must never be
// spread — always use .patch.
export interface ApprovalTransition {
  patch: Partial<ApprovalRecord>;
  facts: PlatformFact[];
}

export interface NewPendingApprovalInput {
  id: string;
  tenant: string;
  sessionId: string;
  agentId?: string;
  requestId: string;
  request: { name: string; input?: unknown };
  expiresAt: string; // the days-long wait bound (the approval workflow enforces it)
  now: string;
}

function approvalLabel(record: ApprovalRecord): string {
  return `${record.request.name} (session ${record.sessionId})`;
}

export class Approval {
  private constructor(private readonly record: ApprovalRecord) {}

  static from(record: ApprovalRecord): Approval {
    return new Approval(record);
  }

  // The only place a pending approval is assembled — the park's record literal lives here, not in the service.
  static newPending(input: NewPendingApprovalInput): ApprovalRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      sessionId: input.sessionId,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      requestId: input.requestId,
      request: input.request,
      status: "pending",
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // The creation fact — a parked ask is workspace-visible from birth (the fleet/bell surface it).
  static creationFacts(record: ApprovalRecord): PlatformFact[] {
    return [
      {
        kind: "approval.requested",
        subject: { type: "approval", id: record.id },
        ...(record.agentId !== undefined ? { actor: record.agentId } : {}),
        payload: {
          tool: record.request.name,
          sessionId: record.sessionId,
          ...(record.agentId !== undefined ? { agentId: record.agentId } : {}),
          expiresAt: record.expiresAt,
        },
        message: `Agent approval requested — ${approvalLabel(record)}`,
      },
    ];
  }

  isPending(): boolean {
    return this.record.status === "pending";
  }

  // pending → approved | denied — decided exactly once (a second decision, or deciding an expired ask, is a
  // clean 409; the first terminal write wins, so a race between a member and the expiry timer never flaps).
  decide(decision: "approve" | "deny", by: { actor?: string }, now: string): ApprovalTransition {
    this.assertPending(decision);
    const status = decision === "approve" ? ("approved" as const) : ("denied" as const);
    return {
      patch: {
        status,
        ...(by.actor !== undefined ? { decidedBy: by.actor } : {}),
        decidedAt: now,
        updatedAt: now,
      },
      facts: [
        {
          kind: "approval.decided",
          subject: { type: "approval", id: this.record.id },
          ...(by.actor !== undefined ? { actor: by.actor } : {}),
          payload: { decision: status, tool: this.record.request.name, sessionId: this.record.sessionId },
          message: `Agent approval ${status} — ${approvalLabel(this.record)}`,
        },
      ],
    };
  }

  // pending → expired — the workflow's deny-on-expiry (T-a: done = approved | denied | expired).
  expire(now: string): ApprovalTransition {
    this.assertPending("expire");
    return {
      patch: { status: "expired", decidedAt: now, updatedAt: now },
      facts: [
        {
          kind: "approval.decided",
          subject: { type: "approval", id: this.record.id },
          payload: { decision: "expired", tool: this.record.request.name, sessionId: this.record.sessionId },
          message: `Agent approval expired — ${approvalLabel(this.record)}`,
        },
      ],
    };
  }

  private assertPending(transition: string): void {
    if (!this.isPending())
      throw new ConflictError(
        "CONFLICT",
        { approval: this.record.id, status: this.record.status },
        `approval already settled (${this.record.status}) — ${transition} rejected`,
      );
  }
}
