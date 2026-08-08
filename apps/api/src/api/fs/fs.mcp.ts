import { FILE_EXECUTION_MAX_TIMEOUT_SEC } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";
import { fsActorFor } from "./fs-actor.js";
import { memberFs } from "./member-scope.js";

// Workspace-filesystem MCP tools — the MCP twin of fs.routes.ts. The shared, workspace-isolated file tree agents
// use to persist task outputs and artifacts as REAL files (reports, extracted data, generated configs) instead of
// losing them with the conversation. Reads are list_/get_-prefixed (the conversational agent's read classification);
// every mutation gates on files:write and goes through the agent's permission flow.
export function registerFsTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.fsService) return;
  // The agent sees the filesystem as the MEMBER it is acting for does — its own credential IS theirs — so
  // list_files/search_files/get_file reach that member's memory and no other member's. One line, because every
  // tool below reads through this handle.
  const fs = memberFs(deps.fsService, principal);
  // Every publish this session makes is attributed to the AGENT (with its conversation) acting for the member —
  // the same authorship the web writes, so one history explains both kinds of author.
  const actor = fsActorFor(principal, ctx.agent);

  server.registerTool(
    "list_files",
    {
      annotations: { readOnlyHint: true },
      description:
        "List a directory on the workspace filesystem — immediate children (dirs first, name-sorted). Omit `path` (or pass '/') for the root. The tree is shared by the whole workspace and isolated from every other workspace.",
      inputSchema: { path: z.string().max(600).optional() },
    },
    ({ path }) => run(principal, "files:read", async () => ok(await fs.list(ws, path))),
  );

  server.registerTool(
    "search_files",
    {
      annotations: { readOnlyHint: true },
      description:
        "Search the workspace filesystem — find files by path glob (`glob`: * within a segment, ** across segments, ?) and/or grep file content with a case-insensitive regex (`pattern`); at least one is required. `path` scopes to a subtree. Content matches return the path, a 1-based line and an excerpt. Use it to RECALL before you re-derive: past memories (memory/), knowledge bodies (knowledge/), reports and task outputs — when you don't already know the exact path, search first. `truncated: true` means the result is a floor — narrow with glob/path and search again.",
      inputSchema: {
        pattern: z.string().min(1).max(300).optional(),
        glob: z.string().min(1).max(300).optional(),
        path: z.string().max(600).optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    ({ pattern, glob, path, limit }) =>
      run(principal, "files:read", async () =>
        ok(
          await fs.search(ws, {
            ...(pattern !== undefined ? { pattern } : {}),
            ...(glob !== undefined ? { glob } : {}),
            ...(path !== undefined ? { path } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_file",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read a file from the workspace filesystem. Text files return utf8 content; binary files return base64 (see `encoding`). The entry's `revision` is the file's current published revision — pass it back as `base_revision` when you write, so your edit cannot silently overwrite someone else's. A missing path is NOT_FOUND; a directory is BAD_REQUEST (list it instead).",
      inputSchema: { path: z.string().min(1).max(600) },
    },
    ({ path }) => run(principal, "files:read", async () => ok(await fs.readFile(ws, path))),
  );

  server.registerTool(
    "write_file",
    {
      annotations: { readOnlyHint: false },
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
      annotations: { readOnlyHint: true },
      description:
        "The publication history of one workspace file, newest first: who published each revision (a member, or an agent with the conversation it ran in and the member it acted for), when, its size/hash and the publish message. Use it to see whether someone else has been editing a file before you rewrite it. Pass `before` (the oldest revision you already have) to walk further back.",
      inputSchema: {
        path: z.string().min(1).max(600),
        limit: z.number().int().positive().max(200).optional(),
        before: z.number().int().positive().optional(),
      },
    },
    ({ path, limit, before }) =>
      run(principal, "files:read", async () => ok(await fs.history(ws, path, limit, before))),
  );

  server.registerTool(
    "diff_file_revisions",
    {
      annotations: { readOnlyHint: true },
      description:
        "What changed between two revisions of a workspace file — line hunks with context plus added/removed counts. Omit `to` to compare a past revision against the file as it stands now. Cheaper and clearer than reading both revisions in full when you only need the delta; a binary or over-sized file comes back with `truncated` and no hunks.",
      inputSchema: {
        path: z.string().min(1).max(600),
        from: z.number().int().positive(),
        to: z.number().int().positive().optional(),
      },
    },
    ({ path, from, to }) => run(principal, "files:read", async () => ok(await fs.diffRevisions(ws, path, from, to))),
  );

  server.registerTool(
    "get_file_revision",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read the content published under a specific revision of a file — for comparing against the current content, or checking what a rollback would bring back. An unknown revision is NOT_FOUND.",
      inputSchema: { path: z.string().min(1).max(600), revision: z.number().int().positive() },
    },
    ({ path, revision }) => run(principal, "files:read", async () => ok(await fs.readRevision(ws, path, revision))),
  );

  server.registerTool(
    "restore_file_revision",
    {
      annotations: { readOnlyHint: false },
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
      annotations: { readOnlyHint: false },
      description:
        "Create a directory on the workspace filesystem (idempotent, mkdir -p). A file already at the path is CONFLICT. Requires files:write.",
      inputSchema: { path: z.string().min(1).max(600) },
    },
    ({ path }) => run(principal, "files:write", async () => ok(await fs.makeDirectory(ws, path))),
  );

  server.registerTool(
    "move_file",
    {
      annotations: { readOnlyHint: false },
      description:
        "Move/rename a file or a whole directory subtree on the workspace filesystem. The target must not already exist (no overwrite). Requires files:write.",
      inputSchema: { from: z.string().min(1).max(600), to: z.string().min(1).max(600) },
    },
    ({ from, to }) => run(principal, "files:write", async () => ok(await fs.move(ws, from, to))),
  );

  server.registerTool(
    "get_fs_usage",
    {
      annotations: { readOnlyHint: true },
      description:
        "The workspace filesystem's storage usage — totals plus a per-top-level-entry breakdown (files/bytes). `truncated` means the sweep hit its cap and counts are a floor.",
      inputSchema: {},
    },
    () => run(principal, "files:read", async () => ok(await fs.usage(ws))),
  );

  server.registerTool(
    "delete_all_files",
    {
      annotations: { readOnlyHint: false },
      description:
        "Empty the WHOLE workspace filesystem — removes every top-level entry recursively AND purges the workspace's publication history (every file's past revisions and their stored content go with it; deleting a single file keeps its history). The tree stays, ready for new writes. Destructive and workspace-wide; requires settings:write (admin).",
      inputSchema: {},
    },
    () => run(principal, "settings:write", async () => ok(await fs.clear(ws))),
  );

  server.registerTool(
    "delete_file",
    {
      annotations: { readOnlyHint: false },
      description:
        "Remove a file, an empty directory, or (recursive=true) a whole subtree from the workspace filesystem. A non-empty directory without recursive is CONFLICT. Requires files:write.",
      inputSchema: { path: z.string().min(1).max(600), recursive: z.boolean().optional() },
    },
    ({ path, recursive }) =>
      run(principal, "files:write", async () => ok(await fs.remove(ws, path, recursive === true))),
  );

  // Parity with POST /fs/executions. Absent when the deployment composed no execution driver — an agent then
  // simply has no run tool, rather than a tool that fails on every call.
  const execution = deps.fileExecutionService;
  if (!execution) return;
  server.registerTool(
    "run_file",
    {
      annotations: { readOnlyHint: false },
      description:
        "Run a file from the workspace filesystem (.py/.sh/.js/.ts) in an isolated sandbox and get back its stdout, stderr and exit code. Files the script writes are carried back NEXT TO it — that is how you produce a chart, a converted document or a generated dataset: write it to the working directory and it lands in the same folder (an existing path is reported as `skipped`, never overwritten). " +
        "A non-zero exit is a RESULT to read, not a failure to retry blindly. `image` swaps the container (pass a workspace environment image to get its dependencies); the interpreter still follows the extension. `timeout_sec` caps it inside the sandbox — on expiry you get exit 124 and `timedOut`. `runtime` places the run on one of the workspace's registered runtimes (list_runtimes) instead of the deployment's own compute. Requires files:write.",
      inputSchema: {
        path: z.string().min(1).max(600),
        image: z.string().min(1).max(512).optional(),
        timeout_sec: z.number().int().min(1).max(FILE_EXECUTION_MAX_TIMEOUT_SEC).optional(),
        runtime: z.string().min(1).max(128).optional(),
      },
    },
    ({ path, image, timeout_sec, runtime }) =>
      run(principal, "files:write", async () =>
        ok(
          await execution.run(
            ws,
            {
              path,
              ...(image !== undefined ? { image } : {}),
              ...(timeout_sec !== undefined ? { timeoutSec: timeout_sec } : {}),
              ...(runtime !== undefined ? { runtime } : {}),
            },
            actor,
            // Same causal leg as every other agent-submitted unit of work: the run draws from this turn's
            // delegated envelope rather than riding free on the tenant pool.
            ctx.agent?.runId,
          ),
        ),
      ),
  );
}
