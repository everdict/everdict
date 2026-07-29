import { FsEntrySchema, FsRevisionSchema } from "@everdict/contracts";
import { FsFileContentSchema, FsRemoveResultSchema, FsUsageSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { MakeFsDirectoryBodySchema } from "./request/make-fs-directory.js";
import { MoveFsEntryBodySchema } from "./request/move-fs-entry.js";
import { RestoreFsRevisionBodySchema } from "./request/restore-fs-revision.js";
import { WriteFsFileBodySchema } from "./request/write-fs-file.js";

// OpenAPI descriptors for the workspace-filesystem routes — doc-only (rule api-layer): attaching these is behavior-free.

const pathQuery = (required: boolean, extra?: Record<string, object>) => ({
  type: "object",
  properties: {
    path: { type: "string", description: "Workspace-relative path ('' or '/' = root; normalized server-side)" },
    ...extra,
  },
  ...(required ? { required: ["path"] } : {}),
});

const docs = {
  list: {
    summary: "List a directory",
    description:
      "Immediate children of a directory on the workspace filesystem — directories first, then files, name-sorted. " +
      "The tree is workspace-isolated: every path resolves inside the caller's workspace only. Requires files:read (viewer+).",
    tags: ["fs"],
    querystring: pathQuery(false),
    response: {
      200: { description: "Entries", ...toJsonSchema(z.array(FsEntrySchema)) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  read: {
    summary: "Read a file",
    description:
      "A file's content — utf8 for text types, base64 for binary (the `encoding` field says which). " +
      "A missing path is 404; a directory is 400. Requires files:read (viewer+).",
    tags: ["fs"],
    querystring: pathQuery(true),
    response: {
      200: { description: "File content", ...toJsonSchema(FsFileContentSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  write: {
    summary: "Publish a file revision",
    description:
      "Create-or-replace a file (parents become implicit directories) and publish it as a new revision attributed " +
      "to the caller. Text by default; pass encoding 'base64' for binary. Writing over a directory is 409; files " +
      "cap at 5 MiB. Send `baseRevision` (the revision you edited) to make the write safe against concurrent " +
      "editors: if anything was published since, the response is 409 whose `data` carries the live content and an " +
      "attempted three-way merge instead of overwriting it. Requires files:write (member+).",
    tags: ["fs"],
    body: toJsonSchema(WriteFsFileBodySchema),
    response: {
      200: { description: "Written entry (with its new revision)", ...toJsonSchema(FsEntrySchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  revisions: {
    summary: "A file's publication history",
    description:
      "Every published revision of a file, newest first — who published it (member or agent, with the agent and " +
      "conversation it ran in, plus the member it acted for), when, the content hash and the publish message. " +
      "Retained indefinitely. Requires files:read (viewer+).",
    tags: ["fs"],
    querystring: pathQuery(true, {
      limit: { type: "string", description: "Max revisions to return (default 50)" },
    }),
    response: {
      200: { description: "Revisions, newest first", ...toJsonSchema(z.array(FsRevisionSchema)) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  revisionContent: {
    summary: "Read one past revision",
    description:
      "The content published under a specific revision — for previewing or diffing it against the live file. " +
      "Shaped exactly like a live read (utf8 vs base64). An unknown revision is 404. Requires files:read (viewer+).",
    tags: ["fs"],
    querystring: pathQuery(true, {
      revision: { type: "string", description: "Revision number" },
    }),
    response: {
      200: { description: "Revision content", ...toJsonSchema(FsFileContentSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  restore: {
    summary: "Restore a past revision",
    description:
      "Re-publishes an earlier revision's content as a NEW revision attributed to the caller — history is " +
      "append-only, so a rollback is itself audited (the new revision records which one it restored). An unknown " +
      "revision is 404. Requires files:write (member+).",
    tags: ["fs"],
    body: toJsonSchema(RestoreFsRevisionBodySchema),
    response: {
      200: { description: "The file at its new revision", ...toJsonSchema(FsEntrySchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  mkdir: {
    summary: "Create a directory",
    description: "Idempotent (mkdir -p). A file already at the path is 409. Requires files:write (member+).",
    tags: ["fs"],
    body: toJsonSchema(MakeFsDirectoryBodySchema),
    response: {
      200: { description: "Created directory", ...toJsonSchema(FsEntrySchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  move: {
    summary: "Move/rename an entry",
    description:
      "Moves a file or a whole directory subtree. The target must not exist (no overwrite — 409); moving a " +
      "directory into itself is 400; a missing source is 404. Requires files:write (member+).",
    tags: ["fs"],
    body: toJsonSchema(MoveFsEntryBodySchema),
    response: {
      200: { description: "Entry at the new path", ...toJsonSchema(FsEntrySchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  usage: {
    summary: "Filesystem storage usage",
    description:
      "Totals plus a per-top-level-entry breakdown (files/bytes) — the Settings › Files overview. `truncated` " +
      "means the sweep hit its walk cap and the counts are a floor. Requires files:read (viewer+).",
    tags: ["fs"],
    response: {
      200: { description: "Usage", ...toJsonSchema(FsUsageSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  clear: {
    summary: "Empty the workspace filesystem",
    description:
      "Removes EVERY top-level entry recursively — the Settings danger-zone action. The tree itself stays, ready " +
      "for new writes. Requires settings:write (admin) — a whole-tree wipe is governance, not ordinary content mutation.",
    tags: ["fs"],
    response: {
      200: { description: "Removal result", ...toJsonSchema(FsRemoveResultSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  remove: {
    summary: "Remove an entry",
    description:
      "Removes a file, an empty directory, or (with recursive=true) a whole subtree. A non-empty directory without " +
      "recursive is 409; a missing path is 404. Requires files:write (member+).",
    tags: ["fs"],
    querystring: pathQuery(true, {
      recursive: { type: "string", enum: ["true", "false"], description: "Remove a non-empty directory's subtree" },
    }),
    response: {
      200: { description: "Removal result", ...toJsonSchema(FsRemoveResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
} satisfies Record<string, FastifySchema>;

export const fsDocs: Record<keyof typeof docs, FastifySchema> = docs;
