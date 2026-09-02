import type { CapabilityOrigin, CapabilityOriginChannel, CapabilityOriginSourceType } from "@everdict/contracts";
import {
  BadRequestError,
  type CapabilityOriginFork,
  CapabilityOriginForkSchema,
  CapabilityOriginRefSchema,
} from "@everdict/contracts";
import { z } from "zod";
import type { AgentAttribution } from "./fs/fs-actor.js";
import type { ServerDeps } from "./route-context.js";

// The birth stamp a registration carries — assembled here so both transports produce the SAME provenance for the
// same act (`docs/registry.md` §origin). Three pieces, from three places:
//   · `via`      — the channel, decided by the caller (a route says "web", a tool says "mcp").
//   · the agent  — from the attribution the caller already carries (request headers on HTTP, the declared session
//                  identity on MCP). Never asked for in a body: the agent says who it is once, at the door.
//   · `from`     — DECLARED by the caller, because only the caller knows what it was working on.
//
// A declared issue reference is resolved to the issue's RECORD ID before it is stored, and its identifier+title
// snapshotted as the label: `ENG-12` is re-minted when an issue moves team, so a stamp that kept the identifier
// would rot exactly when the issue changed hands. If the lookup fails the declaration is kept verbatim — a
// provenance note about an issue the caller cannot read (or that was deleted) is still better than none, and it
// renders as plain text rather than a link.

// What a caller may declare about where a registration came from. The rest of CapabilityOrigin is assembled from
// the request, never accepted from the body: a caller must not be able to claim it was another agent.
export const DeclaredOriginSchema = z.object({
  from: CapabilityOriginRefSchema.omit({ label: true }).optional(), // label is ours to snapshot, not theirs to set
  note: z.string().max(500).optional(),
});
export type DeclaredOrigin = z.infer<typeof DeclaredOriginSchema>;

// Pull the declaration off a register body without disturbing the spec parse beside it: the spec schemas strip
// unknown keys, so `origin` may ride along in the same body and simply not reach the spec.
export function declaredOriginFrom(body: unknown): DeclaredOrigin | undefined {
  if (typeof body !== "object" || body === null || !("origin" in body)) return undefined;
  const parsed = DeclaredOriginSchema.safeParse((body as { origin?: unknown }).origin);
  return parsed.success ? parsed.data : undefined;
}

// Documented in prose rather than in the body schema: the body IS the spec (the spec schema strips this sibling
// so it can never become content), and folding an envelope around a discriminated union just to document one
// optional field would change the shape every existing caller posts.
const ORIGIN_BODY_DOC =
  "An optional `origin` sibling records where this came from: " +
  '`{"from":{"type":"issue","id":"ENG-12"},"note":"…"}`. It is stored as version metadata (never part of the ' +
  "immutable spec), and an issue origin also links the new capability back to that issue.";

// Appended to a register route's OpenAPI description, so the three registers say it the same way.
export function withOriginDoc(description: string): string {
  return `${description} ${ORIGIN_BODY_DOC}`;
}

// The MCP shape of the same declaration. A tool takes a bare issue reference rather than a nested object because
// that is what an agent actually holds — the identifier a member pasted at it (`ENG-12`) or the id it just read.
export const FROM_ISSUE_TOOL_DESCRIPTION =
  "The issue this was built for (id or identifier, e.g. ENG-12). Recorded as its origin — the detail view then " +
  "says where it came from — and linked back to the issue, which is what lets a regression against it surface.";
export const ORIGIN_NOTE_TOOL_DESCRIPTION = "One line on why this exists, stored with the origin.";

export function declaredOriginFromIssue(fromIssue?: string, note?: string): DeclaredOrigin | undefined {
  if (fromIssue === undefined && note === undefined) return undefined;
  return {
    ...(fromIssue !== undefined ? { from: { type: "issue" as const, id: fromIssue } } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

export async function capabilityOriginFor(
  deps: ServerDeps,
  tenant: string,
  via: CapabilityOriginChannel,
  agent: AgentAttribution | undefined,
  declared: DeclaredOrigin | undefined,
  // The capability BEING registered. A declared `from` naming its own family is refused (review wave C):
  // the harvester reads a same-family `from` as the version-lineage `succeeds` edge, and only the
  // platform's own writes (re-pin, bump) may say it — they resolve the base at the write (L3). A caller
  // declaring it would mint a lineage edge for a derivation that never happened. Required, not optional —
  // an optional self is a call site that forgot to say who it is.
  self: { type: CapabilityOriginSourceType; id: string },
): Promise<CapabilityOrigin> {
  const from = declared?.from;
  if (from !== undefined && from.type === self.type && from.id === self.id) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { from },
      `origin.from may not name this capability's own family (${self.type} '${self.id}'): version lineage is stamped by the platform's re-pin/bump writes, never declared.`,
    );
  }
  const resolved = from?.type === "issue" ? await resolveIssueRef(deps, tenant, from.id) : undefined;
  return {
    via,
    ...(from !== undefined
      ? {
          from: {
            ...from,
            ...(resolved !== undefined ? { id: resolved.id, label: resolved.label } : {}),
          },
        }
      : {}),
    ...(agent?.agentId !== undefined ? { agentId: agent.agentId } : {}),
    ...(agent?.agentName !== undefined ? { agentName: agent.agentName } : {}),
    ...(agent?.conversationId !== undefined ? { conversationId: agent.conversationId } : {}),
    ...(agent?.runId !== undefined ? { runId: agent.runId } : {}),
    ...(declared?.note !== undefined ? { note: declared.note } : {}),
  };
}

// id-or-identifier → the stable record id + a display snapshot. Best-effort: an unreadable or deleted issue
// leaves the declaration as the caller wrote it.
async function resolveIssueRef(
  deps: ServerDeps,
  tenant: string,
  ref: string,
): Promise<{ id: string; label: string } | undefined> {
  if (!deps.issueService) return undefined;
  try {
    const issue = await deps.issueService.get(tenant, ref);
    return { id: issue.id, label: `${issue.identifier} ${issue.title}`.slice(0, 200) };
  } catch {
    return undefined;
  }
}

// ── THE FORK A REGISTER DECLARES (harness-identity-and-seeds-spec.md §1) ─────────────────────────────
//
// A body-level sibling like `origin`: `forkedFrom: { id, version, specDigest }`. Read here so both transports parse
// one shape; verified by `verifyForkLineage` before the write; stamped on the origin, never into the spec.
export function declaredForkFrom(body: unknown): CapabilityOriginFork | undefined {
  if (typeof body !== "object" || body === null || !("forkedFrom" in body)) return undefined;
  const parsed = CapabilityOriginForkSchema.safeParse((body as { forkedFrom?: unknown }).forkedFrom);
  if (!parsed.success)
    throw new BadRequestError(
      "BAD_REQUEST",
      { forkedFrom: (body as { forkedFrom?: unknown }).forkedFrom },
      parsed.error.message,
    );
  return parsed.data;
}
