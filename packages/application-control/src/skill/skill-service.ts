import {
  BadRequestError,
  type CapabilityRecord,
  ConflictError,
  ForbiddenError,
  InternalError,
  type NodeRef,
  NotFoundError,
  type SkillFile,
  type SkillOrigin,
  type SkillRecord,
  type SkillVersionRecord,
  type SkillVisibility,
} from "@everdict/contracts";
import { type Coverage, type VersionBump, bumpVersion, compareVersions } from "@everdict/domain";
import {
  readSkillContent,
  removeSkillContent,
  skillContentEquals,
  writeSkillContent,
} from "../fs/content-projection.js";
import { memberActor } from "../fs/revisioned-workspace-fs.js";
import {
  type LatestVersionResolver,
  extendPinCoverage,
  mergePinCoverage,
  resolveCoverage,
} from "../knowledge/freshness-resolver.js";
import type { SkillStore } from "../ports/skill-store.js";
import type { SkillVersionStore } from "../ports/skill-version-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

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

// Take a copy of a store publication into this workspace's library. Everdict's managed skills — and any skill another
// workspace published — are EXAMPLES: importing snapshots the content into a workspace SkillRecord the members own
// outright. No live link back, deliberately: the moment they edit it, a link would either fight their edits or lie.
export interface ImportSkillInput {
  tenant: string; // the importing workspace
  subject: string; // who is importing (becomes the copy's creator)
  source: string; // the publishing workspace ("_everdict" for a managed example)
  id: string; // the capability id
  version?: string; // the exact version to copy (default: latest)
  visibility?: SkillVisibility; // defaults to `workspace` — an example is taken FOR the team, not as a private draft
}

// Name the current content as a version. `version` wins over `bump` when given, and must order above the current one
// (a version line only moves forward — that is what makes an older stamp citable).
export interface StampSkillVersionInput {
  bump?: VersionBump; // default "patch"
  version?: string; // an explicit version instead of a bump
  note?: string; // why this version exists, in the stamper's words
}

