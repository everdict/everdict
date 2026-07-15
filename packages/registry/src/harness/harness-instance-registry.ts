import {
  BadRequestError,
  type HarnessInstanceSpec,
  type HarnessSpec,
  type HarnessTemplateSpec,
  type ServiceHarnessSpec,
  resolveHarnessInstance,
} from "@everdict/contracts";
import { modelBindingLabel, referencesUserSecret } from "@everdict/domain";
import { asService } from "../registry.js";
import { VersionedStore } from "../versioned-store.js";

// The registry port + its list-entry/metadata types live in @everdict/application-control; this InMemory impl
// `implements` the port, so the registry re-exports it here beside the impl as a deliberate convenience.
export type { HarnessInstanceRegistry, HarnessListEntry } from "@everdict/application-control";
import type {
  HarnessInstanceRegistry,
  HarnessListEntry,
  HarnessTemplateRegistry,
  VersionMeta,
} from "@everdict/application-control";

// resolved HarnessSpec → subtitle (for list display). command = model/command, service = service count. undefined if none.
export function harnessSubtitle(spec: HarnessSpec): string | undefined {
  if (spec.kind === "command") return modelBindingLabel(spec.model) ?? spec.command;
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
