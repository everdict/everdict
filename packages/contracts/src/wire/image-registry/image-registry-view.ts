import { z } from "zod";

// One registry's state (ImageRegistryService.ImageRegistryView). No secrets — pull/pushSecretName are
// SecretStore name references and coordinates only; credential values are minted separately (push-credentials).
export const ImageRegistryViewSchema = z.object({
  name: z.string().describe("Registry name (reference key — push selection points at this name)"),
  host: z.string().describe('Registry host[:port] — e.g. "ghcr.io", "registry.acme.dev:5000" (no scheme)'),
  namespace: z.string().optional().describe('Path prefix under host — "acme" → ghcr.io/acme/<image>'),
  username: z.string().optional().describe("docker login username (omitted for token-only registries)"),
  pullSecretName: z.string().optional().describe("SecretStore name of the pull token/password (never the value)"),
  pushSecretName: z.string().optional().describe("SecretStore name of the push token/password (never the value)"),
  imagePrefix: z.string().describe('"host[/namespace]/" — for assembling/classifying image refs'),
});
export type ImageRegistryView = z.infer<typeof ImageRegistryViewSchema>;
