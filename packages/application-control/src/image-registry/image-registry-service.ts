import {
  BadRequestError,
  type ImageRegistryCoordinates,
  type ImageRegistryProbeResult,
  NotFoundError,
  type RegistryAuth,
  UpstreamError,
} from "@everdict/contracts";
import type { WorkspaceSettings } from "@everdict/contracts";
import { imageRegistryPrefix, parseImageRef } from "@everdict/domain";
import type { ImageManifestInfo, RegistryReader } from "../ports/registry-reader.js";
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
  reader: RegistryReader; // Docker Registry v2 read adapter (list tags / inspect manifest) — the agent's read tools
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

  // Connection test BEFORE registering (the web form gates Save on a reachable result) — verify the host answers
  // as a Docker Registry v2 API and that the configured credential authenticates, via GET /v2/ (the reader owns
  // the fetch/handshake). Single-credential test: prefer the push secret (the everdict image push write path),
  // else the pull secret, else an anonymous probe. A missing secret VALUE is a friendly {reachable:false,
  // reason:"auth"} rather than a throw (a probe classifies). The API upsert stays pure — only the web flow gates.
  async probe(
    workspace: string,
    input: { host: string; namespace?: string; username?: string; pullSecretName?: string; pushSecretName?: string },
  ): Promise<ImageRegistryProbeResult> {
    const coords: ImageRegistryCoordinates = {
      host: input.host,
      ...(input.namespace ? { namespace: input.namespace } : {}),
    };
    const secretName = input.pushSecretName ?? input.pullSecretName;
    const credential: ImageRegistryProbeResult["credential"] = input.pushSecretName
      ? "push"
      : input.pullSecretName
        ? "pull"
        : "anonymous";
    let auth: RegistryAuth | undefined;
    if (secretName) {
      const value = (await this.deps.secretsFor(workspace))[secretName];
      if (value === undefined)
        return {
          reachable: false,
          reason: "auth",
          credential,
          detail: `No value for '${secretName}' in the SecretStore — save the secret first, then test.`,
        };
      auth = { host: input.host, ...(input.username ? { username: input.username } : {}), password: value };
    }
    return { ...(await this.deps.reader.checkConnection(coords, auth)), credential };
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

  // Select a registry entry by name — omission is allowed only when there's exactly one. Shared by the read tools + push.
  // No registry = 404 · name mismatch = 404 · multiple with name omitted = 400.
  private async selectEntry(workspace: string, name?: string): Promise<ImageRegistryEntry> {
    const entries = await this.entries(workspace);
    if (entries.length === 0) throw new NotFoundError("NOT_FOUND", undefined, "No image registry is registered");
    if (name !== undefined) {
      const reg = entries.find((r) => r.name === name);
      if (!reg) throw new NotFoundError("NOT_FOUND", { name }, `Registry is not registered: ${name}`);
      return reg;
    }
    if (entries.length === 1 && entries[0]) return entries[0];
    throw new BadRequestError(
      "BAD_REQUEST",
      { registries: entries.map((r) => r.name) },
      `There are multiple registries — specify a name: ${entries.map((r) => r.name).join(", ")}`,
    );
  }

  // Pull auth for an entry (username + pullSecretName value); undefined when no pull secret is configured (anonymous read).
  private async pullAuthFor(workspace: string, reg: ImageRegistryEntry): Promise<RegistryAuth | undefined> {
    if (!reg.pullSecretName) return undefined;
    const password = (await this.deps.secretsFor(workspace))[reg.pullSecretName];
    if (password === undefined) return undefined;
    return { host: reg.host, ...(reg.username ? { username: reg.username } : {}), password };
  }

  // List the tags of a repository in the named registry (the agent's list_image_tags tool). name omittable when single.
  async listTags(
    workspace: string,
    repository: string,
    name?: string,
  ): Promise<{ registry: string; repository: string; tags: string[] }> {
    const reg = await this.selectEntry(workspace, name);
    const coords: ImageRegistryCoordinates = { host: reg.host, ...(reg.namespace ? { namespace: reg.namespace } : {}) };
    const tags = await this.deps.reader.listTags(coords, await this.pullAuthFor(workspace, reg), repository);
    return { registry: reg.name, repository, tags };
  }

  // Inspect a manifest (tag or digest) of a repository in the named registry (the agent's inspect_image tool).
  async inspectImage(
    workspace: string,
    repository: string,
    reference: string,
    name?: string,
  ): Promise<ImageManifestInfo & { registry: string; repository: string }> {
    const reg = await this.selectEntry(workspace, name);
    const coords: ImageRegistryCoordinates = { host: reg.host, ...(reg.namespace ? { namespace: reg.namespace } : {}) };
    const info = await this.deps.reader.inspectManifest(
      coords,
      await this.pullAuthFor(workspace, reg),
      repository,
      reference,
    );
    return { registry: reg.name, repository, ...info };
  }

  // Active pull-usability check for a FULL image ref — can THIS workspace pull it? Parses the ref, resolves the
  // matching registered registry's pull auth, and does a Docker Registry v2 manifest fetch. Classified (never
  // throws): a reachable manifest → pullable; 401/403 → "auth" (e.g. a publisher's PRIVATE registry not
  // registered here — the cross-tenant "can't pull" signal); 404 → "not-found"; transport/other →
  // "unreachable"; an UNREGISTERED host → "unregistered-host", WITHOUT any fetch. Powers environment-adoption
  // verification (warn-not-block).
  //
  // Unregistered hosts are NOT probed (arch-review 6 follow-up, H12): the host comes out of the AGENT-SUPPLIED
  // ref, the fetch runs from the control plane's network position, and the reader honors http:// scheme hosts —
  // so an anonymous probe of an arbitrary host is a promptless reachability oracle for internal services (the
  // tool is correctly read-annotated; the classified reasons distinguish live/auth/absent/dead). No credential
  // ever left, but the network position did. Docker Hub stays probeable as THE well-known public default (the
  // no-host shorthand always meant it); everything else must be a REGISTERED registry — registration without a
  // pullSecretName is supported (anonymous auth), so "register the registry" is the zero-credential re-enable
  // path, and it is exactly the workspace image-provenance model (BYO registries as the baseline).
  async verifyImage(
    workspace: string,
    imageRef: string,
  ): Promise<{
    pullable: boolean;
    reason: "ok" | "auth" | "not-found" | "unreachable" | "unregistered-host";
    digest?: string;
  }> {
    let parsed: ReturnType<typeof parseImageRef>;
    try {
      parsed = parseImageRef(imageRef);
    } catch {
      return { pullable: false, reason: "not-found" };
    }
    // The Docker Hub aliases collapse onto the canonical probe host — an explicit `docker.io/...` ref is the
    // same well-known destination the bare shorthand always probed.
    const DOCKER_HUB = new Set(["registry-1.docker.io", "docker.io", "index.docker.io"]);
    const host = parsed.host === undefined || DOCKER_HUB.has(parsed.host) ? "registry-1.docker.io" : parsed.host;
    const repository = parsed.host || parsed.path.includes("/") ? parsed.path : `library/${parsed.path}`;
    const reference = parsed.digest ?? parsed.tag ?? "latest";
    const entry = (await this.entries(workspace)).find((r) => r.host === host);
    if (entry === undefined && host !== "registry-1.docker.io") return { pullable: false, reason: "unregistered-host" };
    const auth = entry ? await this.pullAuthFor(workspace, entry) : undefined; // Docker Hub only — every other host is registered here
    try {
      const info = await this.deps.reader.inspectManifest({ host }, auth, repository, reference);
      return { pullable: true, reason: "ok", ...(info.digest ? { digest: info.digest } : {}) };
    } catch (e) {
      const status = e instanceof UpstreamError && typeof e.extra?.status === "number" ? e.extra.status : undefined;
      const reason = status === 401 || status === 403 ? "auth" : status === 404 ? "not-found" : "unreachable";
      return { pullable: false, reason };
    }
  }

  // Mint push credentials (member+, images:push) — select by name; omission is allowed only when there's exactly one registry.
  // No registry / name mismatch = 404 · multiple with name omitted = 400 · push not configured = 400 · missing secret = 404.
  async pushCredentials(workspace: string, name?: string): Promise<ImagePushCredentials> {
    const reg = await this.selectEntry(workspace, name);
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
