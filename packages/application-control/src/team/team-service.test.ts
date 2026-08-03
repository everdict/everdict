import type { IssuePage, IssueRecord, TeamMemberRecord, TeamRecord } from "@everdict/contracts";
import { ConflictError, NotFoundError, formatIssueIdentifier } from "@everdict/contracts";
import { issueCountsByTeam, issueSummaryOf } from "@everdict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { IssueListFilter, IssuePageFilter, IssueStore, IssueTeamCounts } from "../ports/issue-store.js";
import type { IssueNumberGrant, TeamListFilter, TeamStore } from "../ports/team-store.js";
import { TeamService } from "./team-service.js";

const NOW = "2026-07-31T00:00:00.000Z";
const DANA = { subject: "dana", isAdmin: true };

// Local fakes: application-control must not import from an adapter package (@everdict/db is downstream), and a
// unit only needs the port's behaviour, not its storage.
class FakeTeamStore implements TeamStore {
  readonly rows = new Map<string, TeamRecord>();
  readonly members: TeamMemberRecord[] = [];

  async create(record: TeamRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async get(tenant: string, id: string): Promise<TeamRecord | undefined> {
    const row = this.rows.get(id);
    return row && row.tenant === tenant ? row : undefined;
  }
  async getByKey(tenant: string, key: string): Promise<TeamRecord | undefined> {
    return [...this.rows.values()].find((r) => r.tenant === tenant && r.key === key);
  }
  async getDefault(tenant: string): Promise<TeamRecord | undefined> {
    return [...this.rows.values()].find((r) => r.tenant === tenant && r.isDefault);
  }
  async list(tenant: string, filter?: TeamListFilter): Promise<TeamRecord[]> {
    const mine =
      filter?.member === undefined
        ? undefined
        : new Set(this.members.filter((m) => m.tenant === tenant && m.subject === filter.member).map((m) => m.teamId));
    const rows = [...this.rows.values()]
      .filter((r) => r.tenant === tenant && (mine === undefined || mine.has(r.id)))
      .sort((a, b) => a.key.localeCompare(b.key));
    return filter?.limit === undefined ? rows : rows.slice(0, filter.limit);
  }
  async count(tenant: string): Promise<number> {
    return [...this.rows.values()].filter((r) => r.tenant === tenant).length;
  }
  async update(tenant: string, id: string, patch: Partial<TeamRecord>): Promise<TeamRecord | undefined> {
    const current = this.rows.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.rows.set(id, next);
    return next;
  }
  async remove(tenant: string, id: string): Promise<void> {
    const current = this.rows.get(id);
    if (current && current.tenant === tenant) this.rows.delete(id);
  }
  async allocateIssueNumber(tenant: string, id: string, now: string): Promise<IssueNumberGrant | undefined> {
    const current = this.rows.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const number = current.issueCounter + 1;
    this.rows.set(id, { ...current, issueCounter: number, updatedAt: now });
    return { number, identifier: formatIssueIdentifier(current.key, number) };
  }
  async listMembers(tenant: string, teamId: string): Promise<TeamMemberRecord[]> {
    return this.members.filter((m) => m.tenant === tenant && m.teamId === teamId);
  }
  // The batched roster count the team list reads — the per-team `listMembers` above stays for the detail view.
  async countMembersByTeam(tenant: string): Promise<{ teamId: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const member of this.members) {
      if (member.tenant !== tenant) continue;
      counts.set(member.teamId, (counts.get(member.teamId) ?? 0) + 1);
    }
    return [...counts].map(([teamId, count]) => ({ teamId, count }));
  }
  async addMember(record: TeamMemberRecord): Promise<void> {
    if (!this.members.some((m) => m.teamId === record.teamId && m.subject === record.subject))
      this.members.push(record);
  }
  async removeMember(tenant: string, teamId: string, subject: string): Promise<boolean> {
    const i = this.members.findIndex((m) => m.tenant === tenant && m.teamId === teamId && m.subject === subject);
    if (i < 0) return false;
    this.members.splice(i, 1);
    return true;
  }
}

