import { z } from "zod";

// Bring an image into the registry everdict manages. The source is a reference as its own registry addresses
// it (`debian:stable-slim`, `ghcr.io/acme/app:1.2`); name/tag default to the source's own, so the common case
// is one field.
export const MirrorImageBodySchema = z.object({
  image: z.string().min(1).max(500),
  name: z.string().min(1).max(200).optional(),
  tag: z.string().min(1).max(128).optional(),
});
export type MirrorImageBody = z.infer<typeof MirrorImageBodySchema>;
