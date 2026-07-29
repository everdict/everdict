import {
  type CapabilityRecord,
  type CapabilitySpec,
  type CapabilitySpecDiff,
  type CapabilityType,
  type CapabilityVisibility,
  ForbiddenError,
  type ImageRefClass,
  type ImageRegistryCoordinates,
  type ImageWarning,
  NotFoundError,
} from "@everdict/contracts";
import {
  canConsumeCapability,
  classifyImageRef,
  diffCapabilitySpecs,
  imageWarnings,
  specsEqual,
} from "@everdict/domain";
import type { CapabilityStore } from "../ports/capability-store.js";
import { normalizeVersionTags } from "../version-tag/version-tag-service.js";

// Capability Store CRUD — one discriminated versioned entity (mcp|code|skill|environment) members author, publish at
// a reach tier (private|workspace|subset|public), and adopt into their agent (tool kinds) or consume at
// harness-authoring time (environment). Versioned like the registry entities (immutable versions; a content edit auto
// patch-bumps so `latest` moves while pinned adoptions stay reproducible) but with per-capability VISIBILITY
// (canConsumeCapability, @everdict/domain) instead of the `_shared` fallback. See
// docs/architecture/capability-store.md + docs/architecture/environment-image-store.md.

// The author upsert body — everything but the coordinates (id from the path, version assigned).
export interface CapabilityUpsert {
  name: string;
  description: string;
  spec: CapabilitySpec;
  // Honored only when CREATING a capability (its first version). Editing an existing capability INHERITS the current
  // reach — changing reach is a separate, gated op (setVisibility), so a content edit never silently re-shares.
  visibility?: CapabilityVisibility;
  sharedWith?: string[];
  tags?: string[];
}

export interface SaveCapabilityResult {
  workspace: string;
  id: string;
  version: string;
  created: boolean;
  // Environment kind only, warn-not-block (the harness-registration convention): the image classifies
  // local/unqualified (no pull guarantee off the build machine) or is pinned by a mutable tag.
  imageWarnings?: ImageWarning[];
}

// The dry-run of a save (POST /capabilities/validate) — the same version-assignment + image-classification logic as
// save(), WITHOUT writing. The wizard's review step calls it: it tells the author whether this is a new capability or
// a new version (and which one), the existing live versions, and any environment image warnings (pull readiness).
export interface CapabilityValidation {
  id: string;
  type: CapabilityType;
  willCreate: boolean; // true = save registers a new version; false = identical content (idempotent no-op)
  version: string; // the version save would assign (or the current one when unchanged)
  existingVersions: string[]; // this workspace's live versions of the id (ascending)
  imageWarnings?: ImageWarning[];
}

// The version list of a capability the caller can see — the ascending live versions + the version→tags display map
// (only versions that have tags). `source` is the OWNER workspace (the caller's own, or a cross-tenant public/subset owner).
export interface CapabilityVersions {
  id: string;
  source: string;
  versions: string[];
  versionTags: Record<string, string[]>;
}

// Who is acting — the caller's subject + whether they are a workspace admin. `isAdmin` gates publishing to `public`
// (the one cross-everyone tier) and the creator-override on manage ops; it equals `can(principal, "capabilities:delete")`.
export interface CapabilityActor {
  subject: string;
  isAdmin: boolean;
}

// A read view: the record + (environment kind only) its image classified against the VIEWER's workspace registries —
// viewer-relative provenance (the same ref can be `workspace` for the publisher and `external` for a consumer), so it
// is annotated per read, never persisted. Serves the store's pull-readiness badge (the control plane classifies;
// the web's client-side classify mirror was deleted — the harness `imageClasses` precedent).
export type CapabilityView = CapabilityRecord & { imageClass?: ImageRefClass };

