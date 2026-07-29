import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";
import { fsActorFor } from "./fs-actor.js";

// Workspace-filesystem MCP tools — the MCP twin of fs.routes.ts. The shared, workspace-isolated file tree agents
// use to persist task outputs and artifacts as REAL files (reports, extracted data, generated configs) instead of
// losing them with the conversation. Reads are list_/get_-prefixed (the conversational agent's read classification);
// every mutation gates on files:write and goes through the agent's permission flow.
export function registerFsTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.fsService) return;
  const fs = deps.fsService;
  // Every publish this session makes is attributed to the AGENT (with its conversation) acting for the member —
  // the same authorship the web writes, so one history explains both kinds of author.
  const actor = fsActorFor(principal, ctx.agent);

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
        "Read a file from the workspace filesystem. Text files return utf8 content; binary files return base64 (see `encoding`). The entry's `revision` is the file's current published revision — pass it back as `base_revision` when you write, so your edit cannot silently overwrite someone else's. A missing path is NOT_FOUND; a directory is BAD_REQUEST (list it instead).",
      inputSchema: { path: z.string().min(1).max(600) },
    },
    ({ path }) => run(principal, "files:read", async () => ok(await fs.readFile(ws, path))),
  );

  server.registerTool(
    "write_file",
    {
      description:
        "Create or replace a file on the workspace filesystem (parents become directories implicitly), publishing it as a new revision attributed to you. Use this to persist task outputs — reports, extracted datasets, generated configs — as real files the team can browse. Text by default; pass encoding 'base64' for binary. Files cap at 5 MiB. " +
        "MODIFYING AN EXISTING FILE: pass `base_revision` — the `revision` you got from get_file. Members and other agents edit these files too, and without it your write silently overwrites whatever they published meanwhile. On CONFLICT the error carries the live content plus an attempted three-way merge: re-apply your change on top of it and write again (use the merged text when it has no conflict markers). Requires files:write.",
      inputSchema: {
        path: z.string().min(1).max(600),
        content: z.string().max(7_200_000),
        encoding: z.enum(["utf8", "base64"]).optional(),
        content_type: z.string().min(1).max(200).optional(),
        base_revision: z.number().int().nonnegative().optional(),
        message: z.string().max(500).optional(),
      },
    },
    ({ path, content, encoding, content_type, base_revision, message }) =>
      run(principal, "files:write", async () =>
        ok(
          await fs.writeFile(
            ws,
            {
              path,
              content,
              ...(encoding ? { encoding } : {}),
              ...(content_type ? { contentType: content_type } : {}),
              ...(base_revision !== undefined ? { baseRevision: base_revision } : {}),
              ...(message ? { message } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "list_file_revisions",
    {
      description:
        "The publication history of one workspace file, newest first: who published each revision (a member, or an agent with the conversation it ran in and the member it acted for), when, its size/hash and the publish message. Use it to see whether someone else has been editing a file before you rewrite it.",
      inputSchema: { path: z.string().min(1).max(600), limit: z.number().int().positive().max(200).optional() },
    },
    ({ path, limit }) => run(principal, "files:read", async () => ok(await fs.history(ws, path, limit))),
  );

  server.registerTool(
    "get_file_revision",
    {
      description:
        "Read the content published under a specific revision of a file — for comparing against the current content, or checking what a rollback would bring back. An unknown revision is NOT_FOUND.",
      inputSchema: { path: z.string().min(1).max(600), revision: z.number().int().positive() },
    },
    ({ path, revision }) => run(principal, "files:read", async () => ok(await fs.readRevision(ws, path, revision))),
  );

  server.registerTool(
    "restore_file_revision",
    {
      description:
        "Roll a file back to an earlier revision. This never rewrites history: the old content is re-published as a NEW revision attributed to you, recording which revision it restored. Requires files:write.",
      inputSchema: { path: z.string().min(1).max(600), revision: z.number().int().positive() },
    },
    ({ path, revision }) =>
      run(principal, "files:write", async () => ok(await fs.restoreRevision(ws, path, revision, actor))),
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
    "get_fs_usage",
    {
      description:
        "The workspace filesystem's storage usage — totals plus a per-top-level-entry breakdown (files/bytes). `truncated` means the sweep hit its cap and counts are a floor.",
      inputSchema: {},
    },
    () => run(principal, "files:read", async () => ok(await fs.usage(ws))),
  );

  server.registerTool(
    "delete_all_files",
    {
      description:
        "Empty the WHOLE workspace filesystem — removes every top-level entry recursively (the tree stays, ready for new writes). Destructive and workspace-wide; requires settings:write (admin).",
      inputSchema: {},
    },
    () => run(principal, "settings:write", async () => ok(await fs.clear(ws))),
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
