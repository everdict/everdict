import { createHash } from "node:crypto";
import {
  BadRequestError,
  type HarnessSpec,
  type ImageRefClass,
  type ImageRegistryCoordinates,
  type ImageWarning,
  type ParsedImageRef,
  type RegistryAuth,
} from "@everdict/contracts";

// Image-reference classification rules — the shapes (ImageRefClass/ParsedImageRef/ImageWarning/
// RegistryAuth) live in @everdict/contracts; the parse/classify/warn rules live here (single owner).
// Design: docs/architecture/workspace-image-registry.md

export function parseImageRef(ref: string): ParsedImageRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new BadRequestError("BAD_REQUEST", undefined, "cannot classify an empty image reference");
  // Strip the digest (@sha256:…) first — so it doesn't mix with the tag's ':' scan.
  const atIndex = trimmed.indexOf("@");
  const digest = atIndex >= 0 ? trimmed.slice(atIndex + 1) : undefined;
  let rest = atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
  // tag = the ':' after the last '/' — avoids confusion with a host port (localhost:5000/x).
  const lastSlash = rest.lastIndexOf("/");
  const colonIndex = rest.indexOf(":", lastSlash + 1);
  const tag = colonIndex >= 0 ? rest.slice(colonIndex + 1) : undefined;
  rest = colonIndex >= 0 ? rest.slice(0, colonIndex) : rest;
  const firstSlash = rest.indexOf("/");
  const firstComponent = firstSlash >= 0 ? rest.slice(0, firstSlash) : rest;
  const isHost =
    firstSlash >= 0 && (firstComponent.includes(".") || firstComponent.includes(":") || firstComponent === "localhost");
  return {
    ...(isHost ? { host: firstComponent } : {}),
    path: isHost ? rest.slice(firstSlash + 1) : rest,
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
  };
}

