import {
  ForbiddenError,
  type NodeRef,
  NotFoundError,
  type SkillFile,
  type SkillRecord,
  type SkillVisibility,
} from "@everdict/contracts";
import type { Coverage } from "@everdict/domain";
import {
  type LatestVersionResolver,
  extendPinCoverage,
  mergePinCoverage,
  resolveCoverage,
} from "../knowledge/freshness-resolver.js";
import type { SkillStore } from "../ports/skill-store.js";

// Workspace Skill CRUD — dual-scoped like browser profiles / Views:
//   - `private` (default) = a personal draft, visible and manageable only by its creator (NO admin override).
//   - `workspace` = a shared asset: read/used by any member (and the agent), managed by the creator or a workspace admin.
// `list` returns what the caller can see (all workspace skills + their own private ones). Members build the workspace's
// skill library up together; "share to workspace" is an explicit visibility promotion. Generation (skill-generate) is
// an apps/api concern (it needs a model completion) — the service only owns persistence + the visibility gates.
export interface CreateSkillInput {
  tenant: string;
  createdBy: string;
  name: string;
  description: string;
  instructions: string;
  files?: SkillFile[]; // supporting reference files (defaults to none)
  refs?: NodeRef[]; // the version-pinned entities the skill documents (→ `about` edges, the staleness contract)
  visibility?: SkillVisibility; // defaults to "private" (personal draft) — sharing is an explicit opt-in
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  instructions?: string;
  files?: SkillFile[]; // full replacement of the file set when provided (omit to keep as-is)
  refs?: NodeRef[]; // full replacement of the pinned refs when provided (omit to keep as-is)
  visibility?: SkillVisibility; // promote private→workspace ("share") or demote workspace→private
}

// Who is acting on a skill — the caller's subject + whether they are a workspace admin (creator-override, mirroring
// browser-profiles / comments:delete). Reads never need it; writes gate on creator-or-admin.
export interface SkillActor {
  subject: string;
  isAdmin: boolean;
}

// A skill decorated with its subject-time coverage — where its known-valid intervals sit relative to the entities'
// PRESENT: `current` / `behind` (as-of an earlier point; validity at the present unknown — not wrong) / `unverified`
// (wall-clock aged). Additive on the wire.
export type SkillWithCoverage = SkillRecord & { coverage?: Coverage };

export interface SkillServiceDeps {
  store: SkillStore;
  // Optional latest-version resolver (composition wires it over the registries). When present, list/get decorate
  // each skill with `coverage`, and verify EXTENDS the pins' known-valid intervals to the entities' current latest.
  latestVersionOf?: LatestVersionResolver;
  newId?: () => string;
  now?: () => string;
}

export class SkillService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: SkillServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateSkillInput): Promise<SkillRecord> {
    const ts = this.now();
    const record: SkillRecord = {
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      files: input.files ?? [],
      refs: input.refs ?? [],
      visibility: input.visibility ?? "private", // personal draft by default — sharing is explicit
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  // Skills the caller can see — every workspace skill + their own private ones, coverage-decorated.
  async list(tenant: string, subject: string): Promise<SkillWithCoverage[]> {
    return this.decorate(tenant, await this.deps.store.list(tenant, subject));
  }

  // A single skill the caller can see — a workspace skill is visible to any member; a private one only to its creator.
  // Otherwise 404 (no existence leak — a foreign private skill is indistinguishable from a missing one).
  async get(tenant: string, id: string, subject: string): Promise<SkillWithCoverage> {
    const record = await this.deps.store.get(tenant, id);
    if (!record || (record.visibility === "private" && record.createdBy !== subject))
      throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    const [decorated] = await this.decorate(tenant, [record]);
    if (!decorated) throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    return decorated;
  }

  async update(tenant: string, id: string, patch: UpdateSkillInput, actor: SkillActor): Promise<SkillRecord> {
    const current = await this.manageableOrThrow(tenant, id, actor); // per-visibility gate before the write
    const next: Partial<SkillRecord> = { updatedAt: this.now() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.instructions !== undefined) next.instructions = patch.instructions;
    if (patch.files !== undefined) next.files = patch.files;
    // Clients author plain NodeRefs; verifiedVersion is system-owned — carried over when the pin is unchanged.
    if (patch.refs !== undefined) next.refs = mergePinCoverage(current.refs, patch.refs);
    if (patch.visibility !== undefined) next.visibility = patch.visibility;
    const updated = await this.deps.store.update(tenant, id, next);
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    return updated;
  }

  // Attest that the procedure still matches reality — a COORDINATE EXTENSION along subject time: each versioned pin's
  // `verifiedVersion` advances to the entity's current latest ("confirmed to hold at this point"), plus the wall-clock
  // `verifiedAt`. `updatedAt` stays untouched (a verification is not an edit). Gated like any management op.
  async verify(tenant: string, id: string, actor: SkillActor): Promise<SkillRecord> {
    const record = await this.manageableOrThrow(tenant, id, actor);
    const resolver = this.deps.latestVersionOf;
    const refs = resolver ? await extendPinCoverage(tenant, record.refs, resolver) : record.refs;
    const updated = await this.deps.store.update(tenant, id, { refs, verifiedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    return updated;
  }

  async remove(tenant: string, id: string, actor: SkillActor): Promise<void> {
    await this.manageableOrThrow(tenant, id, actor);
    await this.deps.store.remove(tenant, id);
  }

  private async decorate(tenant: string, records: SkillRecord[]): Promise<SkillWithCoverage[]> {
    const resolver = this.deps.latestVersionOf;
    if (resolver === undefined || records.length === 0) return records;
    const coverage = await resolveCoverage(tenant, records, resolver, this.now());
    return records.map((record, i) => {
      const c = coverage[i];
      return c !== undefined ? { ...record, coverage: c } : record;
    });
  }

  // The gate for every management op (update/remove): a `private` skill is manageable ONLY by its creator (invisible to
  // everyone else → a non-creator gets 404, no existence leak); a `workspace` skill is manageable by its creator or a
  // workspace admin (visible → a non-manager gets 403).
  private async manageableOrThrow(tenant: string, id: string, actor: SkillActor): Promise<SkillRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    if (record.visibility === "private") {
      if (record.createdBy !== actor.subject) throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    } else if (record.createdBy !== actor.subject && !actor.isAdmin) {
      throw new ForbiddenError(
        "FORBIDDEN",
        { id },
        "Only the skill's creator or a workspace admin can manage this shared skill.",
      );
    }
    return record;
  }
}