class FakeIssueStore implements IssueStore {
  readonly rows: IssueRecord[] = [];
  async create(record: IssueRecord): Promise<void> {
    this.rows.push(record);
  }
  async get(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async getByIdentifier(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async getByGithub(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return this.rows.filter((r) => r.tenant === tenant && (filter?.teamId === undefined || r.teamId === filter.teamId));
  }
  // Load-bearing here, not decoration: the team summary and the delete gate BOTH read their counts through
  // this now, so these tests are what prove the aggregate answers what the per-team fetch used to.
  async listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage> {
    return { items: (await this.list(tenant, filter)).map(issueSummaryOf) };
  }
  async countByTeam(tenant: string): Promise<IssueTeamCounts[]> {
    return issueCountsByTeam(await this.list(tenant));
  }
  async update(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async remove(): Promise<void> {}
}

function service() {
  const store = new FakeTeamStore();
  const issues = new FakeIssueStore();
  let n = 0;
  return {
    store,
    issues,
    svc: new TeamService({ store, issues, newId: () => `team-${++n}`, now: () => NOW }),
  };
}

describe("TeamService.ensureDefault — a workspace always has at least one team", () => {
  it("mints CORE on a workspace that has never had a team", async () => {
    const { svc } = service();
    const team = await svc.ensureDefault("acme", "dana");
    expect(team.key).toBe("CORE");
    expect(team.isDefault).toBe(true);
  });

  it("is idempotent — a second call returns the same team instead of a second CORE", async () => {
    const { svc, store } = service();
    const first = await svc.ensureDefault("acme", "dana");
    const second = await svc.ensureDefault("acme", "dana");
    expect(second.id).toBe(first.id);
    expect(await store.count("acme")).toBe(1);
  });

  it("promotes an existing team rather than minting a rival when the default flag went missing", async () => {
    const { svc, store } = service();
    const orphan = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Engineering" });
    await store.update("acme", orphan.id, { isDefault: false });
    const repaired = await svc.ensureDefault("acme", "dana");
    expect(repaired.id).toBe(orphan.id);
    expect(repaired.isDefault).toBe(true);
    expect(await store.count("acme")).toBe(1);
  });
});

describe("TeamService.create", () => {
  it("makes the first team of a workspace the default, whatever the caller asked for", async () => {
    const { svc } = service();
    const team = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng", isDefault: false });
    expect(team.isDefault).toBe(true);
  });

  it("leaves later teams non-default unless promotion was requested", async () => {
    const { svc } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    const ops = await svc.create({ tenant: "acme", createdBy: "dana", key: "OPS", name: "Ops" });
    expect(ops.isDefault).toBe(false);
  });

  it("moves the flag off the incumbent when a new team is created as the default", async () => {
    const { svc } = service();
    const eng = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await svc.create({ tenant: "acme", createdBy: "dana", key: "OPS", name: "Ops", isDefault: true });
    expect((await svc.get("acme", eng.id)).isDefault).toBe(false);
    expect((await svc.list("acme")).filter((t) => t.isDefault)).toHaveLength(1);
  });

  it("refuses a key another team in the workspace already holds", async () => {
    const { svc } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await expect(svc.create({ tenant: "acme", createdBy: "dana", key: "eng", name: "Other" })).rejects.toThrow(
      ConflictError,
    );
  });

  it("puts the creator on the roster — a team you cannot see is not one you meant to make", async () => {
    const { svc } = service();
    const team = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    expect((await svc.listMembers("acme", team.id)).map((m) => m.subject)).toEqual(["dana"]);
  });

  it("lets the same key exist in a different workspace", async () => {
    const { svc } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await expect(svc.create({ tenant: "globex", createdBy: "erin", key: "ENG", name: "Eng" })).resolves.toBeDefined();
  });
});

describe("TeamService.makeDefault — exactly one default survives the handover", () => {
  it("demotes the incumbent and promotes the successor", async () => {
    const { svc } = service();
    const eng = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    const ops = await svc.create({ tenant: "acme", createdBy: "dana", key: "OPS", name: "Ops" });
    await svc.makeDefault("acme", ops.id, DANA);
    expect((await svc.get("acme", eng.id)).isDefault).toBe(false);
    expect((await svc.get("acme", ops.id)).isDefault).toBe(true);
  });
});

describe("TeamService.remove — the last team and the default team are protected", () => {
  it("refuses to delete the only team", async () => {
    const { svc } = service();
    const team = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await expect(svc.remove("acme", team.id, DANA)).rejects.toThrow(ConflictError);
  });

  it("refuses to delete the default team even when another exists", async () => {
    const { svc } = service();
    const eng = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await svc.create({ tenant: "acme", createdBy: "dana", key: "OPS", name: "Ops" });
    await expect(svc.remove("acme", eng.id, DANA)).rejects.toThrow(/default team/);
  });

  it("deletes a non-default empty team", async () => {
    const { svc, store } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    const ops = await svc.create({ tenant: "acme", createdBy: "dana", key: "OPS", name: "Ops" });
    await svc.remove("acme", ops.id, DANA);
    expect(await store.count("acme")).toBe(1);
  });

  it("refuses a non-creator, non-admin caller", async () => {
    const { svc } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    const ops = await svc.create({ tenant: "acme", createdBy: "dana", key: "OPS", name: "Ops" });
    await expect(svc.remove("acme", ops.id, { subject: "erin" })).rejects.toThrow(/creator or a workspace admin/);
  });
});

describe("TeamService.allocateForIssue — the identifier sequence", () => {
  it("falls back to the default team, creating it if the workspace has none", async () => {
    const { svc } = service();
    const { team, grant } = await svc.allocateForIssue("acme", undefined, "dana");
    expect(grant.identifier).toBe("CORE-1");
    expect((await svc.get("acme", team.id)).isDefault).toBe(true);
  });

  it("never hands the same number to two issues", async () => {
    const { svc } = service();
    const team = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    const first = await svc.allocateForIssue("acme", team.id, "dana");
    const second = await svc.allocateForIssue("acme", team.id, "dana");
    expect([first.grant.identifier, second.grant.identifier]).toEqual(["ENG-1", "ENG-2"]);
  });

  it("404s on a team from another workspace instead of leaking its existence", async () => {
    const { svc } = service();
    const team = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await expect(svc.allocateForIssue("globex", team.id, "erin")).rejects.toThrow(NotFoundError);
  });
});

describe("TeamService roster", () => {
  let ctx: ReturnType<typeof service>;
  beforeEach(() => {
    ctx = service();
  });

  it("adds and removes members, and reports the roster in the summary", async () => {
    const team = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await ctx.svc.addMember("acme", team.id, "alice", DANA);
    expect((await ctx.svc.summary("acme", team.id)).memberCount).toBe(2);
    await ctx.svc.removeMember("acme", team.id, "alice", DANA);
    expect((await ctx.svc.summary("acme", team.id)).memberCount).toBe(1);
  });

  it("404s when removing someone who is not on the team", async () => {
    const team = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await expect(ctx.svc.removeMember("acme", team.id, "erin", DANA)).rejects.toThrow(NotFoundError);
  });

  // The counts a team LIST row shows, for every row at once. They used to be gathered a team at a time, each
  // one listing that team's issues in full; this asserts the batched answer is the same one, per team, and that
  // a team with nothing yet reports zeroes instead of vanishing from its own list.
  it("summarizes every team in one batch — issue counts per team, regressed counting as open", async () => {
    const eng = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    const ops = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "OPS", name: "Ops" });
    const empty = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "NEW", name: "New" });
    for (const [team, status] of [
      [eng, "todo"],
      [eng, "regressed"],
      [eng, "done"],
      [ops, "cancelled"],
    ] as const)
      ctx.issues.rows.push({
        id: `${team.id}-${status}`,
        tenant: "acme",
        teamId: team.id,
        priority: "none",
        inTriage: false,
        number: 1,
        identifier: `${team.key}-1`,
        formerIdentifiers: [],
        title: "t",
        status,
        labelIds: [],
        links: [],
        history: [],
        createdBy: "dana",
        createdAt: NOW,
        updatedAt: NOW,
      });

    const summaries = await ctx.svc.summaries("acme", [eng.id, ops.id, empty.id]);
    expect(summaries.get(eng.id)).toEqual({ memberCount: 1, totalIssues: 3, openIssues: 2 });
    expect(summaries.get(ops.id)).toEqual({ memberCount: 1, totalIssues: 1, openIssues: 0 });
    expect(summaries.get(empty.id)).toEqual({ memberCount: 1, totalIssues: 0, openIssues: 0 });
    // The single-team read is the same arithmetic, so the list and the detail can never disagree.
    expect(await ctx.svc.summary("acme", eng.id)).toEqual(summaries.get(eng.id));
  });

