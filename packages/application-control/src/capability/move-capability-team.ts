import { ConflictError, NotFoundError, type PlatformEventKind } from "@everdict/contracts";
import { type Action, type Principal, authorize } from "@everdict/domain";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";

// Transferring a capability to another team — the write half of the team axis, shared by every versioned
// capability and by both transports.
//
// Ownership was settled at CREATION and then frozen: `teamForNew` picked the team, and nothing could ever change
// it again. That is not a real workspace. Teams split, work is handed over, and something filed under the wrong
// team on a Tuesday stayed there forever — visible to the wrong people (a private team hides its work) and
// editable by the wrong people (the roster decides writes). So the transfer is its own act, with its own gate.
//
// Two teams are involved and BOTH are authorized, which is the point that makes this safe:
//   · the SOURCE — you may only move what you were already allowed to change, or moving something out of a team
//     you are not on would be a way to take it.
//   · the DESTINATION — you may only move it onto a team you are on, or this becomes a way to push work into
//     other teams' hands (and, if that team is private, out of your own sight).
// An admin passes both (they govern every team, the same bypass `canReachTeam` already grants), and an UNOWNED
// entity has no source to authorize — the workspace's own things are anyone's to file.
//
// The registry surface this needs, structurally: dataset / judge / harness-instance / harness-template all
// satisfy it, and nothing here knows which one it is holding.
export interface TeamTransferableRegistry {
  // The tenant's OWN live versions (no `_shared` fallback) — empty means "this workspace has no such entity",
  // which is how a first-party shared asset gets refused without a separate check.
  ownVersions(tenant: string, id: string): Promise<string[]>;
  teamOfVersion?(tenant: string, id: string, version: string): string | undefined | Promise<string | undefined>;
  moveToTeam(tenant: string, id: string, teamId: string): Promise<void>;
}

// What kind of thing is moving — decides the error wording, the fact's kind, and the subject type a consumer
// filters on. A harness TEMPLATE is a harness in the event vocabulary (one kind per noun family) but its own
// subject type, because "the shape moved" and "the harness moved" are different things to watch.
export interface TransferableCapability {
  label: string; // human-facing entity name for errors ("Dataset", "Harness template")
  kind: Extract<PlatformEventKind, "harness.moved" | "dataset.moved" | "judge.moved">;
  subjectType: "harness" | "harness_template" | "dataset" | "judge";
  // The entity's EXISTING content-mutation action — a transfer is not a new permission (same discipline as
  // version tags): whoever may change this thing may also re-file it.
  action: Action;
}

// The four transferable capabilities, declared once so both transports name the same action and emit the same
// fact — a per-route literal is how the HTTP and MCP answers drift apart.
export const TEAM_TRANSFERABLE_CAPABILITIES = {
  harness: { label: "Harness", kind: "harness.moved", subjectType: "harness", action: "harnesses:register" },
  harnessTemplate: {
    label: "Harness template",
    kind: "harness.moved",
    subjectType: "harness_template",
    action: "templates:write",
  },
  dataset: { label: "Dataset", kind: "dataset.moved", subjectType: "dataset", action: "datasets:write" },
  judge: { label: "Judge", kind: "judge.moved", subjectType: "judge", action: "judges:write" },
} as const satisfies Record<string, TransferableCapability>;

export interface MoveCapabilityInput {
  registry: TeamTransferableRegistry;
  capability: TransferableCapability;
  principal: Principal;
  id: string;
  // The destination team, ALREADY resolved to an id. Transports accept a key (`ENG`) and resolve it at the
  // boundary (`resolveTeamRef` / `resolveTeam`), so an unknown team is a 404 before any of this runs — and the
  // gate below compares ids against ids, never a key against a principal's id list.
  teamId: string;
  events?: PlatformEventEmitter;
  // The agent that acted, stamped onto the fact as `agent:<id>:<conversation>` — loop guard #1 keys on that
  // prefix, so an agent never wakes on the transfer it performed itself.
  agent?: { agentId?: string; conversationId?: string };
}

export interface CapabilityMoved {
  workspace: string;
  id: string;
  teamId: string;
  previousTeamId?: string;
}

// The owning team is read off the entity's NEWEST own version — ownership belongs to the thing rather than to
// one release of it, which is exactly why the transfer moves every version at once.
export async function moveCapabilityToTeam(input: MoveCapabilityInput): Promise<CapabilityMoved> {
  const { registry, capability, principal, id, teamId } = input;
  const tenant = principal.workspace;

  // Own live versions only. An id this workspace does not own (a `_shared` benchmark, another workspace's, or
  // one whose every version is a tombstone) is answered 404 — the same no-existence-leak answer every other
  // scoped read gives, and the reason a first-party asset needs no separate refusal.
  const versions = await registry.ownVersions(tenant, id);
  const newest = versions[versions.length - 1];
  if (newest === undefined)
    throw new NotFoundError("NOT_FOUND", { workspace: tenant, id }, `${capability.label} '${id}' not found.`);

  const previousTeamId = await registry.teamOfVersion?.(tenant, id, newest);

  // A no-op transfer is refused rather than silently accepted: "move it to X" answering OK when it was already
  // X's reads as a change that happened, and the caller has no way to tell the difference. (Same answer the
  // issue move gives.)
  if (previousTeamId === teamId)
    throw new ConflictError(
      "CONFLICT",
      { workspace: tenant, id, team: teamId },
      `This ${capability.label.toLowerCase()} already belongs to that team.`,
    );

  // Source first, then destination — see the header. `authorize` with an undefined teamId passes, which is the
  // unowned case stated as data rather than as a branch.
  authorize(principal, capability.action, previousTeamId === undefined ? {} : { teamId: previousTeamId });
  authorize(principal, capability.action, { teamId });

  await registry.moveToTeam(tenant, id, teamId);

  // Best-effort by contract (the emitter never throws) — a fact that could fail the transfer it describes would
  // make the log's availability part of the product's.
  void input.events?.emit({
    workspace: tenant,
    kind: capability.kind,
    subject: { type: capability.subjectType, id },
    actor: principal.subject,
    payload: { id, to: teamId, ...(previousTeamId !== undefined ? { from: previousTeamId } : {}) },
    ...(input.agent?.agentId !== undefined
      ? { causedBy: `agent:${input.agent.agentId}:${input.agent.conversationId ?? "unknown"}` }
      : {}),
    message: `${capability.subjectType} ${id} moved to team ${teamId}`,
  });

  return {
    workspace: tenant,
    id,
    teamId,
    ...(previousTeamId !== undefined ? { previousTeamId } : {}),
  };
}
