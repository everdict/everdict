import type { DomainFact } from "@everdict/contracts";

// The fact PROJECTOR (review §25 / events rule): the domain states WHAT happened (kind/subject/actor/
// payload); this module decides how a person reads it (the one-line `message`) and whose bell rings (the
// push `recipient`). It runs at the stamping choke point (stampFacts), so every aggregate's facts are
// projected once, in one place — a new kind without a template still persists (the generic rendering below),
// and moving a sentence never touches a domain transition again.
//
// Renderings read the FACT alone — payload + subject, never the aggregate — which is why domain payloads
// carry names/identifiers/titles and not just filterable ids. The strings reproduce the previous
// domain-authored templates byte-for-byte: the persisted log's wording is consumed (Mattermost pass-through,
// activity-feed fallbacks), so the move must not rewrite history's voice.

const s = (payload: Record<string, unknown> | undefined, key: string): string => {
  const v = payload?.[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
};
const n = (payload: Record<string, unknown> | undefined, key: string): number | undefined => {
  const v = payload?.[key];
  return typeof v === "number" ? v : undefined;
};

const passRateSuffix = (payload: Record<string, unknown> | undefined): string => {
  const rate = n(payload, "passRate");
  return rate !== undefined ? ` (pass rate ${Math.round(rate * 100)}%)` : "";
};

const health = (payload: Record<string, unknown> | undefined): string => s(payload, "health").replace("_", " ");

// One template per kind that has one; anything else falls to the generic line. Keyed switch rather than a
// Record so a template can read several payload fields without ceremony.
function template(fact: DomainFact): string | undefined {
  const p = fact.payload;
  const id = fact.subject.id;
  switch (fact.kind) {
    // ── runs ──
    case "run.submitted":
      return `Run ${id} submitted — ${s(p, "harness")} (case ${s(p, "caseId")})`;
    case "run.completed":
    case "run.failed":
      return `Run ${id} ${s(p, "status")} — ${s(p, "harness")} (case ${s(p, "caseId")})`;
    case "run.snapshotted":
      return `Session ${id} snapshotted world ${s(p, "world")}@${s(p, "version")}`;
    // ── scorecards ──
    case "scorecard.submitted":
      return `Scorecard ${id} submitted — ${s(p, "dataset")} × ${s(p, "harness")} (${n(p, "cases") ?? 0} cases)`;
    case "scorecard.completed":
    case "scorecard.failed":
      return `Scorecard ${id} ${s(p, "status")} — ${s(p, "dataset")} × ${s(p, "harness")}${passRateSuffix(p)}`;
    case "scorecard.cancelled":
      return `Scorecard ${id} cancelled — ${s(p, "dataset")} × ${s(p, "harness")}`;
    case "scorecard.scored":
      return `Scorecard ${id} scored — ${s(p, "dataset")} × ${s(p, "harness")}${passRateSuffix(p)}${
        p?.promoted === true ? " (promoted from experiment)" : ""
      }`;
    // ── approvals ──
    case "approval.requested":
      return `Agent approval requested — ${s(p, "tool")} (session ${s(p, "sessionId")})`;
    case "approval.decided": {
      const decision = s(p, "decision");
      return decision === "expired"
        ? `Agent approval expired — ${s(p, "tool")} (session ${s(p, "sessionId")})`
        : `Agent approval ${decision} — ${s(p, "tool")} (session ${s(p, "sessionId")})`;
    }
    // ── tracker ──
    case "issue.created":
      return `${s(p, "identifier")} filed — ${s(p, "title")}`;
    case "issue.status_changed":
      return `${s(p, "identifier")} ${s(p, "from")} → ${s(p, "to")} — ${s(p, "title")}`;
    case "issue.linked":
      return `Issue linked to ${s(p, "linkType")} ${s(p, "linkId")} — ${s(p, "title")}`;
    // ── evolution campaign (docs/architecture/evolution-lineage.md, Track D) ──
    case "campaign.opened":
      return `Campaign opened on ${s(p, "subjectType")} ${s(p, "subjectId")} (baseline ${s(p, "baselineVersion")})`;
    case "campaign.round_logged":
      return `Campaign round ${s(p, "seq")} — candidate ${s(p, "candidateVersion")}: ${s(p, "improvements")} up, ${s(p, "regressions")} down`;
    case "campaign.closed":
      return p?.state === "adopted"
        ? `Campaign adopted ${s(p, "subjectId")}@${s(p, "version")}`
        : `Campaign closed — ${s(p, "state")}`;
    // The decision took EFFECT — a different sentence from the close, and the one an operator was missing:
    // "adopted" is what the gate concluded, this is the capability arriving (arch-review 83).
    case "campaign.adoption_registered":
      return p?.created === true
        ? `Adopted ${s(p, "candidateType")} ${s(p, "candidateId")}@${s(p, "version")} registered — proved by scorecard ${s(p, "provingScorecardId")}`
        : `Adopted ${s(p, "candidateType")} ${s(p, "candidateId")}@${s(p, "version")} confirmed against the bytes it already held — proved by scorecard ${s(p, "provingScorecardId")}`;
    case "campaign.adoption_merged":
      return `Adopted ${s(p, "candidateId")}@${s(p, "version")} merged — pull request #${s(p, "prNumber")} of ${s(p, "repo")} at ${s(p, "mergedSha")}`;
    case "campaign.candidate_built":
      return `Campaign built candidate ${s(p, "candidateVersion")} for slot ${s(p, "slot")} from ${s(p, "sha")} — ${s(p, "image")}`;
    case "campaign.candidate_build_failed":
      return `Campaign candidate build for slot ${s(p, "slot")} failed — ${s(p, "error")}`;
    case "campaign.adoption_completed":
      return `Adoption of ${s(p, "candidateId")}@${s(p, "version")} settled its issue ${s(p, "issueId")}`;
    case "issue_label.created":
      return `Label ${s(p, "name")} was defined.`;
    case "issue_label.updated":
      return `Label ${s(p, "name")} was updated.`;
    case "issue_label.deleted":
      return `Label ${s(p, "name")} was deleted.`;
    case "project.created":
      return `Project created — ${s(p, "name")}`;
    case "project.update_posted":
      return `${s(p, "name")} — ${health(p)}`;
    case "project.status_changed":
      return `Project ${s(p, "from")} → ${s(p, "to")} — ${s(p, "name")}`;
    case "initiative.created":
      return `Initiative created — ${s(p, "name")}`;
    case "initiative.update_posted":
      return `${s(p, "name")} — ${health(p)}`;
    case "initiative.status_changed":
      return `Initiative ${s(p, "from")} → ${s(p, "to")} — ${s(p, "name")}`;
    // ── product timeline ──
    case "product.created":
      return `Product created — ${s(p, "name")}`;
    case "product.service_version_imported":
      return `${s(p, "service")} ${s(p, "version")} — ${s(p, "name")}`;
    default:
      return undefined;
  }
}

// The one-line rendering a persisted event carries (what a woken agent reads first — required on the
// record). A kind with no template gets the generic line rather than an empty one: a fact must never be
// unreadable just because nobody wrote its sentence yet.
export function renderFactMessage(fact: DomainFact): string {
  return template(fact) ?? `${fact.kind} — ${fact.subject.type} ${fact.subject.id}`;
}

// Kinds whose fact previously targeted its own actor for the personal push (recipient = the member the work
// belongs to). Everything else is workspace news with no personal bell.
const SELF_RECIPIENT_KINDS = new Set<string>([
  "run.submitted",
  "run.completed",
  "run.failed",
  "run.snapshotted",
  "scorecard.submitted",
  "scorecard.completed",
  "scorecard.failed",
  "scorecard.cancelled",
  "scorecard.scored",
]);

export function projectRecipient(fact: DomainFact): string | undefined {
  return SELF_RECIPIENT_KINDS.has(fact.kind) ? fact.actor : undefined;
}