  it("lists only the teams a subject belongs to", async () => {
    const eng = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    await ctx.svc.create({ tenant: "acme", createdBy: "erin", key: "OPS", name: "Ops" });
    expect(await ctx.svc.teamIdsFor("acme", "dana")).toEqual([eng.id]);
  });
});

describe("TeamService — sub-teams", () => {
  let ctx: ReturnType<typeof service>;
  beforeEach(() => {
    ctx = service();
  });

  it("nests a team under another one", async () => {
    const platform = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "PLT", name: "Platform" });
    const runtime = await ctx.svc.create({
      tenant: "acme",
      createdBy: "dana",
      key: "RNT",
      name: "Runtime",
      parentId: platform.id,
    });
    expect(runtime.parentId).toBe(platform.id);
  });

  it("404s on a parent from another workspace, so nesting cannot leak that it exists", async () => {
    await expect(
      ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "RNT", name: "Runtime", parentId: "team-elsewhere" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses to re-parent a team under its own descendant — that would make the tree circular", async () => {
    const platform = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "PLT", name: "Platform" });
    const runtime = await ctx.svc.create({
      tenant: "acme",
      createdBy: "dana",
      key: "RNT",
      name: "Runtime",
      parentId: platform.id,
    });
    await expect(ctx.svc.update("acme", platform.id, { parentId: runtime.id }, DANA)).rejects.toThrow(ConflictError);
  });

  it("refuses to delete a team that still has sub-teams", async () => {
    // Given: a workspace whose default is elsewhere, so the delete reaches the sub-team guard
    await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "CORE", name: "Core" });
    const platform = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "PLT", name: "Platform" });
    await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "RNT", name: "Runtime", parentId: platform.id });
    await expect(ctx.svc.remove("acme", platform.id, DANA)).rejects.toThrow(/sub-team/);
  });
});

