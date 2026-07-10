import { z } from "zod";

// Image reference classification — from the workspace registry's perspective, "whose" image this is.
// workspace  = the workspace registry (host+namespace match) — pullable from anywhere with credentials.
// external   = an explicit external host (ghcr.io/… etc.) or org/name form (implies docker.io) — public/external source.
// local      = an explicit loopback host (localhost:5000/… etc.) — exists only on the machine it was built/pushed on.
// unqualified= a single-segment name (spreadsheetbench:v1·postgres:16-alpine) — syntactically indistinguishable between a
//              local daemon build and a Docker Hub library image (naming the ambiguity itself as a class).
// Placement view: local+unqualified = no pull guarantee, workspace+external = pullable (given auth).
// The parse/classify/warn rules live in @everdict/domain (image/) — re-architecture P1e.
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

// A warning for an image with no pull guarantee — imageWarnings in the register/validate response (warn-not-block, same convention as missingSecrets).
export interface ImageWarning {
  image: string;
  class: Extract<ImageRefClass, "local" | "unqualified">;
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
