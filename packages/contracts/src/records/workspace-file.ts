import { z } from "zod";
import { BadRequestError } from "../errors.js";

// The workspace filesystem — a first-class, workspace-isolated file tree every surface shares: agents write task
// outputs and artifacts to it, skills/knowledge bodies live on it, and the web browses it like a shell. Backed by
// object storage (S3/MinIO — distributed by construction) or memory (dev). Paths are workspace-RELATIVE and
// canonical: "" is the root, "a/b/c" a nested file — never a leading/trailing slash. Isolation is enforced at the
// filesystem implementation (tenant → key prefix), not trusted to callers.

// Bounds: one file stays a sane object + API payload; a directory listing stays a sane response.
export const FS_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB per file
export const FS_PATH_MAX_CHARS = 512;
export const FS_PATH_MAX_DEPTH = 24;

const FS_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// Normalize a user/agent-supplied path to canonical form ("" = root, else "a/b/c"). Accepts leading "/", "./",
// repeated slashes and surrounding whitespace; REJECTS traversal ("..") and characters outside the safe set —
// the one gate every filesystem operation funnels through, so a path can never escape the workspace prefix.
export function normalizeFsPath(input: string): string {
  const raw = input.trim();
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new BadRequestError("BAD_REQUEST", { path: input }, "path must not contain '..' segments");
  }
  for (const segment of segments) {
    if (!FS_SEGMENT_RE.test(segment)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { path: input, segment },
        "path segments allow letters, digits, '.', '_' and '-' only",
      );
    }
  }
  const path = segments.join("/");
  if (path.length > FS_PATH_MAX_CHARS) {
    throw new BadRequestError("BAD_REQUEST", { path: input }, `path exceeds ${FS_PATH_MAX_CHARS} characters`);
  }
  if (segments.length > FS_PATH_MAX_DEPTH) {
    throw new BadRequestError("BAD_REQUEST", { path: input }, `path exceeds ${FS_PATH_MAX_DEPTH} segments`);
  }
  return path;
}

// A canonical path that must name an entry (not the root) — write/stat/remove/move targets.
export const FsPathSchema = z
  .string()
  .min(1)
  .max(FS_PATH_MAX_CHARS)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "canonical workspace-relative path (letters, digits, . _ -)");

export const FsEntryKindSchema = z.enum(["file", "dir"]);
export type FsEntryKind = z.infer<typeof FsEntryKindSchema>;

// One entry in the workspace tree. `size`/`contentType`/`modifiedAt` are file-only (a dir is a prefix — object
// storage has no dir mtime); `name` duplicates the last path segment so listings render without re-splitting.
export const FsEntrySchema = z.object({
  path: z.string(), // canonical workspace-relative path
  name: z.string(), // last path segment
  kind: FsEntryKindSchema,
  size: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
  modifiedAt: z.string().optional(), // ISO timestamp
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

// Extension → content type for the common workspace-file formats (fallback: octet-stream). Pure convenience for
// the API/web/agent layers so a written file round-trips with a sensible type without the caller stating one.
const FS_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  jsonl: "application/jsonl",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  py: "text/x-python; charset=utf-8",
  svg: "image/svg+xml",
  toml: "application/toml",
  ts: "text/typescript; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

export function guessFsContentType(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return FS_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Is this content type renderable as text in the web viewer / safe to return inline as utf-8?
export function isFsTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.startsWith("application/json") ||
    contentType === "application/jsonl" ||
    contentType === "application/xml" ||
    contentType === "application/yaml" ||
    contentType === "application/toml" ||
    contentType === "image/svg+xml"
  );
}
