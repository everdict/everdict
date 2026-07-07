import { z } from "zod";
import { BadRequestError } from "./errors.js";
import type { HarnessSpec } from "./harness-spec.js";

// Image reference classification — from the workspace registry's perspective, "whose" image this is.
// workspace  = the workspace registry (host+namespace match) — pullable from anywhere with credentials.
// external   = an explicit external host (ghcr.io/… etc.) or org/name form (implies docker.io) — public/external source.
// local      = an explicit loopback host (localhost:5000/… etc.) — exists only on the machine it was built/pushed on.
// unqualified= a single-segment name (spreadsheetbench:v1·postgres:16-alpine) — syntactically indistinguishable between a
//              local daemon build and a Docker Hub library image (naming the ambiguity itself as a class).
// Placement view: local+unqualified = no pull guarantee, workspace+external = pullable (given auth).
// Design: docs/architecture/workspace-image-registry.md
export type ImageRefClass = "workspace" | "external" | "local" | "unqualified";

// Workspace registry coordinates (no secrets) — the classification subset of WorkspaceSettings.imageRegistry.
export interface ImageRegistryCoordinates {
  host: string; // registry host[:port] — "ghcr.io" · "registry.acme.dev:5000"
  namespace?: string; // path prefix under host — "acme" → ghcr.io/acme/<name>:<tag>
}

// An image reference decomposed by docker reference syntax. host is a registry host only when the first path component
// contains '.'/':' or is "localhost" (the docker rule as-is).
export interface ParsedImageRef {
  host?: string;
  path: string; // the name path after host (excluding tag/digest)
  tag?: string;
  digest?: string;
}

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

// registry is singular or plural — a workspace can register multiple registries, and belonging to 'any one' makes it workspace.
export function classifyImageRef(
  ref: string,
  registry?: ImageRegistryCoordinates | ImageRegistryCoordinates[],
): ImageRefClass {
  const registries = registry === undefined ? [] : Array.isArray(registry) ? registry : [registry];
  const parsed = parseImageRef(ref);
  if (parsed.host) {
    if (isLoopbackHost(parsed.host)) return "local";
    const inWorkspace = registries.some(
      (r) =>
        parsed.host === r.host &&
        (!r.namespace || parsed.path === r.namespace || parsed.path.startsWith(`${r.namespace}/`)),
    );
    if (inWorkspace) return "workspace";
    return "external";
  }
  // No host: org/name implies docker.io (external), a single segment is ambiguous (unqualified).
  return parsed.path.includes("/") ? "external" : "unqualified";
}

// Registry image prefix — "host[/namespace]/". Used by the client to assemble the target ref.
export function imageRegistryPrefix(registry: ImageRegistryCoordinates): string {
  return registry.namespace ? `${registry.host}/${registry.namespace}/` : `${registry.host}/`;
}

// All images a (resolved) harness spec references — service is per-service, command is the dispatch image.
export function collectHarnessImages(spec: HarnessSpec): string[] {
  if (spec.kind === "service") return spec.services.map((s) => s.image);
  if (spec.kind === "command") return spec.image ? [spec.image] : [];
  return []; // process — no image reference (code adapter)
}

// A warning for an image with no pull guarantee — imageWarnings in the register/validate response (warn-not-block, same convention as missingSecrets).
export interface ImageWarning {
  image: string;
  class: Extract<ImageRefClass, "local" | "unqualified">;
}

export function imageWarnings(
  images: string[],
  registry?: ImageRegistryCoordinates | ImageRegistryCoordinates[],
): ImageWarning[] {
  const warnings: ImageWarning[] = [];
  for (const image of images) {
    const cls = classifyImageRef(image, registry);
    if (cls === "local" || cls === "unqualified") warnings.push({ image, class: cls });
  }
  return warnings;
}

// Registry pull/push credentials (transient) — the control plane resolves them from the workspace SecretStore
// and ships them via AgentJob.registryAuth (same discipline as repoToken: never persist to results/datasets); the
// consumer (DockerDriver/runner/topology builder) uses them only for an authenticated pull and then discards them.
export const RegistryAuthSchema = z.object({
  host: z.string().min(1), // the registry host[:port] these credentials are valid for
  username: z.string().min(1).optional(),
  password: z.string().min(1),
});
export type RegistryAuth = z.infer<typeof RegistryAuthSchema>;

// Whether this image is pulled from the given registry host — decides the auth-injection target (explicit host match only).
export function imageUsesRegistryHost(image: string, host: string): boolean {
  return parseImageRef(image).host === host;
}

// docker config.json contents (auths[host].auth = base64("user:pass")) — written to a temporary DOCKER_CONFIG directory
// and used via docker --config <dir> pull/push (the user's ~/.docker/config.json is untouched). A registry with no
// username is usually token-only (any username accepted) → we use "everdict".
export function dockerAuthConfigJson(auth: RegistryAuth): string {
  const encoded = Buffer.from(`${auth.username ?? "everdict"}:${auth.password}`).toString("base64");
  return JSON.stringify({ auths: { [auth.host]: { auth: encoded } } });
}
