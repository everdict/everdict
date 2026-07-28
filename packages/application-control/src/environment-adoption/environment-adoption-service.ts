import type { CapabilityRecord, ImageRefClass, ImageRegistryCoordinates, WorkspaceSettings } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { canConsumeCapability, classifyImageRef } from "@everdict/domain";
import type { CapabilityStore } from "../ports/capability-store.js";
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
  reason?: "ok" | "auth" | "not-found" | "unreachable";
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
  ) => Promise<{ pullable: boolean; reason: "ok" | "auth" | "not-found" | "unreachable"; digest?: string }>;
  // The workspace's registry coordinates — for the per-viewer image classification (same source as CapabilityService).
  registryCoordinates: (workspace: string) => Promise<ImageRegistryCoordinates[]>;
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

  // The capability record for a ref IF it exists, is an environment, AND is consumable by this workspace — else undefined.
  private async resolve(
    ref: EnvironmentRef,
    consumer: { tenant: string; subject: string },
  ): Promise<CapabilityRecord | undefined> {
    const rec = await this.deps.capabilityStore.getVersion(ref.source, ref.id, ref.version).catch(() => undefined);
    if (!rec || rec.spec.type !== "environment" || !canConsumeCapability(rec, consumer)) return undefined;
    return rec;
  }

  // Adopt (import) an environment into the workspace inventory: verify pull-usability (warn-not-block) + record the
  // ref + snapshot, replacing any prior adoption of the same (source,id). An unresolvable/non-consumable ref → 404
  // (never leak that a cross-tenant private capability exists).
  async adopt(workspace: string, subject: string, ref: EnvironmentRef): Promise<AdoptedEnvironmentView> {
    const rec = await this.resolve(ref, { tenant: workspace, subject });
    if (!rec || rec.spec.type !== "environment")
      throw new NotFoundError(
        "NOT_FOUND",
        { ...ref },
        `environment ${ref.id}@${ref.version} is not available to adopt`,
      );
    const v = await this.deps.verifyImage(workspace, rec.spec.image);
    const entry: AdoptionEntry = {
      source: ref.source,
      id: ref.id,
      version: ref.version,
      adoptedAt: this.stamp(),
      verify: { ...v, at: this.stamp() },
    };
    const next = [
      ...(await this.entries(workspace)).filter((e) => !(e.source === ref.source && e.id === ref.id)),
      entry,
    ];
    await this.deps.settings.set(workspace, { adoptedEnvironments: next });
    return this.toView(entry, rec, await this.deps.registryCoordinates(workspace));
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
    const rec = await this.resolve(entry, { tenant: workspace, subject });
    let updated = entry;
    if (rec && rec.spec.type === "environment") {
      updated = { ...entry, verify: { ...(await this.deps.verifyImage(workspace, rec.spec.image)), at: this.stamp() } };
      await this.deps.settings.set(workspace, {
        adoptedEnvironments: entries.map((e) => (e.source === source && e.id === id ? updated : e)),
      });
    }
    return this.toView(updated, rec, await this.deps.registryCoordinates(workspace));
  }

  // The workspace's environment inventory — each adoption merged with the live capability + fresh class + verify.
  async list(workspace: string, subject: string): Promise<AdoptedEnvironmentView[]> {
    const entries = await this.entries(workspace);
    const coords = await this.deps.registryCoordinates(workspace);
    const consumer = { tenant: workspace, subject };
    return Promise.all(entries.map(async (e) => this.toView(e, await this.resolve(e, consumer), coords)));
  }

  private toView(
    entry: AdoptionEntry,
    rec: CapabilityRecord | undefined,
    coords: ImageRegistryCoordinates[],
  ): AdoptedEnvironmentView {
    const spec = rec?.spec.type === "environment" ? rec.spec : undefined;
    return {
      source: entry.source,
      id: entry.id,
      version: entry.version,
      adoptedAt: entry.adoptedAt,
      available: spec !== undefined,
      ...(rec ? { name: rec.name } : {}),
      ...(spec ? { image: spec.image } : {}),
      ...(spec?.contents?.benchmark ? { benchmark: spec.contents.benchmark } : {}),
      ...(spec ? { imageClass: classifyImageRef(spec.image, coords) } : {}),
      ...(entry.verify ? { verify: entry.verify } : {}),
    };
  }
}
