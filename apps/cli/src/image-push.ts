import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BadRequestError,
  type CapabilityVisibility,
  CapabilityVisibilitySchema,
  type EnvironmentImageSpec,
  UpstreamError,
} from "@everdict/contracts";
import { dockerAuthConfigJson, imageRepositoryOf, parseImageRef, pinDigest } from "@everdict/domain";
import { z } from "zod";

const pexecFile = promisify(execFile);

// everdict image push — publish a locally built image to the workspace's image store.
// Two publish targets, one command: the MANAGED store (everdict's own registry — a namespace exists the moment the
// workspace does, and the control plane mints a scoped push grant) or a BYO registry the workspace registered.
// Managed is preferred when the deployment runs one; `--registry <name>` selects a BYO registry explicitly, and a
// deployment with no managed store falls back to BYO automatically (POST /workspace/image-registries/push-credentials).
// Either way the credential is tag+push with this machine's docker. When there are multiple registries, select one with --registry <name> (omit if there is only one). Credentials are written only to a temporary DOCKER_CONFIG directory and deleted when done
// (~/.docker/config.json is neither read nor written). Design: docs/architecture/workspace-image-registry.md
// With --register-environment <id> the published ref is also registered as an `environment` capability, so the bytes
// and the store asset that gives them an identity land in ONE step (docs/architecture/environment-image-store.md).

// push credentials response (non-persistent) — same shape as the control-plane contract.
const PushCredentialsSchema = z.object({
  name: z.string().min(1).optional(), // minted registry name (to identify one of multiple registries)
  host: z.string().min(1),
  namespace: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1),
  imagePrefix: z.string().min(1),
});
export type PushCredentials = z.infer<typeof PushCredentialsSchema>;

// Assemble the target ref — under imagePrefix ("host[/namespace]/"), name/tag default from the local ref.
// e.g. prefix=ghcr.io/acme/ + local=spreadsheetbench:v1 → ghcr.io/acme/spreadsheetbench:v1
export function buildImageTargetRef(imagePrefix: string, localRef: string, name?: string, tag?: string): string {
  const parsed = parseImageRef(localRef);
  const segments = parsed.path.split("/");
  const defaultName = segments[segments.length - 1];
  if (!defaultName)
    throw new BadRequestError("BAD_REQUEST", { localRef }, "could not derive a name from the local image reference");
  const finalName = name ?? defaultName;
  const finalTag = tag ?? parsed.tag ?? "latest";
  return `${imagePrefix}${finalName}:${finalTag}`;
}

// config.json for the temporary DOCKER_CONFIG — delegates to core dockerAuthConfigJson (the same builder as the pull path).
export function buildDockerAuthConfig(credentials: Pick<PushCredentials, "host" | "username" | "password">): string {
  return dockerAuthConfigJson({
    host: credentials.host,
    ...(credentials.username ? { username: credentials.username } : {}),
    password: credentials.password,
  });
}

