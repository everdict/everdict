import { BadRequestError } from "@everdict/contracts";
import { type Action, type Principal, authorize } from "@everdict/domain";
import { z } from "zod";

// Shared core for editing version tags — the HTTP route (server.ts) and the MCP tool (mcp.ts) use the same logic (BFF↔MCP parity).
// Tags = mutable registry metadata "outside" the spec (free-form labels) — attached when a version is hard to tell apart by number alone.
// Not spec content, so they don't participate in specsEqual / version immutability (SSOT guarantee) and stay freely editable after registration.
// Gate: reuse each entity's content-mutation action (no new action) — harnesses:register / datasets:write /
// judges:write / runtimes:write. Targets tenant-owned versions only — _shared / other workspaces are NotFound (404) from the registry.

// Route body: { tags: [...] } — full replacement (PUT semantics). Empty array = remove all tags.
export const VersionTagsBodySchema = z.object({
  tags: z.array(z.string().max(60, "A tag must be at most 60 characters.")).max(20, "At most 20 tags per version."),
});

// The minimal contract shared by the registries (harness/dataset/judge/runtime/rubric) — this is all the
// service sees.
//
// ── AND THE OWNER, REQUIRED (arch-review 119) ────────────────────────────────────────────────────
//
// This used to be the write alone, and the gate below asked `authorize(principal, action)` with nothing to
// authorize it AGAINST — so a member of any team could retag any team's version through any of the twelve
// doors this core serves. Version tags are how a release is labelled and found, and editing another team's
// labels is editing their asset; the documented invariant (docs/auth.md §"The team axis") refuses it.
//
// REQUIRED, not optional: an optional owner reader is indistinguishable from a registry that chose not to
// answer, and the arm that skips the gate is the permissive one (rule `protocol`).
export interface VersionTaggable {
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
}

// trim + drop empty tags + order-preserving dedupe. If it still exceeds the count/length limits after normalization, BadRequest.
export function normalizeVersionTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length > 0 && !out.includes(tag)) out.push(tag);
  }
  if (out.length > 20) throw new BadRequestError("BAD_REQUEST", { count: out.length }, "At most 20 tags per version.");
  return out;
}

export async function setVersionTags(
  registry: VersionTaggable,
  principal: Principal,
  action: Action,
  id: string,
  version: string,
  tags: string[],
): Promise<{ workspace: string; id: string; version: string; tags: string[] }> {
  authorize(principal, action);
  const normalized = normalizeVersionTags(tags);
  await registry.setVersionTags(principal.workspace, id, version, normalized);
  return { workspace: principal.workspace, id, version, tags: normalized };
}
