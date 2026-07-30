import { z } from "zod";
import { ImageRepoSchema } from "../../infra/image-store.js";

// GET /workspace/images — the workspace's managed repositories plus the usage counters the Settings › Images
// panel leads with. Usage travels WITH the listing rather than in a second endpoint: the panel renders both in
// one header, and a second round-trip could disagree with the list it sits above.
// Design: docs/architecture/managed-image-store.md
export const ImageCatalogResponseSchema = z.object({
  endpoint: z.string().min(1), // registry host[:port] — the prefix every ref in this namespace carries
  namespace: z.string().min(1), // the workspace's namespace segment ("<workspace>-<hash8>")
  repositories: z.array(ImageRepoSchema),
  usage: z.object({
    repositories: z.number().int().nonnegative(),
    // Omitted when the backend cannot report it: a real registry does not total a namespace's bytes without
    // walking every manifest, and the panel prints "—" rather than a number we invented.
    bytes: z.number().int().nonnegative().optional(),
  }),
});
export type ImageCatalogResponse = z.infer<typeof ImageCatalogResponseSchema>;
