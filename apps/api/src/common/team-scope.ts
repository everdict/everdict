import type { TeamService } from "@everdict/application-control";
import { type Principal, type ResourceScope, canReachTeam, visibleTeams } from "@everdict/auth";
import { NotFoundError } from "@everdict/contracts";

// The READ half of the team axis, shared by both transports (routes + MCP tools). It lives in `common/` rather
// than in route-context because it needs nothing but the principal — and because the MCP tool files cannot import
// route-context without closing a cycle (route-context builds the MCP server).
//
// Ownership ISOLATES: an asset owned by a team the caller is not on is not theirs to read, and the refusal is
// answered exactly like another workspace's row — 404, never 403. "You may not see this" would still confirm that
// a harness by that name, a batch with that id, exists at all.

// One already-identified resource. Reads gate the ROLE first (`gate(principal, "x:read")`, no resource) and the
// OWNER with this, in that order: someone with no read permission at all should hear 403 about the permission,
// not 404 about a row.
export function assertTeamVisible(principal: Principal, resource: ResourceScope | undefined, what: string): void {
  if (canReachTeam(principal, resource)) return;
  throw new NotFoundError("NOT_FOUND", { team: resource?.teamId }, `${what} not found.`);
}

// The ceiling a LIST read stays under — `undefined` for an admin or a machine credential (no narrowing), else the
// caller's teams (`[]` for someone on no team, which honestly returns only the workspace's unowned rows).
// Stores take it as `visibleTeams`; a service holding one row asks `ownedByVisibleTeam` with the same value.
export function visibleTeamsFor(principal: Principal): string[] | undefined {
  return visibleTeams(principal);
}

// The same ceiling in spread form, for the filter/options objects that carry it as an optional field — `{}` when
// there is no ceiling, so an absent key never reads as "narrow to nothing".
export function teamCeiling(principal: Principal): { visibleTeams?: string[] } {
  const teams = visibleTeams(principal);
  return teams === undefined ? {} : { visibleTeams: teams };
}

// ── Ownership resolution for the versioned registries ────────────────────────────────────────────────────────
// A versioned registry entry records its owning team beside created_by. These resolve it for gate(); a registry
// that predates the column (or a `_shared`/seeded row) answers undefined, which the kernel reads as "unowned" and
// lets through — never as "everyone's".
type TeamAware = {
  teamOfVersion?(tenant: string, id: string, version: string): string | undefined | Promise<string | undefined>;
  ownVersions?(tenant: string, id: string): string[] | Promise<string[]>;
};

// The team that owns one VERSION.
export async function teamOfVersion(
  registry: TeamAware | undefined,
  tenant: string,
  id: string,
  version: string,
): Promise<ResourceScope> {
  const teamId = await registry?.teamOfVersion?.(tenant, id, version);
  return teamId === undefined ? {} : { teamId };
}

// The READ guard for a registry-backed entity: another team's harness/dataset/judge/rubric is answered 404, the
// same as one that does not exist. Asked of the ENTITY rather than the version, so a caller cannot see version 3
// of something whose ownership they cannot reach just because version 3 predates the axis.
export async function assertEntityVisible(
  principal: Principal,
  registry: TeamAware | undefined,
  tenant: string,
  id: string,
  what: string,
): Promise<void> {
  assertTeamVisible(principal, await teamOfEntity(registry, tenant, id), what);
}

// The team that owns an ENTITY — read off its newest own version, because ownership belongs to the thing, not to
// one release of it. Used by routes that mutate an id without naming a version (re-pin, tag edits).
export async function teamOfEntity(
  registry: TeamAware | undefined,
  tenant: string,
  id: string,
): Promise<ResourceScope> {
  const versions = (await registry?.ownVersions?.(tenant, id)) ?? [];
  const newest = versions[versions.length - 1];
  return newest === undefined ? {} : teamOfVersion(registry, tenant, id, newest);
}

// Everything below needs the team roster, and nothing more of the deps bag — both ServerDeps and McpDeps
// satisfy this structurally, which is what lets the two transports share one answer.
interface TeamResolvingDeps {
  teamService?: TeamService;
}

// Who a NEWLY created asset will belong to, and what the gate should check.
//
// Two different questions, deliberately separated:
//   · `teamId` — the owner it WILL get. A caller on no team still creates things; the asset lands in the
//     workspace's default team, the same rule an issue follows when no team is named. Creating must not require
//     already belonging somewhere, or a fresh member can do nothing.
//   · `gate` — what to authorize. Only an EXPLICIT choice is authorized, because only that is a claim about
//     another team; an implicit fallback is not the caller asserting anything. And an explicit choice the caller
//     may not make is REFUSED, never quietly redirected to their own team — silently rewriting where something
//     lands is how a mistyped id looks like it worked.
export async function teamForNew(
  principal: Principal,
  deps: TeamResolvingDeps,
  requested?: string,
): Promise<{ teamId?: string; gate: ResourceScope }> {
  if (requested !== undefined) {
    // Resolved before it is gated: the caller may name the team by key (`ENG`), and comparing a key against the
    // id list a principal carries would refuse a member of the very team they named.
    const teamId = await resolveTeamRef(deps, principal.workspace, requested);
    return { teamId, gate: { teamId } };
  }
  const own = principal.teams?.[0];
  if (own !== undefined) return { teamId: own, gate: {} };
  const all = (await deps.teamService?.list(principal.workspace).catch(() => [])) ?? [];
  const preferred = all.find((team) => team.isDefault) ?? all[0];
  return preferred ? { teamId: preferred.id, gate: {} } : { gate: {} };
}

// A team-shaped URL segment or query value → the team id a store/registry indexes by. A team is addressed by its
// id OR by its key (`ENG`), the same way an issue is addressed by `ENG-12`: the resolution lives in TeamService
// so every transport accepts both, and this is the one line a route needs to opt in. An unknown ref 404s rather
// than passing through — a filter that keeps a bad ref answers with an empty list, which reads as "this team has
// nothing" instead of "no such team". A deployment with no team service keeps the ref verbatim (nothing to
// resolve against), so team-less compositions behave exactly as before.
export async function resolveTeamRef(deps: TeamResolvingDeps, tenant: string, ref: string): Promise<string> {
  if (!deps.teamService) return ref;
  return deps.teamService.resolveId(tenant, ref);
}
