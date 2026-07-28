import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Workspace-filesystem MCP tools — the MCP twin of fs.routes.ts. The shared, workspace-isolated file tree agents
// use to persist task outputs and artifacts as REAL files (reports, extracted data, generated configs) instead of
// losing them with the conversation. Reads are list_/get_-prefixed (the conversational agent's read classification);
// every mutation gates on files:write and goes through the agent's permission flow.
export function registerFsTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.fsService) return;
  const fs = deps.fsService;

  server.registerTool(
    "list_files",
    {
      description:
        "List a directory on the workspace filesystem — immediate children (dirs first, name-sorted). Omit `path` (or pass '/') for the root. The tree is shared by the whole workspace and isolated from every other workspace.",
      inputSchema: { path: z.string().max(600).optional() },
    },
    ({ path }) => run(principal, "files:read", async () => ok(await fs.list(ws, path))),
  );

  server.registerTool(
    "get_file",
    {
      description:
        "Read a file from the workspace filesystem. Text files return utf8 content; binary files return base64 (see `encoding`). A missing path is NOT_FOUND; a directory is BAD_REQUEST (list it instead).",
      inputSchema: { path: z.string().min(1).max(600) },
    },
    ({ path }) => run(principal, "files:read", async () => ok(await fs.readFile(ws, path))),
  );

  server.registerTool(
    "write_file",
    {
      description:
        "Create or replace a file on the workspace filesystem (parents become directories implicitly). Use this to persist task outputs — reports, extracted datasets, generated configs — as real files the team can browse. Text by default; pass encoding 'base64' for binary. Files cap at 5 MiB. Requires files:write.",
      inputSchema: {
        path: z.string().min(1).max(600),
        content: z.string().max(7_200_000),
        encoding: z.enum(["utf8", "base64"]).optional(),
        content_type: z.string().min(1).max(200).optional(),
      },
    },
    ({ path, content, encoding, content_type }) =>
      run(principal, "files:write", async () =>
        ok(
          await fs.writeFile(ws, {
            path,
            content,
            ...(encoding ? { encoding } : {}),
            ...(content_type ? { contentType: content_type } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "make_directory",
    {
      description:
        "Create a directory on the workspace filesystem (idempotent, mkdir -p). A file already at the path is CONFLICT. Requires files:write.",
      inputSchema: { path: z.string().min(1).max(600) },
    },
    ({ path }) => run(principal, "files:write", async () => ok(await fs.makeDirectory(ws, path))),
  );

  server.registerTool(
    "move_file",
    {
      description:
        "Move/rename a file or a whole directory subtree on the workspace filesystem. The target must not already exist (no overwrite). Requires files:write.",
      inputSchema: { from: z.string().min(1).max(600), to: z.string().min(1).max(600) },
    },
    ({ from, to }) => run(principal, "files:write", async () => ok(await fs.move(ws, from, to))),
  );

  server.registerTool(
    "delete_file",
    {
      description:
        "Remove a file, an empty directory, or (recursive=true) a whole subtree from the workspace filesystem. A non-empty directory without recursive is CONFLICT. Requires files:write.",
      inputSchema: { path: z.string().min(1).max(600), recursive: z.boolean().optional() },
    },
    ({ path, recursive }) =>
      run(principal, "files:write", async () => ok(await fs.remove(ws, path, recursive === true))),
  );
}
