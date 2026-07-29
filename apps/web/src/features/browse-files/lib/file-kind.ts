import type { CodeLanguage } from '@/shared/ui/code-editor'

// What a workspace file IS, from the viewer's point of view. The control plane already decided the two things
// the web cannot: the content type (`guessFsContentType`) and whether the bytes round-trip as utf-8 (`encoding`).
// This module turns that pair into a rendering decision, and maps a path onto an editor language.
//
// The type tables below deliberately MIRROR `@everdict/contracts` rather than import it: the web is
// runtime-decoupled (type-only imports from contracts), so a shared runtime table is not available here. Keep
// them in step with `packages/contracts/src/records/workspace-file.ts` when a format is added there.

export type FilePreviewKind =
  | 'markdown' // rendered prose, with a raw toggle
  | 'table' // csv/tsv, rendered as a grid
  | 'image' // incl. svg, which arrives as text but renders as a picture
  | 'pdf' // embedded document viewer
  | 'audio'
  | 'video'
  | 'code' // any other text: highlighted, editable
  | 'document' // office formats — a readable deliverable we cannot render inline yet
  | 'archive'
  | 'binary'

const DOCUMENT_CONTENT_TYPES = new Set([
  'application/epub+zip',
  'application/msword',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/x-hwp',
  'application/x-hwpx',
])

const ARCHIVE_CONTENT_TYPES = new Set([
  'application/gzip',
  'application/java-archive',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'application/x-tar',
  'application/x-xz',
  'application/zip',
])

function baseContentType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

function extensionOf(path: string): string {
  const name = (path.split('/').at(-1) ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

export function isMarkdownPath(path: string): boolean {
  return ['md', 'markdown', 'mdx'].includes(extensionOf(path))
}

export function isTabularPath(path: string): boolean {
  return ['csv', 'tsv'].includes(extensionOf(path))
}

// The medium wins over the encoding: an svg is text (so it stays editable) but it is still a picture, and a
// reader wants to see it. Everything else that came back as utf-8 is prose, a table, or code.
export function previewKindFor(
  path: string,
  contentType: string | undefined,
  encoding: 'utf8' | 'base64'
): FilePreviewKind {
  const base = baseContentType(contentType)
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('audio/')) return 'audio'
  if (base.startsWith('video/')) return 'video'
  if (base === 'application/pdf') return 'pdf'
  if (encoding === 'utf8') {
    if (isMarkdownPath(path)) return 'markdown'
    if (isTabularPath(path)) return 'table'
    return 'code'
  }
  if (DOCUMENT_CONTENT_TYPES.has(base)) return 'document'
  if (ARCHIVE_CONTENT_TYPES.has(base)) return 'archive'
  return 'binary'
}

// Which kinds have a "look at the source instead" mode. Code is already its own source, so it has none.
export function supportsRawView(kind: FilePreviewKind, encoding: 'utf8' | 'base64'): boolean {
  return encoding === 'utf8' && (kind === 'markdown' || kind === 'table' || kind === 'image')
}

// Whether the browser can show the file at all. What it cannot show, it can still hand over — see the viewer's
// download action, which is the ONLY thing on offer for these.
export function isOpaquePreview(kind: FilePreviewKind): boolean {
  return kind === 'document' || kind === 'archive' || kind === 'binary'
}

const LANGUAGE_BY_EXTENSION: Record<string, CodeLanguage> = {
  // JavaScript family — also the best available reading of JSON and its dialects
  cjs: 'node',
  cts: 'node',
  geojson: 'node',
  ipynb: 'node',
  js: 'node',
  json: 'node',
  json5: 'node',
  jsonc: 'node',
  jsonl: 'node',
  jsx: 'node',
  mjs: 'node',
  mts: 'node',
  ndjson: 'node',
  ts: 'node',
  tsx: 'node',

  py: 'python',
  pyi: 'python',

  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  dart: 'dart',
  go: 'go',
  gradle: 'groovy',
  groovy: 'groovy',
  hs: 'haskell',
  java: 'java',
  jl: 'julia',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  php: 'plain', // no bundled mode — plain beats mis-colouring
  pl: 'perl',
  pm: 'perl',
  ps1: 'powershell',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  scala: 'scala',
  swift: 'swift',
  clj: 'clojure',
  cljs: 'clojure',
  erl: 'erlang',
  ex: 'plain',
  exs: 'plain',

  bash: 'shell',
  fish: 'shell',
  sh: 'shell',
  zsh: 'shell',

  css: 'css',
  less: 'less',
  sass: 'scss',
  scss: 'scss',

  htm: 'html',
  html: 'html',
  svg: 'xml',
  xhtml: 'html',
  xml: 'xml',

  cfg: 'properties',
  conf: 'properties',
  env: 'properties',
  ini: 'properties',
  properties: 'properties',

  diff: 'diff',
  patch: 'diff',
  http: 'http',
  proto: 'protobuf',
  sql: 'sql',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
}

const LANGUAGE_BY_NAME: Record<string, CodeLanguage> = {
  containerfile: 'dockerfile',
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  gnumakefile: 'shell',
  jenkinsfile: 'groovy',
  justfile: 'shell',
  makefile: 'shell',
  rakefile: 'ruby',
  vagrantfile: 'ruby',
}

// The editor language for a path. Anything unrecognised reads as plain text — the file still opens, with line
// numbers and no invented syntax.
export function languageFor(path: string): CodeLanguage {
  const name = (path.split('/').at(-1) ?? '').toLowerCase()
  const byName = LANGUAGE_BY_NAME[name]
  if (byName !== undefined) return byName
  const byExtension = LANGUAGE_BY_EXTENSION[extensionOf(path)]
  return byExtension ?? 'plain'
}