// The slice of the capability store an import needs — "give me this publication, if this caller may have it".
// CapabilityService satisfies it structurally; keeping it narrow keeps skills from depending on the whole store.
export interface StoreCapabilityReader {
  get(viewerTenant: string, id: string, subject: string, ref?: string, source?: string): Promise<CapabilityRecord>;
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
  // The workspace filesystem — when wired, skill CONTENT (instructions + supporting files) lives on it as the
  // SSOT (`skills/<id>/SKILL.md` + `skills/<id>/files/*`, browsable in the Files page and editable by agents):
  // saves project the filesystem FIRST (a failed projection fails the save), `get` reads it first — lazily
  // migrating a legacy DB-only row onto it and re-syncing the DB replica after an out-of-band filesystem edit.
  // The DB row keeps a full replica so `list` stays one query and filesystem-less processes keep working.
  fs?: WorkspaceFs;
  // The skills' version line. Absent ⇒ stamping/reading versions is unavailable (the working copy still works) —
  // dev wirings and the agent runtime, which never version anything, stay unchanged.
  versions?: SkillVersionStore;
  // The store, for importing a published skill as a copy. Absent ⇒ import is unavailable.
  capabilities?: StoreCapabilityReader;
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
    return this.persist(
      {
        id: this.newId(),
        tenant: input.tenant,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        files: input.files ?? [],
        refs: input.refs ?? [],
        visibility: input.visibility ?? "private", // personal draft by default — sharing is explicit
        version: "1.0.0", // every skill starts a version line; a stamp names the next point on it
        createdBy: input.createdBy,
        createdAt: ts,
        updatedAt: ts,
      },
      "Initial version.",
    );
  }

  // Copy a store publication into this workspace's library. The result is an ORDINARY workspace skill — same record,
  // same editing, same version line — carrying only `origin` to say where it came from. The copy's line starts at the
  // version it was taken from, so "we're on the example's 1.0.0" and "we've moved to our own 1.1.0" are both readable.
  async importFromStore(input: ImportSkillInput): Promise<SkillRecord> {
    const reader = this.deps.capabilities;
    if (!reader)
      throw new InternalError(
        "UPSTREAM_MISCONFIGURED",
        { id: input.id },
        "The capability store is not wired on this deployment.",
      );
    // Not visible to this caller → the reader throws NOT_FOUND, which is what a non-existent publication looks like.
    const capability = await reader.get(input.tenant, input.id, input.subject, input.version ?? "latest", input.source);
    if (capability.spec.type !== "skill")
      throw new BadRequestError(
        "BAD_REQUEST",
        { id: input.id, type: capability.spec.type },
        `'${input.id}' is a ${capability.spec.type} capability — only skill publications can be imported into the skill library.`,
      );
    const origin: SkillOrigin = {
      source: capability.tenant,
      id: capability.id,
      version: capability.version,
      name: capability.name,
    };
    const already = (await this.deps.store.list(input.tenant, input.subject)).find(
      (s) => s.origin?.source === origin.source && s.origin.id === origin.id,
    );
    if (already)
      throw new ConflictError(
        "CONFLICT",
        { id: already.id, source: origin.source },
        `this workspace already took '${origin.id}' — it lives here as skill '${already.name}'.`,
      );
    const ts = this.now();
    return this.persist(
      {
        id: this.newId(),
        tenant: input.tenant,
        name: capability.name,
        description: capability.description,
        instructions: capability.spec.instructions,
        files: capability.spec.files,
        refs: [],
        visibility: input.visibility ?? "workspace", // taken FOR the team by default
        version: capability.version,
        origin,
        createdBy: input.subject,
        createdAt: ts,
        updatedAt: ts,
      },
      `Copied from ${origin.source}/${origin.id}@${origin.version}.`,
    );
  }

  // Write a brand-new skill: filesystem first (a failed projection means no DB row — the SSOT is never silently
  // stale), then the row, then the opening point of its version line.
  private async persist(record: SkillRecord, note: string): Promise<SkillRecord> {
    if (this.deps.fs) {
      await writeSkillContent(
        this.deps.fs,
        record.tenant,
        record.id,
        { instructions: record.instructions, files: record.files },
        memberActor(record.createdBy), // the author owns this revision, not "the system"
      );
    }
    await this.deps.store.create(record);
    // History, not SSOT: a version line that cannot be written must not undo a skill that already exists.
    await this.snapshot(record, record.version, record.createdBy, note).catch(() => {});
    return record;
  }

  // Freeze content as one immutable point on the line. Throws ConflictError if that version is already stamped.
  private async snapshot(
    record: SkillRecord,
    version: string,
    stampedBy: string,
    note?: string,
  ): Promise<SkillVersionRecord | undefined> {
    const versions = this.deps.versions;
    if (!versions) return undefined;
    const stamped: SkillVersionRecord = {
      skillId: record.id,
      tenant: record.tenant,
      version,
      name: record.name,
      description: record.description,
      instructions: record.instructions,
      files: record.files,
      refs: record.refs,
      ...(note !== undefined ? { note } : {}),
      stampedBy,
      stampedAt: this.now(),
    };
    await versions.stamp(stamped);
    return stamped;
  }

  // Skills the caller can see — every workspace skill + their own private ones, coverage-decorated.
  async list(tenant: string, subject: string): Promise<SkillWithCoverage[]> {
    return this.decorate(tenant, await this.deps.store.list(tenant, subject));
  }

  // A single skill the caller can see — a workspace skill is visible to any member; a private one only to its creator.
  // Otherwise 404 (no existence leak — a foreign private skill is indistinguishable from a missing one).
  async get(tenant: string, id: string, subject: string): Promise<SkillWithCoverage> {
    const stored = await this.deps.store.get(tenant, id);
    if (!stored || (stored.visibility === "private" && stored.createdBy !== subject))
      throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    const record = await this.hydrateFromFs(tenant, stored);
    const [decorated] = await this.decorate(tenant, [record]);
    if (!decorated) throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    return decorated;
  }

  // Filesystem-first content resolution for a detail read: the projection wins when present (an out-of-band edit —
  // shell, agent write_file — re-syncs the DB replica right here); a legacy DB-only row is migrated onto the
  // filesystem on first read (best-effort — a read must not fail because object storage hiccuped).
  private async hydrateFromFs(tenant: string, record: SkillRecord): Promise<SkillRecord> {
    const fs = this.deps.fs;
    if (!fs) return record;
    try {
      const content = await readSkillContent(fs, tenant, record.id);
      if (!content) {
        // Backfilling a legacy DB-only row onto the filesystem is machinery, not authorship — deliberately no
        // actor, so the history reads "system" instead of crediting whoever happened to open the page.
        await writeSkillContent(fs, tenant, record.id, { instructions: record.instructions, files: record.files });
        return record;
      }
      if (skillContentEquals(content, { instructions: record.instructions, files: record.files })) return record;
      await this.deps.store.update(tenant, record.id, { instructions: content.instructions, files: content.files });
      return { ...record, instructions: content.instructions, files: content.files };
    } catch {
      return record; // the DB replica keeps the read alive when the filesystem is unreachable
    }
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
    if (this.deps.fs && (patch.instructions !== undefined || patch.files !== undefined)) {
      // filesystem first (same discipline as create): project the merged content before the DB write
      await writeSkillContent(
        this.deps.fs,
        tenant,
        id,
        { instructions: next.instructions ?? current.instructions, files: next.files ?? current.files },
        memberActor(actor.subject),
      );
    }
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
    if (this.deps.fs) await removeSkillContent(this.deps.fs, tenant, id).catch(() => {}); // best-effort cleanup
    // The line of a skill that no longer exists is a leak, and the id could be reused — drop it with the skill.
    await this.deps.versions?.remove(tenant, id).catch(() => {});
  }

  // Name the CURRENT content as the next version — the second half of "edit it in conversation, then stamp it". The
  // content is read filesystem-first, so a body the agent rewrote through the filesystem is what gets frozen, not a
  // stale DB replica. A stamp is not an edit: `updatedAt` stays put, which is exactly what lets a reader tell "there
  // are changes since the last stamp" from "this skill is at its stamped version".
  async stampVersion(
    tenant: string,
    id: string,
    input: StampSkillVersionInput,
    actor: SkillActor,
  ): Promise<{ skill: SkillRecord; stamped: SkillVersionRecord }> {
    if (!this.deps.versions)
      throw new InternalError("UPSTREAM_MISCONFIGURED", { id }, "Skill versioning is not wired on this deployment.");
    const current = await this.hydrateFromFs(tenant, await this.manageableOrThrow(tenant, id, actor));
    const version = input.version ?? bumpVersion(current.version, input.bump ?? "patch");
    if (compareVersions(version, current.version) <= 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { id, version, current: current.version },
        `version '${version}' does not come after the skill's current version '${current.version}'.`,
      );
    const stamped = await this.snapshot(current, version, actor.subject, input.note);
    if (!stamped)
      throw new InternalError("UPSTREAM_MISCONFIGURED", { id }, "Skill versioning is not wired on this deployment.");
    const skill = await this.deps.store.update(tenant, id, { version });
    if (!skill) throw new NotFoundError("NOT_FOUND", { id }, `skill '${id}' not found.`);
    return { skill, stamped };
  }

  // The skill's stamped versions, newest first. Readable by anyone who can read the skill itself.
  async listVersions(tenant: string, id: string, subject: string): Promise<SkillVersionRecord[]> {
    await this.get(tenant, id, subject); // visibility gate (404 for a foreign private skill)
    return (await this.deps.versions?.list(tenant, id)) ?? [];
  }

  // One stamped version's frozen content — what the procedure said at that point.
  async getVersion(tenant: string, id: string, version: string, subject: string): Promise<SkillVersionRecord> {
    await this.get(tenant, id, subject);
    const stamped = await this.deps.versions?.get(tenant, id, version);
    if (!stamped)
      throw new NotFoundError("NOT_FOUND", { id, version }, `version '${version}' of skill '${id}' not found.`);
    return stamped;
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
