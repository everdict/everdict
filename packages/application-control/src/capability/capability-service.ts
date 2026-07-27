import {
  type CapabilityRecord,
  type CapabilitySpec,
  type CapabilityVisibility,
  ForbiddenError,
  type ImageRefClass,
  type ImageRegistryCoordinates,
  type ImageWarning,
  NotFoundError,
} from "@everdict/contracts";
import { canConsumeCapability, classifyImageRef, imageWarnings, specsEqual } from "@everdict/domain";
import type { CapabilityStore } from "../ports/capability-store.js";

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
    const visibility = body.visibility ?? "private";
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

  // Classify an environment capability's image against the workspace's registered registries — warn-not-block, so a
  // coordinates failure (or an unset provider) yields no warnings, never a blocked publish.
  private async environmentImageWarnings(tenant: string, spec: CapabilitySpec): Promise<ImageWarning[]> {
    if (spec.type !== "environment" || !this.deps.registryCoordinates) return [];
    try {
      return imageWarnings([spec.image], await this.deps.registryCoordinates(tenant));
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

  // A single capability the caller can see, in their own workspace (latest or an exact version). Not visible / missing
  // → 404 (no existence leak — a foreign private capability is indistinguishable from a missing one).
  async get(tenant: string, id: string, subject: string, ref = "latest"): Promise<CapabilityView> {
    const record = await this.deps.store.get(tenant, id, ref);
    if (!record || !canConsumeCapability(record, { tenant, subject }))
      throw new NotFoundError("NOT_FOUND", { id, version: ref }, `capability '${id}' not found.`);
    const [view] = await this.annotate(tenant, [record]);
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
    return records.map((r) =>
      r.spec.type === "environment" ? { ...r, imageClass: classifyImageRef(r.spec.image, coordinates) } : r,
    );
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
