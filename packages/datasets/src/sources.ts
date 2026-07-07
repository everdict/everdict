import { UpstreamError } from "@everdict/core";
import { parseCsv } from "./mapping.js";

// Benchmark source connectors: fetch rows by reference from where the benchmark "lives" (no dependency on local files).
// Most new benchmarks land on HuggingFace Hub, so the HF datasets-server REST (/rows) is supported as the primary source.
// Network calls are abstracted behind an injectable FetchLike → mapping/paging logic is tested deterministically, real fetching uses the global fetch.

export interface HfRowsParams {
  dataset: string; // e.g. "openai/gsm8k"
  config?: string; // default "default"
  split?: string; // default "train"
  limit?: number; // total fetch cap — absent = the FULL dataset (paged; imports must not silently truncate)
  token?: string; // for gated datasets (Authorization: Bearer) — injected from the tenant SecretStore
}

// Minimal fetch signature for test injection (compatible with the global fetch). The body is taken via text() then JSON.parse (robust/simple).
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const HF_ROWS = "https://datasets-server.huggingface.co/rows";
const HF_PAGE = 100; // max length per datasets-server call.
const HF_TIMEOUT_MS = 8000; // upper bound on waiting for an HF response — fail cleanly instead of hanging forever when unreachable.

// Shared HF call: timeout + remap failures to our UpstreamError (502). Instead of exposing a raw fetch error ("fetch failed"/AbortError) or
// a non-2xx as-is, turn it into a human-friendly message the wizard can show "naturally" (handling the unreachable case).
async function hfGet(
  f: FetchLike,
  url: string,
  headers: Record<string, string>,
  label: string,
  timeoutMs = HF_TIMEOUT_MS,
): Promise<string> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // network failure/timeout/abort — HF is unreachable.
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { source: "huggingface", reason: "unreachable" },
      "Cannot reach HuggingFace. Check your network or try again shortly.",
    );
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    // 401/403 is likely a gated-access issue, so give actionable guidance (two checkpoints: terms acceptance + token permission).
    const denied =
      res.status === 401 || res.status === 403
        ? `HuggingFace access was denied (${res.status}). For a gated dataset, check ① whether your HF account accepted the dataset's terms (requested access) and ② whether the token has read permission for this repository.`
        : `HuggingFace response error (${res.status}).`;
    throw new UpstreamError("UPSTREAM_ERROR", { source: "huggingface", status: res.status }, denied);
  }
  return body;
}

function hfParse<T>(body: string, label: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { source: "huggingface" },
      `Could not parse the HuggingFace response (${label}).`,
    );
  }
}

interface HfRowsResponse {
  rows?: Array<{ row: Record<string, unknown> }>;
  num_rows_total?: number;
}

// Fetch rows via HF datasets-server /rows (paging 100 at a time as needed). Authenticate with token if gated.
// No limit = the FULL dataset (paged to num_rows_total) — an import must never silently truncate
// (docs/datasets.md: "import is always the full dataset"); callers cap explicitly (e.g. preview's limit 5).
export async function fetchHfRows(p: HfRowsParams, fetchImpl?: FetchLike): Promise<Array<Record<string, unknown>>> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfRows: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const config = p.config ?? "default";
  const split = p.split ?? "train";
  const limit = p.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(1, p.limit);
  const headers: Record<string, string> = {};
  if (p.token) headers.Authorization = `Bearer ${p.token}`;

  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; rows.length < limit; offset += HF_PAGE) {
    const length = Math.min(HF_PAGE, limit - rows.length);
    const url =
      `${HF_ROWS}?dataset=${encodeURIComponent(p.dataset)}` +
      `&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}` +
      `&offset=${offset}&length=${length}`;
    const body = await hfGet(f, url, headers, "rows");
    const json = hfParse<HfRowsResponse>(body, "rows");
    const page = (json.rows ?? []).map((r) => r.row);
    rows.push(...page);
    const total = json.num_rows_total ?? rows.length;
    if (page.length === 0 || rows.length >= total) break;
  }
  return rows.slice(0, limit);
}

const HF_HUB = "https://huggingface.co/api/datasets";
const HF_SPLITS = "https://datasets-server.huggingface.co/splits";

// A single HF Hub dataset search result (minimal meta for selection). Fetching a gated one needs HF_TOKEN.
export interface HfDatasetHit {
  id: string;
  likes: number;
  gated: boolean;
}

