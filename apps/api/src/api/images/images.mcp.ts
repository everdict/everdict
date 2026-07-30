import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of the managed image store's routes (BFF↔MCP parity — one service core, two transports).
//
// The tool names are managed-specific rather than shared with the BYO family (`list_image_tags`,
// `inspect_image`): the two answer different questions — "everdict's own store, where we mint the grant" vs
// "a registry you told us about" — and a single tool that guessed between them would have to resolve the
// ambiguity from a bare repository name. Distinct names let each description say which store it reads, so a
// model picks the right one instead of us picking for it.
// Design: docs/architecture/managed-image-store.md
export function registerImagesTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.images) return; // BYO-only deployment: the whole family is absent, matching the routes' 404
  const images = deps.images;

  server.registerTool(
    "list_workspace_images",
    {
      description:
        "List the repositories this workspace has published to everdict's own managed image store, with the " +
        "endpoint and namespace their refs are built from. Use it to find an existing environment image before " +
        "building a new one. Tags are not resolved here — drill in with list_managed_image_tags.",
      inputSchema: {},
    },
    () =>
      run(principal, "harnesses:read", async () => {
        const [repositories, usage] = await Promise.all([images.listRepositories(ws), images.usage(ws)]);
        return ok({ endpoint: images.endpoint, namespace: images.namespaceFor(ws), repositories, usage });
      }),
  );

  server.registerTool(
    "list_managed_image_tags",
    {
      description:
        "List the tags of ONE repository in this workspace's managed namespace (everdict's own store, not a " +
        "registry you registered — for those use list_image_tags). A repository that does not exist reads as " +
        "an empty tag list.",
      inputSchema: {
        repository: z
          .string()
          .min(1)
          .describe('repository name inside the workspace namespace — "officeqa-env" (no namespace prefix)'),
      },
    },
    ({ repository }) =>
      run(principal, "harnesses:read", async () => ok({ repository, tags: await images.listTags(ws, repository) })),
  );

  server.registerTool(
    "inspect_managed_image",
    {
      description:
        "Inspect a manifest (tag or digest) in this workspace's managed namespace — returns the digest, media " +
        "type, platforms, size, and (best-effort, from the OCI config blob) the build history the image was " +
        "made from plus its runtime config (entrypoint/cmd/env/labels). The digest it reports is what the " +
        "REGISTRY stored, so pin that rather than a mutable tag when registering an environment.",
      inputSchema: {
        repository: z.string().min(1).describe('repository name inside the workspace namespace — "officeqa-env"'),
        reference: z.string().min(1).describe('a tag or digest — "v1.2.0" · "sha256:…"'),
      },
    },
    ({ repository, reference }) =>
      run(principal, "harnesses:read", async () => ok(await images.inspect(ws, repository, reference))),
  );

  server.registerTool(
    "push_image_grant",
    {
      description:
        "Mint a short-lived authorization to push ONE repository into this workspace's managed namespace, plus " +
        "the prefix to assemble the target ref with. The grant is the docker PASSWORD (the username is fixed); " +
        "the repository is created by the first push. Requires images:push.",
      inputSchema: {
        repository: z
          .string()
          .min(1)
          .describe('repository name to publish under, inside the workspace namespace — "officeqa-env"'),
      },
    },
    ({ repository }) =>
      run(principal, "images:push", async () =>
        ok({
          grant: await images.mintPushGrant(ws, repository),
          imagePrefix: `${images.endpoint}/${images.namespaceFor(ws)}/`,
        }),
      ),
  );

  server.registerTool(
    "remove_workspace_image",
    {
      description:
        "Unpublish a repository from this workspace's managed namespace and report how many manifests were " +
        "unlinked. Retracting an image is the inverse of publishing it, so it takes the same images:push right.",
      inputSchema: {
        repository: z.string().min(1).describe('repository name inside the workspace namespace — "officeqa-env"'),
      },
    },
    ({ repository }) =>
      run(principal, "images:push", async () => ok({ repository, removed: await images.remove(ws, repository) })),
  );
}
