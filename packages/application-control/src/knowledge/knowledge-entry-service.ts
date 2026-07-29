import {
  ConflictError,
  ForbiddenError,
  type KnowledgeEntryExtraction,
  type KnowledgeEntryKind,
  type KnowledgeEntryRecord,
  type KnowledgeEntryStatus,
  type KnowledgeEntryVisibility,
  type NodeRef,
  NotFoundError,
} from "@everdict/contracts";
import type { Coverage } from "@everdict/domain";
import { readKnowledgeBody, removeKnowledgeBody, writeKnowledgeBody } from "../fs/content-projection.js";
import { memberActor } from "../fs/revisioned-workspace-fs.js";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";
import {
  type LatestVersionResolver,
  extendPinCoverage,
  mergePinCoverage,
  resolveCoverage,
} from "./freshness-resolver.js";

// Knowledge-entry CRUD — reified claims, the knowledge layer's record (docs/architecture/knowledge-graph.md §The
// knowledge layer). Dual-scoped and gated exactly like Skills: `private` = a personal draft (creator-only, non-creator
// sees 404), `workspace` = shared knowledge (read by any member, managed creator-or-admin). `supersedes` records
// revision lineage on the NEW entry only — it deliberately does NOT flip the old entry's status (that write is gated
// like any other management op; auto-flipping would let a non-manager bypass the gate). When a resolver is injected,
// list/get decorate each entry with its freshness (superseded refs / unverified age) — a decoration, never a failure.
export interface CreateKnowledgeEntryInput {
  tenant: string;
  createdBy: string;
  kind: KnowledgeEntryKind;
  title: string;
  body: string;
  refs?: NodeRef[]; // what the claim concerns (version-pinned → `about` edges)
  evidence?: NodeRef[]; // what backs it (→ `evidenced_by` edges)
  supersedes?: string; // the entry this one revises
  visibility?: KnowledgeEntryVisibility; // defaults to "private" — sharing is an explicit opt-in
}

export interface UpdateKnowledgeEntryInput {
  kind?: KnowledgeEntryKind;
  title?: string;
  body?: string;
  refs?: NodeRef[]; // full replacement when provided (omit to keep as-is)
  evidence?: NodeRef[];
  status?: KnowledgeEntryStatus; // deprecate / mark superseded — an explicit, gated write
  visibility?: KnowledgeEntryVisibility;
}

export interface KnowledgeEntryActor {
  subject: string;
  isAdmin: boolean;
}

// The sentinel author of extraction-born proposals (mirrors COMMENT_AGENT_AUTHOR). Approval transfers authorship to
// the approving member — "promoted to authored on approval" — so the sentinel never owns an active claim.
export const KNOWLEDGE_EXTRACTION_AUTHOR = "everdict:extractor";

// An extraction CANDIDATE — what the extractor proposes from a text surface. Becomes a `proposed` entry awaiting
// review; the source rides in `extraction` (audit) and doubles as the entry's evidence ref.
export interface ProposeKnowledgeEntryInput {
  tenant: string;
  kind: KnowledgeEntryKind;
  title: string;
  body: string;
  refs?: NodeRef[];
  evidence?: NodeRef[];
  extraction: KnowledgeEntryExtraction;
}

export type KnowledgeEntryWithCoverage = KnowledgeEntryRecord & { coverage?: Coverage };

export interface KnowledgeEntryServiceDeps {
  store: KnowledgeEntryStore;
  latestVersionOf?: LatestVersionResolver;
  // The workspace filesystem — when wired, the entry's markdown BODY lives on it as the SSOT
  // (`knowledge/<id>.md`, browsable in the Files page): saves project it FIRST, `get` reads it first (lazy
  // migration of legacy rows + DB re-sync after an out-of-band edit). The DB keeps a full replica so `list`
  // stays one query. Same discipline as SkillService — see that class.
  fs?: WorkspaceFs;
  newId?: () => string;
  now?: () => string;
}

export class KnowledgeEntryService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: KnowledgeEntryServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateKnowledgeEntryInput): Promise<KnowledgeEntryRecord> {
    const ts = this.now();
    const record: KnowledgeEntryRecord = {
      id: this.newId(),
      tenant: input.tenant,
      kind: input.kind,
      title: input.title,
      body: input.body,
      refs: input.refs ?? [],
      evidence: input.evidence ?? [],
      status: "active",
      ...(input.supersedes !== undefined && input.supersedes !== "" ? { supersedes: input.supersedes } : {}),
      visibility: input.visibility ?? "private",
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    // filesystem first; attributed to the author so the body's history names a person, not "the system"
    if (this.deps.fs)
      await writeKnowledgeBody(this.deps.fs, input.tenant, record.id, record.body, memberActor(input.createdBy));
    await this.deps.store.create(record);
    return record;
  }

