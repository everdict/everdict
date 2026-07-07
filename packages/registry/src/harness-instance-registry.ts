import {
  BadRequestError,
  type HarnessInstanceSpec,
  type HarnessSpec,
  type HarnessTemplateSpec,
  type ServiceHarnessSpec,
  referencesUserSecret,
  resolveHarnessInstance,
} from "@everdict/core";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";
import { asService } from "./registry.js";
import { type VersionMeta, VersionedStore } from "./versioned-store.js";

// One list entry — version meta (registration history) + display fields derived from the latest instance (category/kind/subtitle).
// GET /harnesses and MCP list_harnesses produce this shape. Same grain as the dataset DatasetListEntry.
export interface HarnessListEntry extends VersionMeta {
  category?: string; // template category of the latest instance (cli-agent, etc.)
  kind?: string; // command | service | process (resolved)
  subtitle?: string; // model/command/service summary (a harness has no free-text description, so this serves as the subtitle)
  // true if the latest instance references a user-scoped secret — this harness is visible to createdBy only (private).
  // The API uses this value + createdBy to hide it from other users in list/detail (the value itself is derived — not stored separately).
  private?: boolean;
}

// resolved HarnessSpec → subtitle (for list display). command = model/command, service = service count. undefined if none.
export function harnessSubtitle(spec: HarnessSpec): string | undefined {
  if (spec.kind === "command") return spec.model ?? spec.command;
  if (spec.kind === "service") return `${spec.services.length} services`;
  return undefined;
}

// Overlays the latest-instance derivation (category/kind/subtitle) onto the list meta. Missing templates etc. are silently skipped (the list still shows).
export async function enrichHarnessList(
  metas: VersionMeta[],
  getInstance: (id: string, ref: string) => Promise<HarnessInstanceSpec>,
  getTemplate: (id: string, version: string) => Promise<HarnessTemplateSpec>,
): Promise<HarnessListEntry[]> {
  const out: HarnessListEntry[] = [];
  for (const meta of metas) {
    let extra: Partial<Pick<HarnessListEntry, "category" | "kind" | "subtitle" | "private">> = {};
    try {
      const instance = await getInstance(meta.id, meta.latestVersion);
      const template = await getTemplate(instance.template.id, instance.template.version);
      const resolved = resolveHarnessInstance(template, instance);
      const sub = harnessSubtitle(resolved);
      extra = {
        category: template.category,
        kind: resolved.kind,
        private: referencesUserSecret(resolved),
        ...(sub !== undefined ? { subtitle: sub } : {}),
      };
    } catch {
      // Missing template / resolution failure — skip derived fields (expose meta only)
    }
    out.push({ ...meta, ...extra });
  }
  return out;
}

// Slot keys the template can pin — service: slot (name if unspecified), command: image/model, process: none.
function templateSlots(template: HarnessTemplateSpec): string[] {
  if (template.kind === "service") return template.services.map((s) => s.slot ?? s.name);
  if (template.kind === "command") return ["image", "model"];
  return [];
}

// Submit-time transient pin override — merged over the instance pins and resolved (registry unchanged, for PR image swaps).
// Unknown slots are BadRequest — silently ignoring a typo causes the accident where the eval passes without the PR image being swapped in.
export function resolveInstanceWithPins(
  template: HarnessTemplateSpec,
  instance: HarnessInstanceSpec,
  pins: Record<string, string>,
): HarnessSpec {
  const known = new Set(templateSlots(template));
  for (const slot of Object.keys(pins)) {
    if (!known.has(slot)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { slot, known: [...known] },
        `Pin slot '${slot}' is not in the template.`,
      );
    }
  }
  return resolveHarnessInstance(template, { ...instance, pins: { ...instance.pins, ...pins } });
}

// Individual harness (instance) registry — (tenant, id, version) → HarnessInstanceSpec (template reference + pins).
// get()/getService() pin the template and return a resolved HarnessSpec (drop-in compatible with the existing HarnessRegistry.get).
// Instances stack as versions under the same id (= template.id) → list groups them by category (template).
export interface HarnessInstanceRegistry {
  register(tenant: string, instance: HarnessInstanceSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessSpec>; // resolved (template + pins)
  // resolved + submit-time transient pins (registry unchanged) — when a CI PR trigger swaps just one service image to evaluate.
  resolveWithPins(
    tenant: string,
    id: string,
    ref: string | undefined,
    pins: Record<string, string>,
  ): Promise<HarnessSpec>;
  getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<HarnessListEntry[]>;
  // The first-registrant subject of this harness id (no seed/shared) — for verifying the owner of a private (references a personal secret) harness.
  creatorOf(tenant: string, id: string): Promise<string | undefined>;
  // The registrant subject of this "version" — for delete authz (creator-or-admin). Non-owned/deleted/absent → NotFound (same as datasets).
  creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Version soft-delete (tombstone) — data is preserved (past scorecard reproducibility), excluded from every read, re-registering identical content revives it.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
  // Version tags (free-form labels, full replacement) — mutable registry meta (outside spec immutability). Tenant-owned live versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tags map (only versions with tags). Reads resolve owner like versions() (including _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}

export class InMemoryHarnessInstanceRegistry implements HarnessInstanceRegistry {
  private readonly store = new VersionedStore<HarnessInstanceSpec>("harness instance");
  constructor(private readonly templates: HarnessTemplateRegistry) {}

  // On register, validate template existence + pin validity via resolve (reject on failure — fail fast).
  async register(tenant: string, instance: HarnessInstanceSpec, createdBy?: string): Promise<void> {
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    resolveHarnessInstance(template, instance); // throws BadRequest on missing/mismatched pins
    this.store.register(tenant, instance, createdBy);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    this.store.softDelete(tenant, id, version);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }
  async getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec> {
    return this.store.get(tenant, id, ref);
  }
  async get(tenant: string, id: string, ref?: string): Promise<HarnessSpec> {
    const instance = this.store.get(tenant, id, ref);
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    return resolveHarnessInstance(template, instance);
  }
  async resolveWithPins(
    tenant: string,
    id: string,
    ref: string | undefined,
    pins: Record<string, string>,
  ): Promise<HarnessSpec> {
    const instance = this.store.get(tenant, id, ref);
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    return resolveInstanceWithPins(template, instance, pins);
  }
  async getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec> {
    return asService(await this.get(tenant, id, ref), id);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async creatorOf(tenant: string, id: string): Promise<string | undefined> {
    return this.store.listMeta(tenant).find((m) => m.id === id)?.createdBy;
  }
  async list(tenant: string): Promise<HarnessListEntry[]> {
    return enrichHarnessList(
      this.store.listMeta(tenant),
      (id, ref) => Promise.resolve(this.store.get(tenant, id, ref)),
      (id, version) => this.templates.get(tenant, id, version),
    );
  }
}
