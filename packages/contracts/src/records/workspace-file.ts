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
// `revision` is the file's CURRENT published revision (see FsRevisionSchema) — carried on the single-entry reads
// (stat/read/write) that already cost one revision lookup, never on a listing (that would be a query per row).
export const FsEntrySchema = z.object({
  path: z.string(), // canonical workspace-relative path
  name: z.string(), // last path segment
  kind: FsEntryKindSchema,
  size: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
  modifiedAt: z.string().optional(), // ISO timestamp
  revision: z.number().int().positive().optional(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

// WHO published a revision. A workspace file is written by members AND by agents acting for them, so authorship is
// two-part: `actor` is who did the writing (an agent is a first-class author, carrying the agent + conversation it
// ran in), `onBehalfOf` the member whose request it was. A member's own edit leaves onBehalfOf empty.
// `system` covers writes with no request behind them (a projection/migration/backfill).
export const FsActorKindSchema = z.enum(["member", "agent", "system"]);
export type FsActorKind = z.infer<typeof FsActorKindSchema>;

export const FsActorSchema = z.object({
  kind: FsActorKindSchema,
  subject: z.string(), // the authenticated subject (member sub / api-key owner); "" for system
  agentId: z.string().optional(), // kind=agent: which agent
  agentName: z.string().optional(), // kind=agent: its display name at write time (agents get renamed/deleted)
  conversationId: z.string().optional(), // kind=agent: the conversation the write happened in (deep-linkable)
  onBehalfOf: z.string().optional(), // kind=agent: the member who asked for the work
});
export type FsActor = z.infer<typeof FsActorSchema>;

export const FS_SYSTEM_ACTOR: FsActor = { kind: "system", subject: "" };

// One PUBLISHED revision of a file — the audit unit of the workspace filesystem: who published what, when, and on
// top of which revision. Revisions are per-path, 1-based and gapless (`revision` is allocated under a uniqueness
// constraint, so two concurrent writers can never claim the same number), append-only (a restore publishes a NEW
// revision holding an old one's bytes — history is never rewritten) and retained indefinitely.
export const FsRevisionSchema = z.object({
  tenant: z.string(),
  path: z.string(), // the path AT THE TIME of listing — a move carries a file's history with it
  revision: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  hash: z.string(), // sha256 hex of the content — equal hashes mean equal bytes (no-op detection, dedup)
  actor: FsActorSchema,
  message: z.string().max(500).optional(), // optional "why" the author attached to the publish
  restoredFrom: z.number().int().positive().optional(), // this revision re-published that revision's bytes
  createdAt: z.string(),
});
export type FsRevision = z.infer<typeof FsRevisionSchema>;

// A three-way merge of one file: the two sides that diverged from a common base, reconciled line by line.
// A hunk both sides changed differently is a CONFLICT — reported with both texts so the resolver (a member in the
// merge dialog, or an agent reading the tool error) can choose, rather than being handed a silent overwrite.
export const FsMergeConflictSchema = z.object({
  line: z.number().int().nonnegative(), // 0-based line in `merged` where the conflict block starts
  base: z.string(), // the common ancestor's text for the hunk
  ours: z.string(), // the incoming write's text
  theirs: z.string(), // what was published while the writer was away
});
export type FsMergeConflict = z.infer<typeof FsMergeConflictSchema>;

// `merged` always holds a full document: conflict-free hunks are already reconciled, and each conflicting hunk is
// rendered with the familiar `<<<<<<< / ======= / >>>>>>>` markers so the text stays editable as-is.
export const FsMergeResultSchema = z.object({
  merged: z.string(),
  conflicts: z.array(FsMergeConflictSchema),
});
export type FsMergeResult = z.infer<typeof FsMergeResultSchema>;

// ─── File types ──────────────────────────────────────────────────────────────────────────────────────────────
// The workspace filesystem is a general-purpose tree: an agent drops a spreadsheet next to a shell script next
// to a screenshot. So the type registry aims for BREADTH — office formats and the development long tail both —
// rather than the handful the first surfaces happened to need. An unmapped extension degrades to
// application/octet-stream, which every surface then treats as an opaque blob (no inline text, download only);
// that fallback is a last resort, not the answer for an ordinary file.
//
// Source formats with no registered IANA type deliberately get `text/x-<lang>`: the `text/` prefix makes them
// text-detectable for free, so adding a language never needs a matching entry in the text allowlist below.

const FS_TEXT = "; charset=utf-8";
const FS_PLAIN_TEXT = `text/plain${FS_TEXT}`;
const FS_BINARY = "application/octet-stream";

// Extension (lowercase, no dot) → content type.
const FS_CONTENT_TYPES: Record<string, string> = {
  // Prose, markup, tabular text
  adoc: `text/asciidoc${FS_TEXT}`,
  csv: `text/csv${FS_TEXT}`,
  htm: `text/html${FS_TEXT}`,
  html: `text/html${FS_TEXT}`,
  log: FS_PLAIN_TEXT,
  markdown: `text/markdown${FS_TEXT}`,
  md: `text/markdown${FS_TEXT}`,
  mdx: `text/markdown${FS_TEXT}`,
  org: `text/x-org${FS_TEXT}`,
  rst: `text/x-rst${FS_TEXT}`,
  tex: `text/x-tex${FS_TEXT}`,
  text: FS_PLAIN_TEXT,
  tsv: `text/tab-separated-values${FS_TEXT}`,
  txt: FS_PLAIN_TEXT,
  xhtml: `text/html${FS_TEXT}`,

  // Structured data / config
  cfg: FS_PLAIN_TEXT,
  conf: FS_PLAIN_TEXT,
  env: FS_PLAIN_TEXT,
  geojson: "application/geo+json",
  hcl: `text/x-hcl${FS_TEXT}`,
  ini: FS_PLAIN_TEXT,
  ipynb: "application/x-ipynb+json",
  json: "application/json",
  json5: "application/json5",
  jsonc: "application/json",
  jsonl: "application/jsonl",
  lock: FS_PLAIN_TEXT,
  ndjson: "application/jsonl",
  nomad: `text/x-hcl${FS_TEXT}`,
  properties: FS_PLAIN_TEXT,
  proto: `text/x-protobuf${FS_TEXT}`,
  tf: `text/x-hcl${FS_TEXT}`,
  tfvars: `text/x-hcl${FS_TEXT}`,
  toml: "application/toml",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",

  // Stylesheets + web components
  astro: `text/x-astro${FS_TEXT}`,
  css: `text/css${FS_TEXT}`,
  less: `text/x-less${FS_TEXT}`,
  sass: `text/x-sass${FS_TEXT}`,
  scss: `text/x-scss${FS_TEXT}`,
  styl: `text/x-styl${FS_TEXT}`,
  svelte: `text/x-svelte${FS_TEXT}`,
  vue: `text/x-vue${FS_TEXT}`,

  // JavaScript / TypeScript family
  cjs: `text/javascript${FS_TEXT}`,
  cts: `text/typescript${FS_TEXT}`,
  js: `text/javascript${FS_TEXT}`,
  jsx: `text/javascript${FS_TEXT}`,
  mjs: `text/javascript${FS_TEXT}`,
  mts: `text/typescript${FS_TEXT}`,
  ts: `text/typescript${FS_TEXT}`,
  tsx: `text/typescript${FS_TEXT}`,

  // Programming languages
  c: `text/x-c${FS_TEXT}`,
  cc: `text/x-c++${FS_TEXT}`,
  clj: `text/x-clojure${FS_TEXT}`,
  cljs: `text/x-clojure${FS_TEXT}`,
  cpp: `text/x-c++${FS_TEXT}`,
  cs: `text/x-csharp${FS_TEXT}`,
  cxx: `text/x-c++${FS_TEXT}`,
  dart: `text/x-dart${FS_TEXT}`,
  erl: `text/x-erlang${FS_TEXT}`,
  ex: `text/x-elixir${FS_TEXT}`,
  exs: `text/x-elixir${FS_TEXT}`,
  go: `text/x-go${FS_TEXT}`,
  gradle: `text/x-groovy${FS_TEXT}`,
  groovy: `text/x-groovy${FS_TEXT}`,
  h: `text/x-c${FS_TEXT}`,
  hpp: `text/x-c++${FS_TEXT}`,
  hs: `text/x-haskell${FS_TEXT}`,
  java: `text/x-java${FS_TEXT}`,
  jl: `text/x-julia${FS_TEXT}`,
  kt: `text/x-kotlin${FS_TEXT}`,
  kts: `text/x-kotlin${FS_TEXT}`,
  lua: `text/x-lua${FS_TEXT}`,
  php: `text/x-php${FS_TEXT}`,
  pl: `text/x-perl${FS_TEXT}`,
  pm: `text/x-perl${FS_TEXT}`,
  py: `text/x-python${FS_TEXT}`,
  pyi: `text/x-python${FS_TEXT}`,
  r: `text/x-r${FS_TEXT}`,
  rb: `text/x-ruby${FS_TEXT}`,
  rs: `text/x-rust${FS_TEXT}`,
  scala: `text/x-scala${FS_TEXT}`,
  sol: `text/x-solidity${FS_TEXT}`,
  swift: `text/x-swift${FS_TEXT}`,
  zig: `text/x-zig${FS_TEXT}`,

  // Queries + schemas
  graphql: `text/x-graphql${FS_TEXT}`,
  gql: `text/x-graphql${FS_TEXT}`,
  sql: `text/x-sql${FS_TEXT}`,

  // Shell + patches
  bash: `text/x-shellscript${FS_TEXT}`,
  bat: `text/x-bat${FS_TEXT}`,
  cmd: `text/x-bat${FS_TEXT}`,
  diff: `text/x-diff${FS_TEXT}`,
  fish: `text/x-shellscript${FS_TEXT}`,
  patch: `text/x-diff${FS_TEXT}`,
  ps1: `text/x-powershell${FS_TEXT}`,
  sh: `text/x-shellscript${FS_TEXT}`,
  zsh: `text/x-shellscript${FS_TEXT}`,

  // Certificates + keys (PEM is text; a DER-encoded body still round-trips as base64)
  cer: FS_PLAIN_TEXT,
  crt: FS_PLAIN_TEXT,
  key: FS_PLAIN_TEXT,
  pem: FS_PLAIN_TEXT,
  pub: FS_PLAIN_TEXT,

  // Images
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",

  // Audio / video
  aac: "audio/aac",
  avi: "video/x-msvideo",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webm: "video/webm",

  // Office / portable documents
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  hwp: "application/x-hwp",
  hwpx: "application/x-hwpx",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: "application/pdf",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

  // Archives
  "7z": "application/x-7z-compressed",
  bz2: "application/x-bzip2",
  gz: "application/gzip",
  jar: "application/java-archive",
  rar: "application/vnd.rar",
  tar: "application/x-tar",
  tgz: "application/gzip",
  whl: "application/zip",
  xz: "application/x-xz",
  zip: "application/zip",

  // Fonts
  eot: "application/vnd.ms-fontobject",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",

  // Opaque binaries (datasets, builds, models)
  bin: FS_BINARY,
  db: "application/vnd.sqlite3",
  dll: FS_BINARY,
  dylib: FS_BINARY,
  exe: "application/vnd.microsoft.portable-executable",
  npy: FS_BINARY,
  npz: FS_BINARY,
  parquet: "application/vnd.apache.parquet",
  pkl: FS_BINARY,
  pyc: FS_BINARY,
  so: FS_BINARY,
  sqlite: "application/vnd.sqlite3",
  sqlite3: "application/vnd.sqlite3",
  wasm: "application/wasm",
};

// Extension-less files that are text by convention. Matched on the whole (lowercased) name.
const FS_NAMED_CONTENT_TYPES: Record<string, string> = {
  authors: FS_PLAIN_TEXT,
  brewfile: `text/x-ruby${FS_TEXT}`,
  changelog: `text/markdown${FS_TEXT}`,
  codeowners: FS_PLAIN_TEXT,
  containerfile: `text/x-dockerfile${FS_TEXT}`,
  contributing: `text/markdown${FS_TEXT}`,
  dockerfile: `text/x-dockerfile${FS_TEXT}`,
  gemfile: `text/x-ruby${FS_TEXT}`,
  gnumakefile: `text/x-makefile${FS_TEXT}`,
  jenkinsfile: `text/x-groovy${FS_TEXT}`,
  justfile: `text/x-makefile${FS_TEXT}`,
  licence: FS_PLAIN_TEXT,
  license: FS_PLAIN_TEXT,
  makefile: `text/x-makefile${FS_TEXT}`,
  notice: FS_PLAIN_TEXT,
  procfile: FS_PLAIN_TEXT,
  rakefile: `text/x-ruby${FS_TEXT}`,
  readme: `text/markdown${FS_TEXT}`,
  vagrantfile: `text/x-ruby${FS_TEXT}`,
};

// Best-effort content type for a path: exact name → extension → dotfile convention → opaque blob. Pure
// convenience for the API/web/agent layers, so a written file round-trips with a sensible type without the
// caller stating one; an explicit contentType on write always wins over this guess.
export function guessFsContentType(path: string): string {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const named = FS_NAMED_CONTENT_TYPES[name];
  if (named !== undefined) return named;
  const dot = name.lastIndexOf(".");
  const byExtension = dot > 0 ? FS_CONTENT_TYPES[name.slice(dot + 1)] : undefined;
  if (byExtension !== undefined) return byExtension;
  // A leading dot means configuration by convention (.gitignore, .env.local, .npmrc) — text, not a blob.
  // `.env.local` never reaches the extension lookup with a useful key, which is exactly why this comes after it.
  if (name.startsWith(".") && name.length > 1) return FS_PLAIN_TEXT;
  return FS_BINARY;
}

// `application/*` types whose payload is text but whose name says nothing of the sort. Everything with a
// `text/` prefix or a structured `+json`/`+xml`/`+yaml` suffix is covered by the rules in isFsTextContentType.
const FS_TEXT_APPLICATION_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/json5",
  "application/jsonl",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-sh",
  "application/xml",
  "application/yaml",
]);

const FS_DOCUMENT_TYPES = new Set([
  "application/epub+zip",
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-hwp",
  "application/x-hwpx",
]);

const FS_ARCHIVE_TYPES = new Set([
  "application/gzip",
  "application/java-archive",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-tar",
  "application/x-xz",
  "application/zip",
]);

// The parameters (`; charset=utf-8`) are presentation, never part of the identity of the type.
function baseContentType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

// Can this content type round-trip as utf-8 text — inline in an API response, editable in the web viewer?
// This is the ENCODING axis, deliberately separate from fsFileClassOf's presentation axis: `image/svg+xml` is
// both text (it is markup, so it edits) and an image (so it renders). Only the ones that can be BOTH differ.
export function isFsTextContentType(contentType: string): boolean {
  const base = baseContentType(contentType);
  return (
    base.startsWith("text/") ||
    base.endsWith("+json") ||
    base.endsWith("+xml") ||
    base.endsWith("+yaml") ||
    FS_TEXT_APPLICATION_TYPES.has(base)
  );
}

// How a file wants to be PRESENTED — the shared vocabulary behind the web viewer's preview and the agent's
// "what did I just read" reasoning. `document` (office formats) is deliberately split off `binary`: it is a
// human-readable deliverable we cannot render inline YET, and telling those apart is what lets a surface offer
// "open in your editor" instead of a shrug.
export const FsFileClassSchema = z.enum(["text", "image", "audio", "video", "pdf", "document", "archive", "binary"]);
export type FsFileClass = z.infer<typeof FsFileClassSchema>;

export function fsFileClassOf(contentType: string): FsFileClass {
  const base = baseContentType(contentType);
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("audio/")) return "audio";
  if (base.startsWith("video/")) return "video";
  if (base === "application/pdf") return "pdf";
  if (FS_DOCUMENT_TYPES.has(base)) return "document";
  if (FS_ARCHIVE_TYPES.has(base)) return "archive";
  if (isFsTextContentType(base)) return "text";
  return "binary";
}
