import { BadRequestError, type ImageRegistryCoordinates, NotFoundError, type RegistryAuth } from "@everdict/contracts";
import type { WorkspaceSettings } from "@everdict/contracts";
import { imageRegistryPrefix } from "@everdict/domain";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace image registry (BYO, multiple) service — the harness-image classification baseline + target for everdict image push issuance.
// Register several by name; push selects by name (omittable when there's only one), classification/pull auth matches by host across all.
// Registration is admin (settings:write), read is viewer+ (harnesses:read — classification is a harness-read concern),
// push-credential minting is member+ (images:push — leaking a credential 'value' is named honestly as a separate action).
// Secrets are stored/returned only as SecretStore name-refs; the value is resolved by pushCredentials at mint time (non-persistent).
// HTTP routes and MCP tools share this core. Design: docs/architecture/workspace-image-registry.md

// Registry state (no secrets — name references/coordinates only). imagePrefix = for the client to assemble/classify target refs.
export interface ImageRegistryView {
  name: string;
  host: string;
  namespace?: string;
  username?: string;
  pullSecretName?: string;
  pushSecretName?: string;
  imagePrefix: string; // "host[/namespace]/"
}

// push credentials — the caller (everdict image push / an agent) uses them for docker login+push and discards them. Never persisted anywhere.
export interface ImagePushCredentials {
  name: string;
  host: string;
  namespace?: string;
  username?: string;
  password: string; // the value of pushSecretName (resolved at mint time)
  imagePrefix: string;
}

export interface ImageRegistryServiceDeps {
  settings: WorkspaceSettingsStore;
  secretsFor: (workspace: string) => Promise<Record<string, string>>; // shared (workspace) secret tier
}

type ImageRegistryEntry = NonNullable<WorkspaceSettings["imageRegistries"]>[number];

function toView(reg: ImageRegistryEntry): ImageRegistryView {
  const coords: ImageRegistryCoordinates = {
    host: reg.host,
    ...(reg.namespace ? { namespace: reg.namespace } : {}),
  };
  return {
    name: reg.name,
    host: reg.host,
    ...(reg.namespace ? { namespace: reg.namespace } : {}),
    ...(reg.username ? { username: reg.username } : {}),
    ...(reg.pullSecretName ? { pullSecretName: reg.pullSecretName } : {}),
    ...(reg.pushSecretName ? { pushSecretName: reg.pushSecretName } : {}),
    imagePrefix: imageRegistryPrefix(coords),
  };
}

export class ImageRegistryService {
  constructor(private readonly deps: ImageRegistryServiceDeps) {}

  // Current list — if imageRegistries (plural) is absent, inherit the legacy singular (imageRegistry) as name="default" for reading.
  private async entries(workspace: string): Promise<ImageRegistryEntry[]> {
    const s = await this.deps.settings.get(workspace);
    if (s?.imageRegistries) return s.imageRegistries;
    return s?.imageRegistry ? [{ name: "default", ...s.imageRegistry }] : [];
  }

  async list(workspace: string): Promise<ImageRegistryView[]> {
    return (await this.entries(workspace)).map(toView);
  }

  // Classification coordinates (no secrets) — harness register/validate imageWarnings match by host across all registries.
  async coordinates(workspace: string): Promise<ImageRegistryCoordinates[]> {
    return (await this.entries(workspace)).map((r) => ({
      host: r.host,
      ...(r.namespace ? { namespace: r.namespace } : {}),
    }));
  }

