import {
  type AgentTaskRecord,
  type AgentTaskStatus,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@everdict/contracts";
import type { AgentTaskStore } from "../ports/agent-task-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";

// The workspace task ledger (docs/architecture/agent-teams.md; Claude Code's TaskCreate/TaskList family
// reinterpreted server-side): cross-turn, cross-agent units of intended work. Any member/agent may create,
// claim, and complete tasks (shared mutation IS the coordination); delete = creator or admin. Lifecycle FACTS
// are emitted here — the single choke point both transports call (events rule: choke points over call sites):
// task.created / task.claimed / task.completed / task.cancelled. An agent-created task stamps
// causedBy agent:<agentId>:<conversationId> so the creator never wakes on its own task (loop guard #1).

// Agent attribution when a conversation acts on the ledger (the MCP transport carries it; member HTTP calls don't).
export interface TaskAgentAttribution {
  agentId?: string;
  conversationId?: string;
}

export interface CreateTaskInput {
  tenant: string;
  createdBy: string;
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
  agent?: TaskAgentAttribution;
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  status?: AgentTaskStatus;
  owner?: string;
  blockedBy?: string[];
  // The completer's report (LESSON 059 P1) — what doing the task produced, read by whoever waits on it.
  output?: string;
}

export interface TaskServiceDeps {
  store: AgentTaskStore;
  // Best-effort by contract (never wrap it) — recording a fact must not affect the mutation it describes.
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

const MAX_BLOCKED_BY = 20;

function causedByOf(agent: TaskAgentAttribution | undefined): string | undefined {
  if (!agent?.agentId) return undefined;
  return `agent:${agent.agentId}:${agent.conversationId ?? "unknown"}`;
}

export class TaskService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: TaskServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateTaskInput): Promise<AgentTaskRecord> {
    const blockedBy = input.blockedBy ?? [];
    if (blockedBy.length > MAX_BLOCKED_BY)
      throw new BadRequestError("BAD_REQUEST", { max: MAX_BLOCKED_BY }, "Too many blockedBy dependencies.");
    const ts = this.now();
    const record: AgentTaskRecord = {
      id: this.newId(),
      tenant: input.tenant,
      subject: input.subject,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: "pending",
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      blockedBy,
      createdBy: input.createdBy,
      ...(input.agent?.agentId !== undefined || input.agent?.conversationId !== undefined
        ? {
            origin: {
              ...(input.agent.agentId !== undefined ? { agentId: input.agent.agentId } : {}),
              ...(input.agent.conversationId !== undefined ? { conversationId: input.agent.conversationId } : {}),
            },
          }
        : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    const causedBy = causedByOf(input.agent);
    void this.deps.events?.emit({
      workspace: input.tenant,
      kind: "task.created",
      subject: { type: "task", id: record.id },
      actor: input.createdBy,
      // `id` rides in the payload (not only the event subject) because trigger/wait filters match PAYLOAD
      // fields only — it is what lets a conversation park on "MY task": wait_for task.completed with
      // {field:"id", op:"eq", value:<taskId>} (LESSON 059 P1), and what tells a woken teammate WHICH task
      // to claim.
      payload: {
        id: record.id,
        subject: record.subject,
        ...(record.owner !== undefined ? { owner: record.owner } : {}),
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
      },
      ...(causedBy !== undefined ? { causedBy } : {}),
      message: `Task created: ${record.subject}`,
    });
    return record;
  }

  list(tenant: string, opts?: { status?: AgentTaskStatus; limit?: number }): Promise<AgentTaskRecord[]> {
    return this.deps.store.list(tenant, opts);
  }

  async get(tenant: string, id: string): Promise<AgentTaskRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `task '${id}' not found.`);
    return record;
  }

  // Any member/agent may update — a coordination ledger's shared mutation is its purpose. Status transitions
  // are permissive (a completed task can be reopened); the ledger records facts, readers decide ordering.
  async update(
    tenant: string,
    id: string,
    patch: UpdateTaskInput,
    actor: { subject: string; agent?: TaskAgentAttribution },
  ): Promise<AgentTaskRecord> {
    if ((patch.blockedBy?.length ?? 0) > MAX_BLOCKED_BY)
      throw new BadRequestError("BAD_REQUEST", { max: MAX_BLOCKED_BY }, "Too many blockedBy dependencies.");
    const existing = await this.get(tenant, id);
    // Claim race (LESSON 059 P1): two workers claiming the same unowned task must not BOTH believe they own
    // it — the second claimer previously re-set in_progress while the first stayed owner, and silently worked
    // a task that was not theirs. A claim of a task already in progress under someone else (with no explicit
    // owner reassignment) is refused with the current owner named, so the loser stands down and pulls other
    // work instead of double-running this one.
    if (
      patch.status === "in_progress" &&
      existing.status === "in_progress" &&
      patch.owner === undefined &&
      existing.owner !== undefined &&
      existing.owner !== actor.subject
    )
      throw new ConflictError(
        "CONFLICT",
        { id, owner: existing.owner },
        `task '${id}' is already claimed by ${existing.owner}.`,
      );
    // Claiming (→ in_progress) without naming an owner records the claimer as the owner.
    const nextOwner =
      patch.owner ?? (patch.status === "in_progress" && existing.owner === undefined ? actor.subject : undefined);
    const updated = await this.deps.store.update(tenant, id, {
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(nextOwner !== undefined ? { owner: nextOwner } : {}),
      ...(patch.blockedBy !== undefined ? { blockedBy: patch.blockedBy } : {}),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
      updatedAt: this.now(),
    });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `task '${id}' not found.`);
    // Lifecycle facts on ACTUAL transitions only (a same-status patch emits nothing).
    if (patch.status !== undefined && patch.status !== existing.status) {
      const kind =
        patch.status === "in_progress"
          ? ("task.claimed" as const)
          : patch.status === "completed"
            ? ("task.completed" as const)
            : patch.status === "cancelled"
              ? ("task.cancelled" as const)
              : undefined;
      if (kind !== undefined) {
        const causedBy = causedByOf(actor.agent);
        void this.deps.events?.emit({
          workspace: tenant,
          kind,
          subject: { type: "task", id },
          actor: actor.subject,
          // Same law as task.created: the id must be a payload field for wait/trigger filters to match it.
          payload: {
            id,
            subject: updated.subject,
            ...(updated.owner !== undefined ? { owner: updated.owner } : {}),
          },
          ...(causedBy !== undefined ? { causedBy } : {}),
          message: `Task ${patch.status === "in_progress" ? "claimed" : patch.status}: ${updated.subject}`,
        });
      }
    }
    return updated;
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const existing = await this.get(tenant, id);
    if (existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "tasks:delete" },
        "You are not allowed to delete this task (creator or workspace admin only).",
      );
    await this.deps.store.remove(tenant, id);
  }
}
