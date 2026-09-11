import type { CapabilityRecord, ImageRefClass, ImageRegistryCoordinates, WorkspaceSettings } from "@everdict/contracts";
import { NotFoundError, UpstreamError } from "@everdict/contracts";
import { canConsumeCapability, classifyImageRef, parseImageRef } from "@everdict/domain";
import type { CapabilityStore } from "../ports/capability-store.js";

// What `resolve` answers, three-valued: `absent` is a real fact about the capability (deleted, revoked,
// someone else's private publish) and `unknown` is a fact about the STORE. They used to be one `undefined`.
type ResolvedEnvironment =
  | { kind: "resolved"; record: CapabilityRecord; spec: Extract<CapabilityRecord["spec"], { type: "environment" }> }
  | { kind: "absent" }
  | { kind: "unknown" };
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Environment-image adoption ("import") — a WORKSPACE-LEVEL inventory of environment capabilities a workspace has
// brought in, each with a pull-usability verification snapshot (warn-not-block). Environments feed harnesses
// workspace-wide (not one agent), so adoption lives on WorkspaceSettings.adoptedEnvironments (mirrors imageRegistries)
// rather than AgentSpec.capabilities. Only the immutable-version REF + a verify snapshot are stored; name/image/
// contents resolve live from the capability record so a revoked/deleted publish surfaces as `available:false`.
// Reuses canConsumeCapability (visibility) + classifyImageRef (per-viewer class) + ImageRegistryService.verifyImage
// (the active pull check). See docs/architecture/environment-image-store.md.

// The active pull-usability outcome (the ImageRegistryService.verifyImage shape) + the timestamp the service stamps.
export interface AdoptedEnvironmentVerify {
  pullable: boolean;
  reason?: "ok" | "auth" | "not-found" | "unreachable" | "unregistered-host";
  digest?: string;
  at: string;
}

// One inventory item — the adoption ref merged with the LIVE capability record + fresh viewer-relative class + verify.
export interface AdoptedEnvironmentView {
  source: string;
  id: string;
  version: string;
  adoptedAt: string;
  available: boolean; // the source capability still resolves + is consumable for this workspace
  name?: string;
  image?: string;
  benchmark?: string;
  imageClass?: ImageRefClass;
  verify?: AdoptedEnvironmentVerify;
}

export interface EnvironmentAdoptionServiceDeps {
  settings: WorkspaceSettingsStore;
  capabilityStore: CapabilityStore;
  // The active pull check (ImageRegistryService.verifyImage) — resolves the workspace's pull auth + fetches the manifest.
  verifyImage: (
    workspace: string,
    imageRef: string,
  ) => Promise<{
    pullable: boolean;
    reason: "ok" | "auth" | "not-found" | "unreachable" | "unregistered-host";
    digest?: string;
  }>;
  // The workspace's registry coordinates — for the per-viewer image classification (same source as CapabilityService).
  registryCoordinates: (workspace: string) => Promise<ImageRegistryCoordinates[]>;
  // The workspace's managed-store coordinates (see CapabilityService) — passed so an image reads the same class in
  // the inventory as it does in the store. Two surfaces disagreeing about provenance is worse than neither showing it.
  managedCoordinates?: (workspace: string) => ImageRegistryCoordinates | undefined;
  now?: () => string; // ISO timestamp (test injection)
}

type AdoptionEntry = NonNullable<WorkspaceSettings["adoptedEnvironments"]>[number];

export interface EnvironmentRef {
  source: string;
  id: string;
  version: string;
}

export class EnvironmentAdoptionService {
  constructor(private readonly deps: EnvironmentAdoptionServiceDeps) {}