  // Store an extraction candidate as a `proposed`, workspace-visible entry (every member can review it). Authored by
  // the extractor sentinel until a member approves it.
  async propose(input: ProposeKnowledgeEntryInput): Promise<KnowledgeEntryRecord> {
    const ts = this.now();
    const record: KnowledgeEntryRecord = {
      id: this.newId(),
      tenant: input.tenant,
      kind: input.kind,
      title: input.title,
      body: input.body,
      refs: input.refs ?? [],
      evidence: input.evidence ?? [],
      status: "proposed",
      extraction: input.extraction,
      visibility: "workspace",
      createdBy: KNOWLEDGE_EXTRACTION_AUTHOR,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  // Approve a proposal — the HITL promotion: status `proposed` → `active` AND authorship transfers to the approver
  // (the member now ASSERTS the claim and owns its management; the `extraction` provenance stays for audit). Any
  // member may approve (the route gates the role); a non-proposed entry is a 409, not a silent no-op.
  async approve(tenant: string, id: string, actor: KnowledgeEntryActor): Promise<KnowledgeEntryRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    if (record.status !== "proposed")
      throw new ConflictError("CONFLICT", { id, status: record.status }, "only a proposed entry can be approved.");
    const updated = await this.deps.store.update(tenant, id, {
      status: "active",
      createdBy: actor.subject,
      updatedAt: this.now(),
    });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    return updated;
  }

  // Reject a proposal — deletes it. Only valid on `proposed` (an active claim is removed via the gated `remove`).
  async reject(tenant: string, id: string): Promise<void> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    if (record.status !== "proposed")
      throw new ConflictError("CONFLICT", { id, status: record.status }, "only a proposed entry can be rejected.");
    await this.deps.store.remove(tenant, id);
  }

  // Entries the caller can see — every workspace entry + their own private ones, coverage-decorated.
  async list(tenant: string, subject: string): Promise<KnowledgeEntryWithCoverage[]> {
    return this.decorate(tenant, await this.deps.store.list(tenant, subject));
  }

  async get(tenant: string, id: string, subject: string): Promise<KnowledgeEntryWithCoverage> {
    const stored = await this.deps.store.get(tenant, id);
    if (!stored || (stored.visibility === "private" && stored.createdBy !== subject))
      throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    const record = await this.hydrateFromFs(tenant, stored);
    const [decorated] = await this.decorate(tenant, [record]);
    if (!decorated) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    return decorated;
  }

  // Filesystem-first body resolution (mirror of SkillService.hydrateFromFs): the projection wins when present,
  // a legacy row is migrated onto it, and an out-of-band edit re-syncs the DB replica — all best-effort.
  private async hydrateFromFs(tenant: string, record: KnowledgeEntryRecord): Promise<KnowledgeEntryRecord> {
    const fs = this.deps.fs;
    if (!fs) return record;
    try {
      const body = await readKnowledgeBody(fs, tenant, record.id);
      if (body === undefined) {
        await writeKnowledgeBody(fs, tenant, record.id, record.body);
        return record;
      }
      if (body === record.body) return record;
      await this.deps.store.update(tenant, record.id, { body });
      return { ...record, body };
    } catch {
      return record; // the DB replica keeps the read alive when the filesystem is unreachable
    }
  }

  async update(
    tenant: string,
    id: string,
    patch: UpdateKnowledgeEntryInput,
    actor: KnowledgeEntryActor,
  ): Promise<KnowledgeEntryRecord> {
    const current = await this.manageableOrThrow(tenant, id, actor);
    const next: Partial<KnowledgeEntryRecord> = { updatedAt: this.now() };
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.body !== undefined) next.body = patch.body;
    // Clients author plain NodeRefs; verifiedVersion is system-owned — carried over when the pin is unchanged.
    if (patch.refs !== undefined) next.refs = mergePinCoverage(current.refs, patch.refs);
    if (patch.evidence !== undefined) next.evidence = patch.evidence;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.visibility !== undefined) next.visibility = patch.visibility;
    if (this.deps.fs && patch.body !== undefined) {
      await writeKnowledgeBody(this.deps.fs, tenant, id, patch.body, memberActor(actor.subject)); // same as create
    }
    const updated = await this.deps.store.update(tenant, id, next);
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    return updated;
  }

  async remove(tenant: string, id: string, actor: KnowledgeEntryActor): Promise<void> {
    await this.manageableOrThrow(tenant, id, actor);
    await this.deps.store.remove(tenant, id);
    if (this.deps.fs) await removeKnowledgeBody(this.deps.fs, tenant, id).catch(() => {}); // best-effort cleanup
  }

  // Attest that the claim still holds — a COORDINATE EXTENSION along subject time: each versioned pin's
  // `verifiedVersion` advances to the entity's current latest, plus the wall-clock `verifiedAt`. `updatedAt` stays
  // untouched (a verification is not an edit).
  async verify(tenant: string, id: string, actor: KnowledgeEntryActor): Promise<KnowledgeEntryRecord> {
    const record = await this.manageableOrThrow(tenant, id, actor);
    const resolver = this.deps.latestVersionOf;
    const refs = resolver ? await extendPinCoverage(tenant, record.refs, resolver) : record.refs;
    const updated = await this.deps.store.update(tenant, id, { refs, verifiedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    return updated;
  }

  private async decorate(tenant: string, records: KnowledgeEntryRecord[]): Promise<KnowledgeEntryWithCoverage[]> {
    const resolver = this.deps.latestVersionOf;
    if (resolver === undefined || records.length === 0) return records;
    const coverage = await resolveCoverage(tenant, records, resolver, this.now());
    return records.map((record, i) => {
      const c = coverage[i];
      return c !== undefined ? { ...record, coverage: c } : record;
    });
  }

  // Mirror of the Skill manage gate: private = creator-only (404, no existence leak); workspace = creator-or-admin (403).
  private async manageableOrThrow(
    tenant: string,
    id: string,
    actor: KnowledgeEntryActor,
  ): Promise<KnowledgeEntryRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    if (record.visibility === "private") {
      if (record.createdBy !== actor.subject)
        throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    } else if (record.createdBy !== actor.subject && !actor.isAdmin) {
      throw new ForbiddenError(
        "FORBIDDEN",
        { id },
        "Only the entry's creator or a workspace admin can manage this shared knowledge entry.",
      );
    }
    return record;
  }
}