export interface CapabilityServiceDeps {
  store: CapabilityStore;
  // The workspace's registered image-registry coordinates (no secrets) — classifies an environment capability's
  // image at publish time (docs/architecture/environment-image-store.md). Unset = no classification, no warnings.
  registryCoordinates?: (workspace: string) => Promise<ImageRegistryCoordinates[]>;
  // The workspace's namespace in the MANAGED image store, when the deployment runs one. Classified BEFORE the BYO
  // registries: an image we host is not merely "a registry you registered", and only that class means the pull
  // credential is ours to mint. Synchronous — it is a naming rule (imageRepoFor), not a lookup.
  managedCoordinates?: (workspace: string) => ImageRegistryCoordinates | undefined;
  // Instance policy (operator env EVERDICT_ALLOW_MEMBER_PUBLIC_PUBLISH): when true, ANY member — not just an admin —
  // may publish/promote a capability to `public` (the instance-wide catalog). Default false keeps public an
  // admin-only reach. This is a deployment property ("is this a community instance?"), not per-workspace state, so
  // it lives in operator config, not WorkspaceSettings. See docs/architecture/capability-store.md ("public policy").
  allowMemberPublicPublish?: boolean;
  // The first-party (Everdict-authored) default toolset, surfaced in the public catalog so the built-in tools are
  // discoverable/adoptable alongside user-published ones. Injected (not imported) so the service stays test-isolable
  // and the operator can suppress the built-ins from the store. Unset = no built-ins merged.
  firstPartyCatalog?: () => CapabilityRecord[];
  now?: () => string;
}

// Auto version (same rule as agent/model save): semver → patch bump (skip taken), else a "-r<n>" suffix.
function nextVersion(base: string, taken: ReadonlySet<string>): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (m) {
    let patch = Number(m[3]) + 1;
    while (taken.has(`${m[1]}.${m[2]}.${patch}`)) patch += 1;
    return `${m[1]}.${m[2]}.${patch}`;
  }
  let n = 2;
  while (taken.has(`${base}-r${n}`)) n += 1;
  return `${base}-r${n}`;
}

const contentEqual = (record: CapabilityRecord, body: CapabilityUpsert): boolean =>
  specsEqual(
    { name: record.name, description: record.description, spec: record.spec },
    { name: body.name, description: body.description, spec: body.spec },
  );

// The reach a first version gets when the author didn't say. The TOOL kinds are personal until shared — an adopted
// mcp/code/skill capability runs inside ONE member's agent, so `private` is the honest default. An `environment` is
// not a tool: it is the image a HARNESS pins, consumed workspace-wide (WorkspaceSettings.adoptedEnvironments, not
// AgentSpec.capabilities), and a private one is invisible to the very team that has to run the eval. The web's
// environment editor already defaults to `workspace`; this makes the API/MCP path (an agent registering the image a
// member just pushed) agree instead of quietly creating a team asset nobody else can see.
function defaultVisibilityFor(spec: CapabilitySpec): CapabilityVisibility {
  return spec.type === "environment" ? "workspace" : "private";
}

export class CapabilityService {
  private readonly now: () => string;