  private stamp(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  private async entries(workspace: string): Promise<AdoptionEntry[]> {
    return (await this.deps.settings.get(workspace))?.adoptedEnvironments ?? [];
  }

  // ── THE CAPABILITY RECORD FOR A REF — THREE ANSWERS, NOT TWO (pnpm scan, application, 2026-09-11) ──
  //
  // `resolved` (it exists, is an environment, and this workspace may consume it), `absent` (any of those is
  // false — deleted, revoked, someone else's private publish), or `unknown` (the store could not be READ).
  //
  // It used to `.catch(() => undefined)`, which made a database blip indistinguishable from a deleted
  // capability — so `adopt()` answered 404 "not available to adopt" about an environment that exists, which
  // is the wrong ANSWER and not merely a worse one. A caller told something does not exist stops asking; a
  // caller told the store is unreachable retries (rule `protocol` L2).
  private async resolve(
    ref: EnvironmentRef,
    consumer: { tenant: string; subject: string },
  ): Promise<ResolvedEnvironment> {
    let rec: CapabilityRecord | undefined;
    try {
      rec = await this.deps.capabilityStore.getVersion(ref.source, ref.id, ref.version);
    } catch {
      return { kind: "unknown" };
    }
    if (!rec || rec.spec.type !== "environment" || !canConsumeCapability(rec, consumer)) return { kind: "absent" };
    // The narrowed spec travels WITH the record: every caller needs it and re-checking `type === "environment"`
    // at each one is a guard that can never fire, which rule `protocol` says is the worst kind to write.
    return { kind: "resolved", record: rec, spec: rec.spec };
  }

  // Adopt (import) an environment into the workspace inventory: verify pull-usability (warn-not-block) + record the
  // ref + snapshot, replacing any prior adoption of the same (source,id). An unresolvable/non-consumable ref → 404
  // (never leak that a cross-tenant private capability exists).
  async adopt(workspace: string, subject: string, ref: EnvironmentRef): Promise<AdoptedEnvironmentView> {
    const resolved = await this.resolve(ref, { tenant: workspace, subject });
    // "We could not find out" is not "it is not there". A 404 here told the caller to stop asking about an
    // environment that exists, and the two answers need different repairs from whoever reads them.
    if (resolved.kind === "unknown")
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { ...ref },
        `the capability store could not be read, so whether ${ref.id}@${ref.version} can be adopted cannot be established — nothing was adopted; retry once it answers`,
      );
    if (resolved.kind === "absent")
      throw new NotFoundError(
        "NOT_FOUND",
        { ...ref },
        `environment ${ref.id}@${ref.version} is not available to adopt`,
      );
    const v = await this.verify(workspace, resolved.spec.image);
    const entry: AdoptionEntry = {
      source: ref.source,
      id: ref.id,
      version: ref.version,
      adoptedAt: this.stamp(),
      verify: v,
    };
    const next = [
      ...(await this.entries(workspace)).filter((e) => !(e.source === ref.source && e.id === ref.id)),
      entry,
    ];
    await this.deps.settings.set(workspace, { adoptedEnvironments: next });
    return this.toView(entry, resolved, await this.deps.registryCoordinates(workspace), this.managed(workspace));
  }

  // Pull-usability of the environment's image (M6). For a ref in everdict's OWN store the answer is POLICY, not a
  // round trip: we only reach this line having resolved a capability this workspace may consume, and the grant that
  // authorizes the actual pull is minted from that same fact. The HTTP probe would ask the registry anonymously and
  // be told 401 — reporting "auth" for an image the workspace can demonstrably pull. BYO refs keep the HTTP check,
  // which is the only thing that can answer them.
  private async verify(workspace: string, image: string): Promise<AdoptedEnvironmentVerify> {
    const managedHost = this.managed(workspace)?.host;
    if (managedHost && hostOf(image) === managedHost) return { pullable: true, reason: "ok", at: this.stamp() };
    return { ...(await this.deps.verifyImage(workspace, image)), at: this.stamp() };
  }

