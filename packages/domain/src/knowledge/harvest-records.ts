import {
  type CommentRecord,
  type MemberRecord,
  NodeTypeSchema,
  type RunRecord,
  type ScheduleRecord,
} from "@everdict/contracts";
import { HarvestBuilder, type HarvestResult } from "./harvest.js";

// Structured harvesters for the result/activity records that surround a scorecard. Each materialises its OWN node
// (the reference harvester `harvestScorecard` only emits its self node, so these fill in the run/schedule/comment/user
// rows its edges point at) plus its foreign-key edges, all via the shared HarvestBuilder. Pure and deterministic.

export const RUN_HARVESTER = "run_harvester_v1";
export const SCHEDULE_HARVESTER = "schedule_harvester_v1";
export const COMMENT_HARVESTER = "comment_harvester_v1";
export const MEMBERSHIP_HARVESTER = "membership_harvester_v1";

// A RunRecord — a single case execution, child of a scorecard batch, on a harness, placed on a runtime/runner.
export function harvestRun(r: RunRecord): HarvestResult {
  const b = new HarvestBuilder(r.tenant, "run", r.id, RUN_HARVESTER, r.updatedAt, r.createdAt).self(
    { type: "run", key: r.id },
    `${r.caseId} · ${r.harness.id}@${r.harness.version}`,
    { status: r.status, caseId: r.caseId },
  );
  b.ref("in_workspace", { type: "workspace", key: r.tenant }, "tenant");
  if (r.createdBy !== undefined && r.createdBy !== "")
    b.ref("created_by", { type: "user", key: r.createdBy }, "createdBy");
  b.ref("evaluates", { type: "harness", key: r.harness.id, version: r.harness.version }, "harness");
  if (r.parentScorecardId !== undefined && r.parentScorecardId !== "") {
    b.ref("child_of", { type: "scorecard", key: r.parentScorecardId }, "parentScorecardId");
  }
  // `runtime` is a placement target: a registered runtime id, or `self:<runnerId>` for a self-hosted device.
  if (r.runtime !== undefined && r.runtime !== "") {
    if (r.runtime.startsWith("self:"))
      b.ref("placed_on", { type: "runner", key: r.runtime.slice("self:".length) }, "runtime");
    else b.ref("runs_on", { type: "runtime", key: r.runtime }, "runtime");
  }
  return b.result();
}

// A ScheduleRecord — a cron eval definition. Its runTemplate is EITHER a dataset×harness batch OR a trace pull.
export function harvestSchedule(s: ScheduleRecord): HarvestResult {
  const b = new HarvestBuilder(s.tenant, "schedule", s.id, SCHEDULE_HARVESTER, s.updatedAt, s.createdAt).self(
    { type: "schedule", key: s.id },
    s.name,
    { cron: s.cron, timezone: s.timezone, enabled: s.enabled },
  );
  b.ref("in_workspace", { type: "workspace", key: s.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: s.createdBy }, "createdBy");
  const t = s.runTemplate;
  if (t.dataset !== undefined) {
    b.ref("uses_dataset", { type: "dataset", key: t.dataset.id, version: t.dataset.version }, "runTemplate.dataset");
  }
  if (t.harness !== undefined) {
    b.ref("evaluates", { type: "harness", key: t.harness.id, version: t.harness.version }, "runTemplate.harness");
  }
  t.judges.forEach((j, i) => {
    b.ref("applies_judge", { type: "judge", key: j.id, version: j.version }, `runTemplate.judges[${i}]`);
  });
  if (t.runtime !== undefined && t.runtime !== "")
    b.ref("runs_on", { type: "runtime", key: t.runtime }, "runTemplate.runtime");
  if (t.pull !== undefined)
    b.ref("pulls_from", { type: "trace_source", key: t.pull.source }, "runTemplate.pull.source");
  return b.result();
}

// A CommentRecord — a resource-discussion comment. `resourceType` is one of the NodeType values; a versioned resource
// (dataset/harness) is referenced by its family id (no version) since a comment is about the resource, not a version.
export function harvestComment(c: CommentRecord): HarvestResult {
  const b = new HarvestBuilder(c.tenant, "comment", c.id, COMMENT_HARVESTER, c.updatedAt, c.createdAt).self(
    { type: "comment", key: c.id },
    `comment on ${c.resourceType}`,
    { resourceType: c.resourceType },
  );
  b.ref("in_workspace", { type: "workspace", key: c.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: c.author }, "author");
  const rt = NodeTypeSchema.safeParse(c.resourceType);
  if (rt.success) b.ref("discusses", { type: rt.data, key: c.resourceId }, "resourceId");
  if (c.parentId !== undefined && c.parentId !== "")
    b.ref("reply_to", { type: "comment", key: c.parentId }, "parentId");
  return b.result();
}

// A MemberRecord — a workspace membership. There is no membership NODE; the harvester materialises the USER node and
// the `member_of` edge (role on the edge). MemberRecord carries no tenant, so the workspace is passed in.
export function harvestMembership(workspace: string, m: MemberRecord): HarvestResult {
  const attrs: Record<string, unknown> = { role: m.role };
  if (m.email !== undefined && m.email !== "") attrs.email = m.email;
  const label = m.name !== undefined && m.name !== "" ? m.name : m.subject;
  const b = new HarvestBuilder(workspace, "membership", m.subject, MEMBERSHIP_HARVESTER, m.addedAt, m.addedAt).self(
    { type: "user", key: m.subject },
    label,
    attrs,
  );
  b.ref("member_of", { type: "workspace", key: workspace }, "role", { role: m.role });
  return b.result();
}