  constructor(private readonly deps: CapabilityServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // May this actor publish/promote to `public`? An admin always may; a plain member only when the instance opts in
  // (operator policy). The one authority for the public-reach gate — both save() and setVisibility() consult it.
  private mayPublishPublic(actor: CapabilityActor): boolean {
    return actor.isAdmin || this.deps.allowMemberPublicPublish === true;
  }

  // Version-free upsert (the author "publish/edit" path). New id → 1.0.0; an owner's changed content → next patch
  // version (a new immutable version, `latest` moves); unchanged content → idempotent no-op. Only the capability's
  // owner (or an admin) may publish a new version; publishing a brand-new capability as `public` requires an admin.
  async save(
    tenant: string,
    actor: CapabilityActor,
    id: string,
    body: CapabilityUpsert,
  ): Promise<SaveCapabilityResult> {
    // Computed on every save path (create / new version / idempotent no-op) — the author benefits either way.
    const warnings = await this.environmentImageWarnings(tenant, body.spec);
    const withWarnings = (result: SaveCapabilityResult): SaveCapabilityResult =>
      warnings.length > 0 ? { ...result, imageWarnings: warnings } : result;
    const own = await this.deps.store.versions(tenant, id);
    if (own.length > 0) {
      const latest = await this.deps.store.get(tenant, id, "latest");
      if (!latest) throw new NotFoundError("NOT_FOUND", { id }, `capability '${id}' not found.`);
      if (latest.createdBy !== actor.subject && !actor.isAdmin)
        throw new ForbiddenError(
          "FORBIDDEN",
          { id, action: "capabilities:write" },
          "Only the capability's owner or a workspace admin can publish a new version.",
        );
      if (contentEqual(latest, body))
        return withWarnings({ workspace: tenant, id, version: latest.version, created: false });
      const version = nextVersion(latest.version, new Set(own));
      await this.deps.store.register({
        id,
        tenant,
        version,
        name: body.name,
        description: body.description,
        spec: body.spec,
        visibility: latest.visibility, // reach inherited — change it via setVisibility, not a content edit
        sharedWith: latest.sharedWith,
        tags: body.tags ?? latest.tags,
        createdBy: actor.subject,
        createdAt: this.now(),
      });
      return withWarnings({ workspace: tenant, id, version, created: true });
    }
    const visibility = body.visibility ?? defaultVisibilityFor(body.spec);
    if (visibility === "public" && !this.mayPublishPublic(actor))
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "capabilities:write" },
        "Publishing a capability publicly requires a workspace admin.",
      );
    await this.deps.store.register({
      id,
      tenant,
      version: "1.0.0",
      name: body.name,
      description: body.description,
      spec: body.spec,
      visibility,
      sharedWith: body.sharedWith ?? [],
      tags: body.tags ?? [],
      createdBy: actor.subject,
      createdAt: this.now(),
    });
    return withWarnings({ workspace: tenant, id, version: "1.0.0", created: true });
  }

  // Dry-run of save (no write) — predict the version assignment and surface environment image warnings so the wizard
  // can show a truthful review step. Mirrors save()'s version logic exactly (new id → 1.0.0; changed content → next
  // patch; unchanged → the current version, willCreate=false). Spec validity is the route's concern (Zod parse).
  async validate(
    tenant: string,
    id: string,
    body: { name: string; description: string; spec: CapabilitySpec },
  ): Promise<CapabilityValidation> {
    const imageWarnings = await this.environmentImageWarnings(tenant, body.spec);
    const withWarnings = <T extends object>(v: T): T => (imageWarnings.length > 0 ? { ...v, imageWarnings } : v);
    const existingVersions = await this.deps.store.versions(tenant, id);
    const base = { id, type: body.spec.type, existingVersions };
    if (existingVersions.length === 0) return withWarnings({ ...base, willCreate: true, version: "1.0.0" });
    const latest = await this.deps.store.get(tenant, id, "latest");
    if (!latest) return withWarnings({ ...base, willCreate: true, version: "1.0.0" });
    if (contentEqual(latest, body)) return withWarnings({ ...base, willCreate: false, version: latest.version });
    return withWarnings({
      ...base,
      willCreate: true,
      version: nextVersion(latest.version, new Set(existingVersions)),
    });
  }

  // Classify an environment capability's image against the workspace's registered registries — warn-not-block, so a
  // coordinates failure (or an unset provider) yields no warnings, never a blocked publish.
  private async environmentImageWarnings(tenant: string, spec: CapabilitySpec): Promise<ImageWarning[]> {
    if (spec.type !== "environment" || !this.deps.registryCoordinates) return [];
    try {
      return imageWarnings([spec.image], await this.deps.registryCoordinates(tenant), this.managed(tenant));
    } catch {
      return [];
    }
  }

  // Browse "my store" — own visible + subset shared to me (excludes the global public catalog).
  async list(tenant: string, subject: string): Promise<CapabilityView[]> {
    return this.annotate(tenant, await this.deps.store.listVisible(tenant, subject));
  }

  // Browse the global public catalog — the first-party (Everdict-authored) built-ins FIRST, then every user-published
  // `public` capability. Built-ins are code-defined (not DB rows), so they are merged in here rather than stored; this
  // is what makes "the same tool, two channels: default + marketplace" true in the store surface (a workspace can
  // adopt a built-in explicitly, or leave it on as a default via Settings › Agent). `viewerTenant` classifies
  // environment images for the CALLER's workspace.
  async listPublic(viewerTenant?: string): Promise<CapabilityView[]> {
    const builtIns = this.deps.firstPartyCatalog?.() ?? [];
    return this.annotate(viewerTenant, [...builtIns, ...(await this.deps.store.listPublic())]);
  }

  // A single capability the caller can see (latest or an exact version). `source` reads a cross-tenant public/subset
  // OWNER (defaults to the caller's own workspace) — so the store's version switcher can inspect an older version of a
  // public capability owned by another workspace. Not visible / missing → 404 (no existence leak — a foreign private
  // capability is indistinguishable from a missing one). The image class is always annotated for the VIEWER's workspace.
  async get(
    viewerTenant: string,
    id: string,
    subject: string,
    ref = "latest",
    source?: string,
  ): Promise<CapabilityView> {
    const owner = source ?? viewerTenant;
    const record = await this.deps.store.get(owner, id, ref);
    if (!record || !canConsumeCapability(record, { tenant: viewerTenant, subject }))
      throw new NotFoundError("NOT_FOUND", { id, version: ref }, `capability '${id}' not found.`);
    const [view] = await this.annotate(viewerTenant, [record]);
    if (!view) throw new NotFoundError("NOT_FOUND", { id, version: ref }, `capability '${id}' not found.`);
    return view;
  }

  // Attach the viewer-relative image class to environment records — best-effort (a coordinates failure or an unset
  // provider annotates nothing; browsing never fails on registry lookup).
  private async annotate(viewerTenant: string | undefined, records: CapabilityRecord[]): Promise<CapabilityView[]> {
    if (viewerTenant === undefined || !records.some((r) => r.spec.type === "environment")) return records;
    let coordinates: ImageRegistryCoordinates[];
    try {
      coordinates = (await this.deps.registryCoordinates?.(viewerTenant)) ?? [];
    } catch {
      coordinates = [];
    }
    const managed = this.managed(viewerTenant);
    return records.map((r) =>
      r.spec.type === "environment" ? { ...r, imageClass: classifyImageRef(r.spec.image, coordinates, managed) } : r,
    );
  }

  // The viewer's managed-store coordinates, best-effort like every other classification input — a provider that
  // throws must not turn browsing the store into an error.
  private managed(tenant: string): ImageRegistryCoordinates | undefined {
    try {
      return this.deps.managedCoordinates?.(tenant);
    } catch {
      return undefined;
    }
  }

  // Change a capability's reach (capability-level metadata, across every live version). Owner-or-admin; promoting to
  // `public` additionally requires an admin (the one expose-to-everyone tier).
  async setVisibility(
    tenant: string,
    id: string,
    next: { visibility: CapabilityVisibility; sharedWith: string[] },
    actor: CapabilityActor,
  ): Promise<CapabilityRecord> {
    const latest = await this.deps.store.get(tenant, id, "latest");
    if (!latest) throw new NotFoundError("NOT_FOUND", { id }, `capability '${id}' not found.`);
    if (latest.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "capabilities:write" },
        "Only the capability's owner or a workspace admin can change its reach.",
      );
    if (next.visibility === "public" && !this.mayPublishPublic(actor))
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "capabilities:write" },
        "Publishing a capability publicly requires a workspace admin.",
      );
    await this.deps.store.setVisibility(tenant, id, next);
    return { ...latest, visibility: next.visibility, sharedWith: next.sharedWith };
  }

  // The live versions of a capability the caller can see, with the version→tags display map. `source` selects a
  // cross-tenant public/subset OWNER (defaults to the caller's own workspace); existence is gated by
  // canConsumeCapability on the latest (a not-visible / missing id → 404, no existence leak) — the same rule as get().
  async listVersions(viewerTenant: string, subject: string, id: string, source?: string): Promise<CapabilityVersions> {
    const owner = source ?? viewerTenant;
    const latest = await this.deps.store.get(owner, id, "latest");
    if (!latest || !canConsumeCapability(latest, { tenant: viewerTenant, subject }))
      throw new NotFoundError("NOT_FOUND", { id }, `capability '${id}' not found.`);
    const [versions, versionTags] = await Promise.all([
      this.deps.store.versions(owner, id),
      this.deps.store.versionTags(owner, id),
    ]);
    return { id, source: owner, versions, versionTags };
  }

  // Structural diff of two versions over the immutable content (name/description/spec). Both refs accept "latest".
  // `source` selects a cross-tenant public/subset OWNER (defaults to the caller's own workspace); each side is
  // visibility-checked (a not-visible / missing version → 404, no existence leak). Reproducible by version immutability.
  async diff(
    viewerTenant: string,
    subject: string,
    id: string,
    base: string,
    candidate: string,
    source?: string,
  ): Promise<CapabilitySpecDiff> {
    const owner = source ?? viewerTenant;
    const [baseRecord, candidateRecord] = await Promise.all([
      this.resolveVisible(viewerTenant, subject, owner, id, base),
      this.resolveVisible(viewerTenant, subject, owner, id, candidate),
    ]);
    return diffCapabilitySpecs(baseRecord, candidateRecord);
  }

  // Resolve a (owner, id, ref) to a record the caller may consume, else 404 (no existence leak) — shared by diff.
  private async resolveVisible(
    viewerTenant: string,
    subject: string,
    owner: string,
    id: string,
    ref: string,
  ): Promise<CapabilityRecord> {
    const record = await this.deps.store.get(owner, id, ref);
    if (!record || !canConsumeCapability(record, { tenant: viewerTenant, subject }))
      throw new NotFoundError("NOT_FOUND", { id, version: ref }, `capability ${id}@${ref} not found.`);
    return record;
  }

  // Replace a single version's tags — mutable metadata outside spec immutability (free labels to tell versions apart,
  // like the registry entities' version tags). The version's creator or a workspace admin (same gate as deleteVersion);
  // own-workspace versions only (another workspace's / missing version → 404). Tags are trimmed/deduped/capped (≤20×60).
  async setVersionTags(
    tenant: string,
    id: string,
    version: string,
    tags: string[],
    actor: CapabilityActor,
  ): Promise<{ workspace: string; id: string; version: string; tags: string[] }> {
    const creator = await this.deps.store.creatorOfVersion(tenant, id, version);
    if (creator === undefined)
      throw new NotFoundError("NOT_FOUND", { id, version }, `capability ${id}@${version} not found.`);
    if (creator !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, version, action: "capabilities:write" },
        "Only the version's creator or a workspace admin can edit this capability version's tags.",
      );
    const normalized = normalizeVersionTags(tags);
    await this.deps.store.setVersionTags(tenant, id, version, normalized);
    return { workspace: tenant, id, version, tags: normalized };
  }

  // Soft-delete a single version — the version's creator or a workspace admin (capabilities:delete). Missing /
  // already-deleted / another workspace's version → 404 (no existence leak).
  async deleteVersion(tenant: string, id: string, version: string, actor: CapabilityActor): Promise<void> {
    const creator = await this.deps.store.creatorOfVersion(tenant, id, version);
    if (creator === undefined)
      throw new NotFoundError("NOT_FOUND", { id, version }, `capability ${id}@${version} not found.`);
    if (creator !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, version, action: "capabilities:delete" },
        "Only the version's creator or a workspace admin can delete this capability version.",
      );
    await this.deps.store.softDelete(tenant, id, version);
  }
}