  // Remove an environment from the inventory (by source,id — version-agnostic; one adoption per source/id).
  async unadopt(workspace: string, source: string, id: string): Promise<void> {
    const next = (await this.entries(workspace)).filter((e) => !(e.source === source && e.id === id));
    await this.deps.settings.set(workspace, { adoptedEnvironments: next });
  }

  // Re-run the pull check for one adopted environment and persist the new snapshot. Unavailable (revoked/deleted) →
  // the ref is kept and returned as available:false (no verify update). Not adopted → 404.
  async reverify(workspace: string, subject: string, source: string, id: string): Promise<AdoptedEnvironmentView> {
    const entries = await this.entries(workspace);
    const entry = entries.find((e) => e.source === source && e.id === id);
    if (!entry) throw new NotFoundError("NOT_FOUND", { source, id }, `environment ${id} is not adopted`);
    const resolved = await this.resolve(entry, { tenant: workspace, subject });
    let updated = entry;
    if (resolved.kind === "resolved") {
      updated = { ...entry, verify: await this.verify(workspace, resolved.spec.image) };
      await this.deps.settings.set(workspace, {
        adoptedEnvironments: entries.map((e) => (e.source === source && e.id === id ? updated : e)),
      });
    }
    return this.toView(updated, resolved, await this.deps.registryCoordinates(workspace), this.managed(workspace));
  }

  // The workspace's environment inventory — each adoption merged with the live capability + fresh class + verify.
  async list(workspace: string, subject: string): Promise<AdoptedEnvironmentView[]> {
    const entries = await this.entries(workspace);
    const coords = await this.deps.registryCoordinates(workspace);
    const managed = this.managed(workspace);
    const consumer = { tenant: workspace, subject };
    return Promise.all(entries.map(async (e) => this.toView(e, await this.resolve(e, consumer), coords, managed)));
  }

  // The workspace's managed-store coordinates, best-effort — a provider that throws must not fail the inventory.
  private managed(workspace: string): ImageRegistryCoordinates | undefined {
    try {
      return this.deps.managedCoordinates?.(workspace);
    } catch {
      return undefined;
    }
  }

  // ⚠️ `unknown` IS RENDERED AS `available: false` HERE, AND THAT IS A DECISION, NOT AN ACCIDENT.
  //
  // The view says "the source capability still resolves + is consumable for this workspace", and a store
  // outage means nobody knows — so during one, this inventory labels every entry unavailable, which reads to
  // a user exactly like a revocation. It is kept because the honest repair is a THIRD display state, which
  // reaches the served schema, the web entity schema and a message catalog in two locales, and inventing
  // that at the end of a scan triage is how the next defect gets written. Filed as
  // `intent/2026-09-11-an-inventory-cannot-say-it-does-not-know/`. What the scan changed is that `adopt` no
  // longer answers 404 about something that exists — a wrong ANSWER, where this is a wrong LABEL.
  private toView(
    entry: AdoptionEntry,
    resolved: ResolvedEnvironment,
    coords: ImageRegistryCoordinates[],
    managed?: ImageRegistryCoordinates,
  ): AdoptedEnvironmentView {
    const rec = resolved.kind === "resolved" ? resolved.record : undefined;
    const spec = resolved.kind === "resolved" ? resolved.spec : undefined;
    return {
      source: entry.source,
      id: entry.id,
      version: entry.version,
      adoptedAt: entry.adoptedAt,
      available: spec !== undefined,
      ...(rec ? { name: rec.name } : {}),
      ...(spec ? { image: spec.image } : {}),
      ...(spec?.contents?.benchmark ? { benchmark: spec.contents.benchmark } : {}),
      ...(spec ? { imageClass: classifyImageRef(spec.image, coords, managed) } : {}),
      ...(entry.verify ? { verify: entry.verify } : {}),
    };
  }
}

// The registry host of a ref, or undefined when it carries none (a docker.io shorthand — never our store).
function hostOf(ref: string): string | undefined {
  try {
    return parseImageRef(ref).host;
  } catch {
    return undefined;
  }
}