// Mint push credentials from the control plane — on failure, surface the error-envelope message verbatim to the user.
export async function fetchPushCredentials(
  apiUrl: string,
  apiKey: string,
  registry?: string,
): Promise<PushCredentials> {
  const url = new URL("/workspace/image-registries/push-credentials", apiUrl);
  if (registry) url.searchParams.set("name", registry);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } });
  } catch (e) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { url: url.toString() },
      `failed to reach the control plane: ${String(e)}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { credentials?: unknown; message?: string };
  if (!res.ok)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { status: res.status },
      body.message ?? `failed to mint push credentials (HTTP ${res.status})`,
    );
  return PushCredentialsSchema.parse(body.credentials);
}

// The managed store's push authorization — a grant token presented as the docker password, plus the prefix the
// target ref is assembled under. Same shape the BYO path produces, so pushImage does not care which one it got.
const PushGrantResponseSchema = z.object({
  grant: z.object({
    endpoint: z.string().min(1),
    repositories: z.array(z.string().min(1)).min(1),
    token: z.string().min(1),
    expiresAt: z.string(),
  }),
  imagePrefix: z.string().min(1),
});

// The repository name a local ref publishes under — the last path segment, or --name. Needed BEFORE minting,
// because a grant authorizes one repository (that is the point of scoping it).
export function repositoryNameFor(localRef: string, name?: string): string {
  if (name) return name;
  const segments = parseImageRef(localRef).path.split("/");
  const last = segments[segments.length - 1];
  if (!last)
    throw new BadRequestError(
      "BAD_REQUEST",
      { localRef },
      "could not derive a repository name from the local image reference",
    );
  return last;
}

// Mint a managed push grant. `undefined` (not a throw) when this deployment runs no managed store — the caller then
// falls back to a BYO registry, which is the whole point of the 404 being a normal answer here.
export async function fetchManagedPushGrant(
  apiUrl: string,
  apiKey: string,
  repository: string,
): Promise<PushCredentials | undefined> {
  const url = new URL("/workspace/images/push-grant", apiUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ repository }),
    });
  } catch (e) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { url: url.toString() },
      `failed to reach the control plane: ${String(e)}`,
    );
  }
  if (res.status === 404) return undefined; // no managed store here — BYO is the path
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { status: res.status },
      body.message ?? `failed to mint a push grant (HTTP ${res.status})`,
    );
  const parsed = PushGrantResponseSchema.parse(body);
  return {
    host: parsed.grant.endpoint,
    username: "everdict", // the grant is a bearer in the password field; the registry ignores the username
    password: parsed.grant.token,
    imagePrefix: parsed.imagePrefix,
  };
}

interface ImagePushIo {
  log: (message: string) => void;
  docker: (args: string[], env?: Record<string, string>) => Promise<void>;
}

const defaultDocker = async (args: string[], env?: Record<string, string>): Promise<void> => {
  try {
    // buffer the progress output but surface stderr on failure (a push can take several minutes, so the log makes clear it is not silent).
    await pexecFile("docker", args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { args: args.join(" ") },
      `docker ${args[0]} failed: ${stderr || String(e)}`,
    );
  }
};

// tag → temporary DOCKER_CONFIG login file → push → cleanup (finally). On success, returns the published ref.
export async function pushImage(
  credentials: PushCredentials,
  localRef: string,
  opts: { name?: string; tag?: string; io?: ImagePushIo } = {},
): Promise<string> {
  const io: ImagePushIo = opts.io ?? { log: (m) => console.error(m), docker: defaultDocker };
  const target = buildImageTargetRef(credentials.imagePrefix, localRef, opts.name, opts.tag);
  io.log(`▶ docker tag ${localRef} ${target}`);
  await io.docker(["tag", localRef, target]);
  const configDir = await mkdtemp(join(tmpdir(), "everdict-docker-"));
  try {
    await writeFile(join(configDir, "config.json"), buildDockerAuthConfig(credentials), { mode: 0o600 });
    io.log(`▶ docker push ${target} (credentials: temporary DOCKER_CONFIG, deleted when done)`);
    await io.docker(["--config", configDir, "push", target]);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
  return target;
}

// ── --register-environment: the published ref becomes a store asset ────────────────────────────────────────────
// A pushed ref is still an anonymous string. Registering it as an `environment` capability records what the image is
// and how to wire it, so the next author (member or agent) pins ONE identity instead of re-deriving the wiring.

// The slice of PUT /capabilities/:id we read back: the version the save assigned + warn-not-block image warnings.
const SavedCapabilitySchema = z.object({
  id: z.string(),
  version: z.string(),
  visibility: z.string(),
  imageWarnings: z.array(z.object({ image: z.string(), class: z.string() })).optional(),
});
export type SavedCapability = z.infer<typeof SavedCapabilitySchema>;

export interface EnvironmentRegistration {
  id: string;
  name: string;
  description: string;
  visibility: CapabilityVisibility;
  spec: EnvironmentImageSpec;
}

// Docker reads that only INFORM the registration — a failure degrades the metadata, it never fails a completed push.
export interface ImageInspectIo {
  inspect: (args: string[]) => Promise<string>;
}

const defaultInspect: ImageInspectIo["inspect"] = async (args) => {
  try {
    const { stdout } = await pexecFile("docker", args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return ""; // best-effort by design: the caller degrades (and says so) rather than losing a successful push
  }
};

// `docker image inspect --format {{.Os}}|{{.Architecture}}` → the platform the store card shows.
export function parsePlatform(stdout: string): { os?: string; arch?: string } {
  const [os, arch] = stdout.trim().split("|");
  return { ...(os ? { os } : {}), ...(arch ? { arch } : {}) };
}

// The pushed digest out of the target's RepoDigests — pinning `…@sha256:…` instead of the mutable tag is what makes
// the environment reproducible. The pushed TAG is kept alongside it (`repo:tag@sha256:…`): the digest still decides
// what runs, and the tag is what the environment/topology views read the version off. Undefined when docker reported
// none (older daemon / no push metadata).
export function pickRepoDigest(stdout: string, target: string): string | undefined {
  const repository = imageRepositoryOf(target);
  if (repository.length === 0) return undefined;
  const line = stdout
    .split(/\s+/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${repository}@`));
  if (line === undefined) return undefined;
  return pinDigest(target, line.slice(repository.length + 1));
}