  // Register/update (admin, upsert by name — declarative full replace: optional fields must be removable).
  // On the first write, inherit the legacy singular field into the list and null it out (subsequent reads use only imageRegistries).
  // The existence of referenced secret names is surfaced only as a warning (missingSecrets) — secrets can be added later.
  async upsert(
    workspace: string,
    input: {
      name: string;
      host: string;
      namespace?: string;
      username?: string;
      pullSecretName?: string;
      pushSecretName?: string;
    },
  ): Promise<{ config: ImageRegistryView; missingSecrets?: string[] }> {
    const entry: ImageRegistryEntry = {
      name: input.name,
      host: input.host,
      ...(input.namespace ? { namespace: input.namespace } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.pullSecretName ? { pullSecretName: input.pullSecretName } : {}),
      ...(input.pushSecretName ? { pushSecretName: input.pushSecretName } : {}),
    };
    const current = await this.entries(workspace);
    const next = [...current.filter((r) => r.name !== input.name), entry];
    await this.deps.settings.set(workspace, { imageRegistries: next, imageRegistry: null });
    const referenced = [input.pullSecretName, input.pushSecretName].filter((n): n is string => Boolean(n));
    let missingSecrets: string[] | undefined;
    if (referenced.length > 0) {
      const have = new Set(Object.keys(await this.deps.secretsFor(workspace)));
      const missing = referenced.filter((name) => !have.has(name));
      if (missing.length > 0) missingSecrets = missing;
    }
    return { config: toView(entry), ...(missingSecrets ? { missingSecrets } : {}) };
  }

  // Remove (admin, by name).
  async remove(workspace: string, name: string): Promise<void> {
    const next = (await this.entries(workspace)).filter((r) => r.name !== name);
    await this.deps.settings.set(workspace, { imageRegistries: next, imageRegistry: null });
  }

  // pull credentials (for dispatch enrichment, best-effort) — every registry with pull configured, as RegistryAuth.
  // The consumer (executeCase/dispatcher) matches the job image's host and picks one. Entries with a missing secret are silently excluded
  // (injection is just skipped — if pull is truly needed, downstream docker fails clearly).
  async pullAuths(workspace: string): Promise<RegistryAuth[]> {
    const entries = await this.entries(workspace);
    const secrets = entries.some((r) => r.pullSecretName) ? await this.deps.secretsFor(workspace) : {};
    const auths: RegistryAuth[] = [];
    for (const reg of entries) {
      if (!reg.pullSecretName) continue;
      const password = secrets[reg.pullSecretName];
      if (password === undefined) continue;
      auths.push({ host: reg.host, ...(reg.username ? { username: reg.username } : {}), password });
    }
    return auths;
  }

  // Mint push credentials (member+, images:push) — select by name; omission is allowed only when there's exactly one registry.
  // No registry / name mismatch = 404 · multiple with name omitted = 400 · push not configured = 400 · missing secret = 404.
  async pushCredentials(workspace: string, name?: string): Promise<ImagePushCredentials> {
    const entries = await this.entries(workspace);
    if (entries.length === 0) throw new NotFoundError("NOT_FOUND", undefined, "No image registry is registered");
    let reg: ImageRegistryEntry | undefined;
    if (name !== undefined) {
      reg = entries.find((r) => r.name === name);
      if (!reg) throw new NotFoundError("NOT_FOUND", { name }, `Registry is not registered: ${name}`);
    } else if (entries.length === 1) {
      reg = entries[0];
    } else {
      throw new BadRequestError(
        "BAD_REQUEST",
        { registries: entries.map((r) => r.name) },
        `There are multiple registries — specify a name: ${entries.map((r) => r.name).join(", ")}`,
      );
    }
    if (!reg) throw new NotFoundError("NOT_FOUND", undefined, "No image registry is registered");
    if (!reg.pushSecretName)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name: reg.name },
        `Registry "${reg.name}" has no push secret (pushSecretName) configured`,
      );
    const secrets = await this.deps.secretsFor(workspace);
    const password = secrets[reg.pushSecretName];
    if (password === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { secretName: reg.pushSecretName },
        `push secret "${reg.pushSecretName}" is not in the workspace SecretStore`,
      );
    const view = toView(reg);
    return {
      name: view.name,
      host: view.host,
      ...(view.namespace ? { namespace: view.namespace } : {}),
      ...(view.username ? { username: view.username } : {}),
      password,
      imagePrefix: view.imagePrefix,
    };
  }
}
