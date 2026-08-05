import {
  type CycleRecord,
  type InitiativeRecord,
  type IssueRecord,
  NodeTypeSchema,
  type ProjectRecord,
  type TeamRecord,
} from "@everdict/contracts";
import { HarvestBuilder, type HarvestResult } from "./harvest.js";

// Structured harvesters for the INTENT stratum — the eval tracker (Initiative ⊃ Project ⊃ Issue, scoped by Team,
// paced by Cycle). The ISSUE is the graph's hub: its links say what verifies it (`verified_by`), its resolution says
// what closed it (`resolved_by` — the regression baseline), and its plan coordinates (`part_of` / `child_of` /
// `belongs_to` / `assigned_to`) hang the massive resource strata off the problem they exist to answer. Pure and
// deterministic, on the shared HarvestBuilder; record pattern (key = record id, no version — see harvest-records.ts).

export const ISSUE_HARVESTER = "issue_harvester_v1";
export const PROJECT_HARVESTER = "project_harvester_v1";
export const INITIATIVE_HARVESTER = "initiative_harvester_v1";
export const TEAM_HARVESTER = "team_harvester_v1";
export const CYCLE_HARVESTER = "cycle_harvester_v1";

// An IssueRecord — the unit of intent. The label leads with the identifier (`ENG-12 · title`) because that is how the
// rest of the product addresses issues; the identifier also sits in attrs so a renderer can chip it without parsing.
// `labelIds` are deliberately NOT projected: they are registry ids, and a tag node labelled by a UUID says nothing —
// projecting them needs label-name resolution at harvest time (follow-up in the design doc).
export function harvestIssue(i: IssueRecord): HarvestResult {
  const b = new HarvestBuilder(i.tenant, "issue", i.id, ISSUE_HARVESTER, i.updatedAt, i.createdAt).self(
    { type: "issue", key: i.id },
    `${i.identifier} · ${i.title}`,
    { status: i.status, identifier: i.identifier, priority: i.priority },
  );
  b.ref("in_workspace", { type: "workspace", key: i.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: i.createdBy }, "createdBy");
  b.ref("belongs_to", { type: "team", key: i.teamId }, "teamId");
  if (i.assignee !== undefined && i.assignee !== "")
    b.ref("assigned_to", { type: "user", key: i.assignee }, "assignee");
  if (i.projectId !== undefined && i.projectId !== "")
    b.ref("part_of", { type: "project", key: i.projectId }, "projectId");
  if (i.cycleId !== undefined && i.cycleId !== "") b.ref("part_of", { type: "cycle", key: i.cycleId }, "cycleId");
  if (i.parentId !== undefined && i.parentId !== "") b.ref("child_of", { type: "issue", key: i.parentId }, "parentId");
  i.links.forEach((l, idx) => {
    // ISSUE_LINK_TYPES is a strict subset of NODE_TYPES today; the safeParse keeps that a fact, not an assumption.
    const lt = NodeTypeSchema.safeParse(l.type);
    if (!lt.success) return;
    const ref =
      l.version !== undefined && l.version !== ""
        ? { type: lt.data, key: l.id, version: l.version }
        : { type: lt.data, key: l.id };
    b.ref("verified_by", ref, `links[${idx}]`, l.note !== undefined && l.note !== "" ? { note: l.note } : {});
  });
  if (i.resolution?.scorecardId !== undefined && i.resolution.scorecardId !== "") {
    b.ref("resolved_by", { type: "scorecard", key: i.resolution.scorecardId }, "resolution.scorecardId", {
      at: i.resolution.at,
    });
  }
  return b.result();
}

// A ProjectRecord — issues under one target date, serving one or more goals.
export function harvestProject(p: ProjectRecord): HarvestResult {
  const attrs: Record<string, unknown> = { status: p.status };
  if (p.health !== undefined) attrs.health = p.health;
  const b = new HarvestBuilder(p.tenant, "project", p.id, PROJECT_HARVESTER, p.updatedAt, p.createdAt).self(
    { type: "project", key: p.id },
    p.name,
    attrs,
  );
  b.ref("in_workspace", { type: "workspace", key: p.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: p.createdBy }, "createdBy");
  if (p.lead !== undefined && p.lead !== "")
    b.ref("assigned_to", { type: "user", key: p.lead }, "lead", { role: "lead" });
  p.teamIds.forEach((t, idx) => b.ref("belongs_to", { type: "team", key: t }, `teamIds[${idx}]`));
  p.initiativeIds.forEach((n, idx) => b.ref("part_of", { type: "initiative", key: n }, `initiativeIds[${idx}]`));
  return b.result();
}

// An InitiativeRecord — the GOAL several projects work toward; may decompose under a parent goal.
export function harvestInitiative(n: InitiativeRecord): HarvestResult {
  const attrs: Record<string, unknown> = { status: n.status };
  if (n.health !== undefined) attrs.health = n.health;
  if (n.icon !== undefined && n.icon !== "") attrs.icon = n.icon;
  const b = new HarvestBuilder(n.tenant, "initiative", n.id, INITIATIVE_HARVESTER, n.updatedAt, n.createdAt).self(
    { type: "initiative", key: n.id },
    n.name,
    attrs,
  );
  b.ref("in_workspace", { type: "workspace", key: n.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: n.createdBy }, "createdBy");
  if (n.lead !== undefined && n.lead !== "")
    b.ref("assigned_to", { type: "user", key: n.lead }, "lead", { role: "lead" });
  if (n.parentId !== undefined && n.parentId !== "")
    b.ref("part_of", { type: "initiative", key: n.parentId }, "parentId");
  return b.result();
}

// A TeamRecord — the grouping layer the issue identifiers come from. Roster edges are skipped v1 (the builder emits
// self→object only, and `member_of` runs user→team — same reason harvestMembership materialises the USER node).
export function harvestTeam(t: TeamRecord): HarvestResult {
  const b = new HarvestBuilder(t.tenant, "team", t.id, TEAM_HARVESTER, t.updatedAt, t.createdAt).self(
    { type: "team", key: t.id },
    `${t.key} · ${t.name}`,
    { key: t.key },
  );
  b.ref("in_workspace", { type: "workspace", key: t.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: t.createdBy }, "createdBy");
  if (t.parentId !== undefined && t.parentId !== "") b.ref("part_of", { type: "team", key: t.parentId }, "parentId");
  return b.result();
}

// A CycleRecord — a team's numbered iteration window.
export function harvestCycle(c: CycleRecord): HarvestResult {
  const label = c.name !== undefined && c.name !== "" ? c.name : `Cycle ${c.number}`;
  const b = new HarvestBuilder(c.tenant, "cycle", c.id, CYCLE_HARVESTER, c.updatedAt, c.createdAt).self(
    { type: "cycle", key: c.id },
    label,
    { number: c.number, startsAt: c.startsAt, endsAt: c.endsAt },
  );
  b.ref("in_workspace", { type: "workspace", key: c.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: c.createdBy }, "createdBy");
  b.ref("belongs_to", { type: "team", key: c.teamId }, "teamId");
  return b.result();
}