// Assemble the capability from what the push actually knows: the published ref, the local image's platform, and the
// author's prose. Everything it cannot know (packages, wiring preset) stays the author's to declare — the CLI never
// invents contents. Without --instructions the body is a provenance line, not fabricated guidance.
export function buildEnvironmentRegistration(input: {
  id: string;
  image: string;
  localRef: string;
  visibility: CapabilityVisibility;
  name?: string;
  description?: string;
  benchmark?: string;
  os?: string;
  arch?: string;
  instructions?: string;
}): EnvironmentRegistration {
  const contents = {
    packages: [],
    ...(input.benchmark ? { benchmark: input.benchmark } : {}),
    ...(input.os ? { os: input.os } : {}),
    ...(input.arch ? { arch: input.arch } : {}),
  };
  const hasContents = Object.keys(contents).length > 1;
  return {
    id: input.id,
    name: input.name ?? input.id,
    description: input.description ?? `Eval environment image published from ${input.localRef}`,
    visibility: input.visibility,
    spec: {
      type: "environment",
      image: input.image,
      ...(hasContents ? { contents } : {}),
      instructions:
        input.instructions ?? `Published with \`everdict image push\` from the local image \`${input.localRef}\`.`,
    },
  };
}

// PUT /capabilities/:id (capabilities:write) — the same version-free upsert the web and MCP surfaces call.
export async function registerEnvironment(
  apiUrl: string,
  apiKey: string,
  registration: EnvironmentRegistration,
): Promise<SavedCapability> {
  const url = new URL(`/capabilities/${encodeURIComponent(registration.id)}`, apiUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: registration.name,
        description: registration.description,
        spec: registration.spec,
        visibility: registration.visibility,
      }),
    });
  } catch (e) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { url: url.toString() },
      `failed to reach the control plane: ${String(e)}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { status: res.status },
      body.message ?? `failed to register the environment (HTTP ${res.status})`,
    );
  return SavedCapabilitySchema.parse(body);
}

// The digest the MANAGED registry actually stored, pinned onto the pushed ref as `repo:tag@sha256:…`. Best-effort
// like every other input to the registration: a failed read degrades the pin to the tag, it never fails a push that
// already succeeded.
export async function fetchManagedDigest(apiUrl: string, apiKey: string, target: string): Promise<string | undefined> {
  const parsed = parseImageRef(target);
  const reference = parsed.digest ?? parsed.tag ?? "latest";
  const url = new URL("/workspace/images/manifest", apiUrl);
  url.searchParams.set("repository", parsed.path);
  url.searchParams.set("reference", reference);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { digest?: string };
    if (!body.digest) return undefined;
    return pinDigest(target, body.digest);
  } catch {
    return undefined;
  }
}

// A flag that was passed without a value parses as "true" (flags.ts) — for an id/path that is a user error, not a value.
function flagValue(flags: Map<string, string>, key: string): string | undefined {
  const raw = flags.get(key);
  return raw === undefined || raw === "true" ? undefined : raw;
}

// Register the just-pushed ref as an environment capability. Runs AFTER a successful push, so every failure here is
// reported against an image that is already published (the ref on stdout stays usable).
async function registerPushedEnvironment(
  apiUrl: string,
  apiKey: string,
  target: string,
  localRef: string,
  flags: Map<string, string>,
  io: ImageInspectIo = { inspect: defaultInspect },
  managed = false,
): Promise<void> {
  const id = flagValue(flags, "register-environment");
  if (id === undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      undefined,
      "--register-environment needs an environment id — --register-environment officeqa-env",
    );
  const visibility = CapabilityVisibilitySchema.safeParse(flags.get("visibility") ?? "workspace");
  if (!visibility.success)
    throw new BadRequestError(
      "BAD_REQUEST",
      { visibility: flags.get("visibility") },
      "--visibility must be private | workspace | subset | public",
    );

  const instructionsPath = flagValue(flags, "instructions");
  let instructions: string | undefined;
  if (instructionsPath !== undefined) {
    try {
      instructions = await readFile(instructionsPath, "utf8");
    } catch (e) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { path: instructionsPath },
        `could not read --instructions ${instructionsPath}: ${String(e)}`,
      );
    }
  }

  const platform = parsePlatform(
    await io.inspect(["image", "inspect", "--format", "{{.Os}}|{{.Architecture}}", target]),
  );
  // On the managed path the REGISTRY is asked what it stored — the authority on the digest, rather than the local
  // daemon's record of what it sent. Falls back to docker's RepoDigests, which is all a BYO push has.
  const digestRef =
    (managed ? await fetchManagedDigest(apiUrl, apiKey, target) : undefined) ??
    pickRepoDigest(await io.inspect(["image", "inspect", "--format", '{{join .RepoDigests "\n"}}', target]), target);
  if (digestRef === undefined)
    console.error("↳ no pushed digest was reported — registering the tag ref (rebuilding the tag changes what runs)");

  const registration = buildEnvironmentRegistration({
    id,
    image: digestRef ?? target,
    localRef,
    visibility: visibility.data,
    ...(flagValue(flags, "env-name") !== undefined ? { name: flagValue(flags, "env-name") } : {}),
    ...(flagValue(flags, "env-description") !== undefined ? { description: flagValue(flags, "env-description") } : {}),
    ...(flagValue(flags, "benchmark") !== undefined ? { benchmark: flagValue(flags, "benchmark") } : {}),
    ...platform,
    ...(instructions !== undefined ? { instructions } : {}),
  });
  const saved = await registerEnvironment(apiUrl, apiKey, registration);
  console.error(
    `✓ Registered environment ${saved.id}@${saved.version} (${saved.visibility}) → ${registration.spec.image}`,
  );
  for (const warning of saved.imageWarnings ?? [])
    console.error(`⚠ ${warning.image}: classified ${warning.class} — consumers may not be able to pull it`);
  if (instructions === undefined)
    console.error(
      "↳ instructions are provenance-only — describe entry points, result paths and gotchas with --instructions <file.md> (or edit it in Settings › Environments)",
    );
}

// everdict image push <local-ref> [--registry R] [--name N] [--tag T] [--api-url URL] [--api-key ak_…]
//   [--register-environment <id> [--env-name N] [--env-description T] [--benchmark B] [--instructions <file>] [--visibility V]]
export async function imagePushCommand(localRef: string | undefined, flags: Map<string, string>): Promise<void> {
  if (!localRef)
    throw new BadRequestError(
      "BAD_REQUEST",
      undefined,
      "a local image reference to publish is required — everdict image push <ref>",
    );
  const apiUrl = flags.get("api-url") ?? process.env.EVERDICT_API_URL ?? "http://localhost:8787";
  const apiKey = flags.get("api-key") ?? process.env.EVERDICT_API_KEY;
  if (!apiKey)
    throw new BadRequestError("BAD_REQUEST", undefined, "--api-key <ak_…> (or EVERDICT_API_KEY) is required");
  // `--registry <name>` names a BYO registry, so it is an explicit choice for that path. Otherwise prefer the
  // managed store when the deployment runs one, and fall back to BYO — which is what every pre-managed workspace
  // still has. The user is told which one they published to, because the ref alone does not say.
  const registry = flags.get("registry");
  const repository = repositoryNameFor(localRef, flags.get("name"));
  const managed = registry ? undefined : await fetchManagedPushGrant(apiUrl, apiKey, repository);
  if (managed) console.error("▶ publishing to the workspace's everdict image store");
  const credentials = managed ?? (await fetchPushCredentials(apiUrl, apiKey, registry));
  const target = await pushImage(credentials, localRef, { name: flags.get("name"), tag: flags.get("tag") });
  console.error("✓ Published — use this reference as a harness pin / service image:");
  console.log(target);
  if (!flags.has("register-environment")) {
    console.error(
      "↳ Give it an identity the team can find and reuse: --register-environment <id> (registers it as a store environment)",
    );
    return;
  }
  await registerPushedEnvironment(apiUrl, apiKey, target, localRef, flags, undefined, managed !== undefined);
}
