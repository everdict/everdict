import { z } from "zod";

// POST /workspace/image-registries/push-credentials — one-time push credentials
// (ImageRegistryService.ImagePushCredentials). password IS the resolved pushSecretName value: it is minted at
// request time for docker login+push and never persisted anywhere — the caller discards it after use.
export const ImagePushCredentialsSchema = z.object({
  name: z.string().describe("Registry name the credentials were minted for"),
  host: z.string(),
  namespace: z.string().optional(),
  username: z.string().optional().describe("docker login username (omitted for token-only registries)"),
  password: z.string().describe("The push secret value, resolved at mint time — shown here once, never persisted"),
  imagePrefix: z.string().describe('"host[/namespace]/" — prefix for the image ref to push'),
});

export const PushCredentialsResponseSchema = z.object({
  credentials: ImagePushCredentialsSchema,
});
