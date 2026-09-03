import { z } from "zod";

// ── THE HUMAN NAME OF AN ISSUE, MINTED BY THE WORKSPACE ──────────────────────────────────────────────
//
// These lived on the Team record, because the prefix used to say whose list an issue was on and the sequence
// came from that team's own counter. With the workspace as the only boundary there is one prefix and one
// counter, so the vocabulary belongs to the WORKSPACE — but the SHAPE is unchanged, which is the point: an
// identifier is a public address (`GET /issues/EVD-12`, `/{workspace}/issues/EVD-12`) that people paste into
// pull requests and chat, and it should keep reading like a name rather than becoming a uuid.

// 2–6 characters, uppercase, starting with a letter. Immutable after the workspace is created: it is baked
// into every identifier the workspace has ever minted.
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;
export const IssueKeySchema = z
  .string()
  .regex(ISSUE_KEY_PATTERN, "An issue key is 2–6 characters, uppercase letters or digits, starting with a letter.");

// `<key>-<number>`. Computed at creation and STORED on the issue, so a read never has to join the workspace
// row to learn what an issue is called.
export function formatIssueIdentifier(key: string, issueNumber: number): string {
  return `${key}-${issueNumber}`;
}

// Case-insensitive on the way in (a lowercased URL still resolves) and unambiguous against an id: a uuid is
// lowercase hex in five dash-separated groups, so it can never match this shape.
export const ISSUE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/;

// The stored form of a reference a caller typed: `evd-12` → `EVD-12`. Returns undefined when the ref is not an
// identifier at all (an id), which is what tells a lookup which of the two indexes to use.
export function parseIssueIdentifier(ref: string): string | undefined {
  return ISSUE_IDENTIFIER_PATTERN.test(ref) ? ref.toUpperCase() : undefined;
}

// The prefix a workspace mints under, derived from its id when nobody has chosen one. ONE owner, because the
// live migration (`scripts/live/migrate-teams-to-workspace.mjs`) and the allocator that files an issue in a
// workspace the migration never reached must answer alike — a workspace whose first issue is `EVD-1` and
// whose backfill then decides the prefix is `ACME` has two names for one sequence.
//
// Deterministic and total: uppercase, drop what a key may not carry, drop leading digits (a key starts with a
// letter), take the first six. `EVD` when nothing survives — a fallback rather than a refusal, because the
// alternative is a workspace that cannot file an issue at all.
export function deriveIssueKey(workspaceId: string): string {
  const stem = workspaceId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[^A-Z]+/, "")
    .slice(0, 6);
  return stem.length >= 2 ? stem : "EVD";
}