describe("TeamService.get — a team is addressed by its key as well as its id", () => {
  it("resolves the key people actually use, case-insensitively", async () => {
    const { svc } = service();
    const eng = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Engineering" });
    expect((await svc.get("acme", "ENG")).id).toBe(eng.id);
    expect((await svc.get("acme", "eng")).id).toBe(eng.id);
    expect((await svc.get("acme", eng.id)).id).toBe(eng.id);
  });

  it("404s on a key no team in this workspace holds, instead of answering with someone else's team", async () => {
    const { svc } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Engineering" });
    await expect(svc.get("acme", "MOB")).rejects.toThrow(NotFoundError);
  });

  it("keeps the two namespaces apart — the same ref in another workspace is not this team", async () => {
    const { svc } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Engineering" });
    await expect(svc.get("other", "ENG")).rejects.toThrow(NotFoundError);
  });

  it("hands a key-addressed mutation the resolved id, so the write lands on the team that was named", async () => {
    const { svc, store } = service();
    await svc.create({ tenant: "acme", createdBy: "dana", key: "CORE", name: "Core" });
    const eng = await svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Engineering" });
    await svc.addMember("acme", "eng", "sam", DANA);
    expect((await store.listMembers("acme", eng.id)).map((m) => m.subject)).toContain("sam");
    await svc.removeMember("acme", "ENG", "sam", DANA);
    expect((await store.listMembers("acme", eng.id)).map((m) => m.subject)).not.toContain("sam");
    await svc.remove("acme", "ENG", DANA);
    expect(await store.get("acme", eng.id)).toBeUndefined();
  });

  it("resolves a parent named by key, and stores the id it resolved to", async () => {
    const { svc } = service();
    const platform = await svc.create({ tenant: "acme", createdBy: "dana", key: "PLT", name: "Platform" });
    const runtime = await svc.create({ tenant: "acme", createdBy: "dana", key: "RNT", name: "Runtime" });
    const nested = await svc.update("acme", "RNT", { parentId: "PLT" }, DANA);
    expect(nested.id).toBe(runtime.id);
    expect(nested.parentId).toBe(platform.id);
  });
});

describe("TeamService — private teams are a VISIBILITY filter, never an authz axis", () => {
  let ctx: ReturnType<typeof service>;
  beforeEach(() => {
    ctx = service();
  });

  it("returns no filter at all when nothing is private — an undefined answer means 'see everything'", async () => {
    await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    expect(await ctx.svc.visibleTeamIds("acme", "erin", false)).toBeUndefined();
  });

  it("hides a private team from a non-member, and keeps the public ones", async () => {
    const open = await ctx.svc.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Eng" });
    const secret = await ctx.svc.create({
      tenant: "acme",
      createdBy: "dana",
      key: "SEC",
      name: "Security",
      isPrivate: true,
    });
    // Given: erin is on neither roster (dana created both, so dana is on both)
    const visible = await ctx.svc.visibleTeamIds("acme", "erin", false);
    expect(visible).toEqual([open.id]);
    expect(await ctx.svc.canSeeTeam("acme", secret.id, "erin", false)).toBe(false);
    // The creator is on the roster, so they still see it.
    expect(await ctx.svc.canSeeTeam("acme", secret.id, "dana", false)).toBe(true);
  });

  it("shows everything to an admin — hiding it from someone who can join in one click is theatre", async () => {
    const secret = await ctx.svc.create({
      tenant: "acme",
      createdBy: "dana",
      key: "SEC",
      name: "Security",
      isPrivate: true,
    });
    expect(await ctx.svc.visibleTeamIds("acme", "erin", true)).toBeUndefined();
    expect(await ctx.svc.canSeeTeam("acme", secret.id, "erin", true)).toBe(true);
  });
});
