import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BenchmarkImportBodySchema, BenchmarkPreviewBodySchema } from "../../core/benchmark/benchmark-service.js";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// Benchmark MCP tools — the MCP twin of benchmark.routes.ts.
export function registerBenchmarkTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.benchmarkService) {
    const benchmarks = deps.benchmarkService;
    server.registerTool(
      "search_hf_datasets",
      {
        description:
          "Search HuggingFace Hub datasets — find candidates ({id,likes,gated}) by query when you don't know the exact id.",
        inputSchema: { query: z.string(), limit: z.number().int().positive().max(50).optional() },
      },
      ({ query, limit }) =>
        run(principal, "datasets:read", async () => ok(await benchmarks.searchHf(ws, query, limit, principal.subject))),
    );
    server.registerTool(
      "hf_dataset_splits",
      {
        description:
          "List the config/split combinations of a chosen HF dataset (to pick a split instead of typing it).",
        inputSchema: { dataset: z.string() },
      },
      ({ dataset }) =>
        run(principal, "datasets:read", async () => ok(await benchmarks.hfSplits(ws, dataset, principal.subject))),
    );
    server.registerTool(
      "hf_dataset_files",
      {
        description:
          "List an HF repo's data files (csv/jsonl/json) — fallback to fetch files directly (source.file) for datasets not served by the viewer (datasets-server).",
        inputSchema: { dataset: z.string() },
      },
      ({ dataset }) =>
        run(principal, "datasets:read", async () => ok(await benchmarks.hfFiles(ws, dataset, principal.subject))),
    );
    server.registerTool(
      "preview_benchmark_source",
      {
        description:
          "Preview a benchmark source — N raw rows before mapping + detected fields (to check before mapping when you don't know the field names). body=preview JSON {source:{kind:'huggingface',dataset,config?,split?}|{kind:'jsonl'}, text?, limit?}",
        inputSchema: { body: z.string().describe("preview body JSON") },
      },
      ({ body }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: not a valid preview JSON.");
          }
          const result = BenchmarkPreviewBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await benchmarks.previewSource({ tenant: ws, subject: principal.subject, ...result.data }));
        }),
    );
    server.registerTool(
      "import_benchmark",
      {
        description:
          "Import a benchmark as a dataset in this workspace (immutable; 409 on conflict) — one of spec (inline definition) · benchmark (catalog id) · recipe. body=import JSON {spec?|benchmark?|recipe?, id?, version?, limit?, text?}",
        inputSchema: { body: z.string().describe("import body JSON") },
      },
      ({ body }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: not a valid import JSON.");
          }
          const result = BenchmarkImportBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await benchmarks.import({ tenant: ws, createdBy: principal.subject, ...result.data }));
        }),
    );
  }
}