// HF Hub dataset search — pick a candidate by query even without knowing the exact id (avoids raw input). Public search needs no token.
export async function searchHfDatasets(
  query: string,
  opts: { limit?: number; token?: string; fetchImpl?: FetchLike } = {},
): Promise<HfDatasetHit[]> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("searchHfDatasets: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const url = `${HF_HUB}?search=${encodeURIComponent(query)}&limit=${limit}&sort=downloads&direction=-1&full=false`;
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = await hfGet(f, url, headers, "search");
  const arr = hfParse<Array<{ id?: unknown; likes?: unknown; gated?: unknown; private?: unknown }>>(body, "search");
  return arr
    .filter((d) => d.private !== true && typeof d.id === "string")
    .map((d) => ({
      id: String(d.id),
      likes: typeof d.likes === "number" ? d.likes : 0,
      // HF's gated is false | "auto" | "manual".
      gated: Boolean(d.gated) && d.gated !== "false",
    }));
}

// config/split combinations from HF datasets-server — the user picks the split from a dropdown instead of typing it.
export interface HfSplit {
  config: string;
  split: string;
}

export async function fetchHfSplits(
  dataset: string,
  opts: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<HfSplit[]> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfSplits: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = await hfGet(f, `${HF_SPLITS}?dataset=${encodeURIComponent(dataset)}`, headers, "splits");
  const json = hfParse<{ splits?: Array<{ config?: unknown; split?: unknown }> }>(body, "splits");
  return (json.splits ?? [])
    .filter((s) => typeof s.config === "string" && typeof s.split === "string")
    .map((s) => ({ config: String(s.config), split: String(s.split) }));
}

// --- Direct file-fetch fallback — for datasets the datasets-server (viewer) doesn't serve (officeqa-style: a gated repo with no viewer) ---
// Without a viewer, /rows 404s so even a valid token can't fetch. Download the repo's data file (csv/jsonl/json)
// directly via the Hub resolve API and parse it (gated uses the same HF_TOKEN auth).

const DATA_FILE_RE = /\.(csv|jsonl|json)$/i;

// List of the repo's data files — for the file-fallback dropdown. The file list (siblings) is public metadata (queryable even when gated).
export async function fetchHfDataFiles(
  dataset: string,
  opts: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<string[]> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfDataFiles: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = await hfGet(f, `${HF_HUB}/${dataset}?full=true`, headers, "files");
  const json = hfParse<{ siblings?: Array<{ rfilename?: unknown }> }>(body, "files");
  const depth = (p: string) => p.split("/").length;
  return (
    (json.siblings ?? [])
      .map((s) => (typeof s.rfilename === "string" ? s.rfilename : ""))
      .filter((p) => DATA_FILE_RE.test(p))
      // Root files first — so the benchmark CSV isn't buried under a large corpus's sub-files (e.g. officeqa's ~1000 parsed json files).
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  );
}

export interface HfFileRowsParams {
  dataset: string;
  file: string; // path within the repo (e.g. "officeqa_pro.csv")
  limit?: number; // unset = the whole file (files are downloaded wholesale anyway)
  token?: string;
}

// Data file → rows. Parse by extension (csv/jsonl/json array). Files have no viewer paging, so download wholesale and slice.
export async function fetchHfFileRows(
  p: HfFileRowsParams,
  fetchImpl?: FetchLike,
): Promise<Array<Record<string, unknown>>> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfFileRows: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const headers: Record<string, string> = {};
  if (p.token) headers.Authorization = `Bearer ${p.token}`;
  const url = `https://huggingface.co/datasets/${p.dataset}/resolve/main/${encodeURI(p.file)}`;
  const body = await hfGet(f, url, headers, "file", 30_000); // files can be larger than the viewer API, so a generous timeout
  let rows: Array<Record<string, unknown>>;
  if (/\.csv$/i.test(p.file)) {
    rows = parseCsv(body);
  } else if (/\.jsonl$/i.test(p.file)) {
    rows = body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => hfParse<Record<string, unknown>>(l, "file"));
  } else {
    const parsed = hfParse<unknown>(body, "file");
    if (!Array.isArray(parsed))
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { source: "huggingface", file: p.file },
        "A JSON data file must be an array (a list of rows).",
      );
    rows = parsed as Array<Record<string, unknown>>;
  }
  return p.limit !== undefined ? rows.slice(0, Math.max(1, p.limit)) : rows;
}