// Is it a loopback host — this registry reference is meaningless outside that machine.
function isLoopbackHost(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

// Does this ref live under these coordinates — host equal and (when a namespace is configured) path inside it.
function refIsUnder(parsed: ParsedImageRef, coords: ImageRegistryCoordinates): boolean {
  return (
    parsed.host === coords.host &&
    (!coords.namespace || parsed.path === coords.namespace || parsed.path.startsWith(`${coords.namespace}/`))
  );
}

// registry is singular or plural — a workspace can register multiple registries, and belonging to 'any one' makes it workspace.
// `managed` are the workspace's coordinates in everdict's OWN image store; a ref under them classifies as "managed",
// checked FIRST because the two answer different questions ("a registry you told us about" vs "ours, we mint the grant").
export function classifyImageRef(
  ref: string,
  registry?: ImageRegistryCoordinates | ImageRegistryCoordinates[],
  managed?: ImageRegistryCoordinates,
): ImageRefClass {
  const registries = registry === undefined ? [] : Array.isArray(registry) ? registry : [registry];
  const parsed = parseImageRef(ref);
  if (parsed.host) {
    if (managed && refIsUnder(parsed, managed)) return "managed";
    if (isLoopbackHost(parsed.host)) return "local";
    if (registries.some((r) => refIsUnder(parsed, r))) return "workspace";
    return "external";
  }
  // No host: org/name implies docker.io (external), a single segment is ambiguous (unqualified).
  return parsed.path.includes("/") ? "external" : "unqualified";
}

// The repository coordinates of a ref — "host/path" (or bare "path" for a docker.io shorthand), tag and digest
// stripped. The identity a tag/digest hangs off.
export function imageRepositoryOf(ref: string): string {
  const parsed = parseImageRef(ref);
  return parsed.host ? `${parsed.host}/${parsed.path}` : parsed.path;
}

// Pin a reference to a digest WITHOUT discarding its tag — `repo:tag@sha256:…`. Both halves of an image's
// identity survive: the digest is what actually resolves (an OCI client ignores the tag when a digest is present,
// so reproducibility is untouched), and the tag is the only place a human reads a VERSION off. Dropping it — what
// every pin path used to do — leaves the topology view showing a bare `repo@sha256:…`: a perfectly reproducible
// image nobody can identify. An already-pinned digest is replaced.
export function pinDigest(ref: string, digest: string): string {
  const { tag } = parseImageRef(ref);
  return `${imageRepositoryOf(ref)}${tag ? `:${tag}` : ""}@${digest.trim()}`;
}

// Registry image prefix — "host[/namespace]/". Used by the client to assemble the target ref.
export function imageRegistryPrefix(registry: ImageRegistryCoordinates): string {
  return registry.namespace ? `${registry.host}/${registry.namespace}/` : `${registry.host}/`;
}

// All images a (resolved) harness spec references — service is per-service (host-exec services carry none),
// command is the dispatch image.
export function collectHarnessImages(spec: HarnessSpec): string[] {
  if (spec.kind === "service") return spec.services.flatMap((s) => (s.image ? [s.image] : []));
  if (spec.kind === "command") return spec.image ? [spec.image] : [];
  return []; // process — no image reference (code adapter)
}

export function imageWarnings(
  images: string[],
  registry?: ImageRegistryCoordinates | ImageRegistryCoordinates[],
  managed?: ImageRegistryCoordinates,
): ImageWarning[] {
  const warnings: ImageWarning[] = [];
  for (const image of images) {
    const cls = classifyImageRef(image, registry, managed);
    if (cls === "local" || cls === "unqualified") {
      warnings.push({ image, class: cls });
      continue;
    }
    // A pullable (workspace/external) image pinned by the mutable `latest` tag — or untagged, which resolves to latest —
    // and no digest is not reproducible: the tag can be rebuilt/overwritten and already-cached hosts keep the stale
    // image. Flag it so the author pins a digest. A specific version tag is left alone (the project treats it as stable).
    const parsed = parseImageRef(image);
    if (!parsed.digest && (parsed.tag === undefined || parsed.tag === "latest")) {
      warnings.push({ image, class: "mutable-tag" });
    }
  }
  return warnings;
}

// Whether this image is pulled from the given registry host — decides the auth-injection target (explicit host match only).
export function imageUsesRegistryHost(image: string, host: string): boolean {
  return parseImageRef(image).host === host;
}

// The credentials a job actually carries. Reads the plural field, falling back to the deprecated singular one so a
// SELF-HOSTED RUNNER or job-runner image on either side of the rename keeps authenticating (the control plane
// dual-writes). Every consumer goes through this — nobody reads job.registryAuth directly.
export function registryAuthsOf(job: { registryAuths?: RegistryAuth[]; registryAuth?: RegistryAuth }): RegistryAuth[] {
  if (job.registryAuths && job.registryAuths.length > 0) return job.registryAuths;
  return job.registryAuth ? [job.registryAuth] : [];
}

// The one credential that authenticates this image, or undefined for an image no credential covers (public/base
// images, and the deliberate warn-only placement stance: a missing credential is not a dispatch error).
export function pickRegistryAuth(auths: RegistryAuth[], image: string): RegistryAuth | undefined {
  return auths.find((auth) => imageUsesRegistryHost(image, auth.host));
}

// The credentials covering ANY of these images — what a multi-image consumer (topology deploy, dockerconfigjson
// Secret) renders. Deduplicated by host: one entry per registry, however many images it serves.
export function registryAuthsForImages(auths: RegistryAuth[], images: string[]): RegistryAuth[] {
  return auths.filter((auth) => images.some((image) => imageUsesRegistryHost(image, auth.host)));
}

// docker config.json contents (auths[host].auth = base64("user:pass")) — written to a temporary DOCKER_CONFIG directory
// and used via docker --config <dir> pull/push (the user's ~/.docker/config.json is untouched). A registry with no
// username is usually token-only (any username accepted) → we use "everdict". Accepts several credentials because one
// docker config authenticates several hosts — a topology pulling from the managed store AND a BYO registry needs both.
export function dockerAuthConfigJson(auth: RegistryAuth | RegistryAuth[]): string {
  const list = Array.isArray(auth) ? auth : [auth];
  const auths: Record<string, { auth: string }> = {};
  for (const entry of list) {
    auths[entry.host] = {
      auth: Buffer.from(`${entry.username ?? "everdict"}:${entry.password}`).toString("base64"),
    };
  }
  return JSON.stringify({ auths });
}

// A single-segment repository name INSIDE a workspace namespace — the rule the managed store enforces at
// resolve() and the rule a sandbox world id must satisfy to BE a repository (agent worlds W1: the world id
// doubles as its snapshot repository). One authority so the two can never drift.
export const IMAGE_REPOSITORY_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

// The namespace the PLATFORM's own images live in — everdict's api/web/agent/job-runner, mirrored in so a
// deployment can run without reaching a public registry at all. Not a tenant: it belongs to the operator, is
// written only through the internal (operator) path, and is readable by every workspace because pulling the
// job-runner is what makes a workspace's evals run.
//
// Collision-proof against `imageRepoFor` BY CONSTRUCTION, not by luck: a tenant namespace is always
// `<sanitized>-<sha256:8>`, so it ends in a hyphen plus eight hex characters. `everdict-platform` does not,
// and no tenant slug can produce it — including a workspace literally named "everdict-platform", which
// sanitizes to `everdict-platform-<hash>`.
export const PLATFORM_IMAGE_NAMESPACE = "everdict-platform";

// Is this repository path the platform's rather than some workspace's? Used where the two namespaces must be
// told apart — a pull grant may cover it for anyone, a push grant never may.
export function isPlatformImagePath(path: string): boolean {
  return path === PLATFORM_IMAGE_NAMESPACE || path.startsWith(`${PLATFORM_IMAGE_NAMESPACE}/`);
}

// A workspace's repository namespace in the MANAGED image store — the image analog of `fsBucketFor`, and deliberately
// the same collision rule: OCI repository paths are lowercase `[a-z0-9]` plus separators while tenant slugs are not,
// so a sanitization collision ("Acme" vs "acme", "a.b" vs "a-b") would put two workspaces in one namespace, which IS
// cross-tenant leakage. The readable head is for operators; the sha256 tail is what makes distinct tenants distinct.
// Design: docs/architecture/managed-image-store.md
export function imageRepoFor(tenant: string): string {
  const slug = tenant.trim();
  if (!slug)
    throw new BadRequestError("BAD_REQUEST", undefined, "cannot derive an image namespace for an empty tenant");
  const hash = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  // A slug that sanitizes to nothing (e.g. "___") still needs a legal leading component — the hash keeps it unique.
  return `${sanitized || "ws"}-${hash}`;
}
