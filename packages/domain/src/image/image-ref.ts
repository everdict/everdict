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
