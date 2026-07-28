import {
  ForbiddenError,
  type KnowledgeEntryKind,
  type KnowledgeEntryRecord,
  type KnowledgeEntryStatus,
  type KnowledgeEntryVisibility,
  type NodeRef,
  NotFoundError,
} from "@everdict/contracts";
import type { Freshness } from "@everdict/domain";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";
import { type LatestVersionResolver, resolveFreshness } from "./freshness-resolver.js";

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

export type KnowledgeEntryWithFreshness = KnowledgeEntryRecord & { freshness?: Freshness };

export interface KnowledgeEntryServiceDeps {
  store: KnowledgeEntryStore;
  latestVersionOf?: LatestVersionResolver;
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
    await this.deps.store.create(record);
    return record;
  }

  // Entries the caller can see — every workspace entry + their own private ones, freshness-decorated.
  async list(tenant: string, subject: string): Promise<KnowledgeEntryWithFreshness[]> {
    return this.decorate(tenant, await this.deps.store.list(tenant, subject));
  }

  async get(tenant: string, id: string, subject: string): Promise<KnowledgeEntryWithFreshness> {
    const record = await this.deps.store.get(tenant, id);
    if (!record || (record.visibility === "private" && record.createdBy !== subject))
      throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    const [decorated] = await this.decorate(tenant, [record]);
    if (!decorated) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    return decorated;
  }

  async update(
    tenant: string,
    id: string,
    patch: UpdateKnowledgeEntryInput,
    actor: KnowledgeEntryActor,
  ): Promise<KnowledgeEntryRecord> {
    await this.manageableOrThrow(tenant, id, actor);
    const next: Partial<KnowledgeEntryRecord> = { updatedAt: this.now() };
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.body !== undefined) next.body = patch.body;
    if (patch.refs !== undefined) next.refs = patch.refs;
    if (patch.evidence !== undefined) next.evidence = patch.evidence;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.visibility !== undefined) next.visibility = patch.visibility;
    const updated = await this.deps.store.update(tenant, id, next);
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    return updated;
  }

  async remove(tenant: string, id: string, actor: KnowledgeEntryActor): Promise<void> {
    await this.manageableOrThrow(tenant, id, actor);
    await this.deps.store.remove(tenant, id);
  }

  // Attest that the claim still holds — stamps `verifiedAt` WITHOUT touching `updatedAt` (a verification is not an
  // edit; the freshness baseline is the later of the two).
  async verify(tenant: string, id: string, actor: KnowledgeEntryActor): Promise<KnowledgeEntryRecord> {
    await this.manageableOrThrow(tenant, id, actor);
    const updated = await this.deps.store.update(tenant, id, { verifiedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `knowledge entry '${id}' not found.`);
    return updated;
  }

  private async decorate(tenant: string, records: KnowledgeEntryRecord[]): Promise<KnowledgeEntryWithFreshness[]> {
    const resolver = this.deps.latestVersionOf;
    if (resolver === undefined || records.length === 0) return records;
    const freshness = await resolveFreshness(tenant, records, resolver, this.now());
    return records.map((record, i) => {
      const f = freshness[i];
      return f !== undefined ? { ...record, freshness: f } : record;
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
