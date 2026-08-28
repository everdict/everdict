import type { TeamService } from "@everdict/application-control";
import type { Principal, ResourceScope } from "@everdict/auth";
import { NotFoundError } from "@everdict/contracts";

// The READ half of the team axis, shared by both transports (routes + MCP tools). It lives in `common/` rather
// than in route-context because the MCP tool files cannot import route-context without closing a cycle
// (route-context builds the MCP server).
//
// **Reads are decided by team PRIVACY, not by membership.** A workspace whose teams cannot see each other's work
// has stopped being one workspace, so what a team owns is visible by default and `isPrivate` is the explicit,
// per-team opt-in that hides it — the rule the tracker already followed, now the only rule. Membership still
// decides WRITING (`canReachTeam`, the kernel): a team's work is theirs to change.
//
// `TeamService.visibleTeamIds` is the ONE place privacy is decided, and `undefined` from it means "nothing is
// hidden" — never "no teams", which is the failure mode a `[]` would silently produce.

// Everything here needs the team roster and nothing more of the deps bag — both ServerDeps and McpDeps satisfy
// this structurally, which is what lets the two transports share one answer.
interface TeamResolvingDeps {
  teamService?: TeamService;
}

// The teams whose work this caller may READ — `undefined` when nothing is hidden (no private team exists, the
// caller is an admin, or this deployment composes no team service at all).
export async function visibleTeamsFor(deps: TeamResolvingDeps, principal: Principal): Promise<string[] | undefined> {
  if (!deps.teamService) return undefined;
  return deps.teamService.visibleTeamIds(principal.workspace, principal.subject, principal.roles.includes("admin"));
}

// The same ceiling in spread form, for the filter/options objects that carry it as an optional field — `{}` when
// there is no ceiling, so an absent key never reads as "narrow to nothing".
export async function teamCeiling(deps: TeamResolvingDeps, principal: Principal): Promise<{ visibleTeams?: string[] }> {
  const teams = await visibleTeamsFor(deps, principal);
  return teams === undefined ? {} : { visibleTeams: teams };
}

// One already-identified resource. A refusal is answered 404, never 403: a private team must not be discoverable
// by the shape of the error, which is the same no-existence-leak rule a cross-workspace read follows.
export async function assertTeamVisible(
  deps: TeamResolvingDeps,
  principal: Principal,
  teamId: string | undefined,
  what: string,
): Promise<void> {
  if (teamId === undefined || !deps.teamService) return; // unowned = the workspace's
  const visible = await deps.teamService.canSeeTeam(
    principal.workspace,
    teamId,
    principal.subject,
    principal.roles.includes("admin"),
  );
  if (!visible) throw new NotFoundError("NOT_FOUND", { team: teamId }, `${what} not found.`);
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

// The READ guard for a registry-backed entity: a PRIVATE team's harness/dataset/judge/rubric is answered 404, the
// same as one that does not exist. Asked of the ENTITY rather than the version, so ownership is one answer per
// thing rather than one per release.
export async function assertEntityVisible(
  deps: TeamResolvingDeps,
  principal: Principal,
  registry: TeamAware | undefined,
  tenant: string,
  id: string,
  what: string,
): Promise<void> {
  const owner = await teamOfEntity(registry, tenant, id);
  await assertTeamVisible(deps, principal, owner.teamId, what);
}

// The team that owns an ENTITY — read off its newest own version, because ownership belongs to the thing, not to
// one release of it. Used by routes that mutate an id without naming a version (re-pin, tag edits).
export async function teamOfEntity(
  registry: TeamAware | undefined,
  tenant: string,
  id: string,
): Promise<ResourceScope> {
  // ── AN ABSENT REGISTRY IS NOT AN UNOWNED ENTITY (arch-review 119) ────────────────────────────────
  //
  // This answered `{}` — the PERMISSIVE arm — when `registry` was undefined, so a composition that wired a
  // service without its registry turned every write gate into a workspace-level one. `pnpm authz-optional`
  // cannot see it: that scanner reads the ARGUMENTS of an authz call, and the widening happens one frame
  // out, in the value the call is later handed. Its own header names the limitation.
  //
  // Production wires them together (`new AgentService({ agents: agentRegistry })`), so this refusal changes
  // nothing there. What it changes is a FIXTURE that omits the registry: it now fails loudly instead of
  // taking the weak branch silently, which is the drift this repository has already paid for.
  //
  // Refusing is the scanner's own first prescription for an absent capability, and 404 is the shape every
  // sibling route already answers with when a dependency is not configured.
  if (registry === undefined)
    throw new NotFoundError("NOT_FOUND", { id }, "this resource's registry is not configured.");
  const versions = (await registry.ownVersions?.(tenant, id)) ?? [];
  const newest = versions[versions.length - 1];
  return newest === undefined ? {} : teamOfVersion(registry, tenant, id, newest);
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
  // ── A ROSTER WE COULD NOT READ IS NOT AN EMPTY ROSTER (arch-review 119) ─────────────────────────
  //
  // This was `.catch(() => [])`, and the fallback below turns an empty list into "no owner" — so a roster
  // read that FAILED born the asset unowned, which is writable by every team and hidden from none. That is
  // L2's "a teardown that widens because it read nothing", with the widening being an ownership boundary.
  //
  // The absence that legitimately means "no team axis here" is `teamService` being undefined — a composition
  // fact, known without a read. A read that threw is the third value, and refusing is its fail-closed side:
  // both transports call this inside a try that answers the caller, so nothing is created and nothing is
  // silently shared.
  if (!deps.teamService) return { gate: {} };
  const all = await deps.teamService.list(principal.workspace);
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
