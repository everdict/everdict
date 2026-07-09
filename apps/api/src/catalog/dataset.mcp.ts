import { DatasetSchema } from "@everdict/core";
import {
  HarborTaskSchema,
  TerminalBenchTaskSchema,
  diffDatasets,
  harborToDataset,
  terminalBenchToDataset,
} from "@everdict/datasets";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";
import { deleteDatasetVersion } from "./dataset-service.js";
import { setVersionTags } from "./version-tag-service.js";

// Dataset MCP tools — the MCP twin of dataset.routes.ts.
export function registerDatasetTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.datasetRegistry) {
    const datasets = deps.datasetRegistry;
    server.registerTool(
      "list_datasets",
      {
        description:
          "Datasets this workspace sees (owned + _shared benchmarks). The workspace is the 'active workspace' fixed by your credential — confirm with the user which workspace you are working in first (you cannot change it via a parameter; a different workspace requires reconnecting with that workspace's credential/session). Each entry groups multiple immutable versions under one id (id → versions[]). Before creating a new dataset, first use this list to check whether the same id already exists.",
        inputSchema: {},
      },
      () => run(principal, "datasets:read", async () => ok(await datasets.list(ws))),
    );

    server.registerTool(
      "get_dataset",
      {
        description:
          "One dataset in full (cases included). Since one id holds multiple immutable versions, pick a specific one via version (default latest). Active-workspace scoped — confirm with the user which workspace it is (another workspace's id is NOT_FOUND).",
        inputSchema: {
          id: z.string().describe("dataset id (unique within this workspace; the same id groups multiple versions)"),
          version: z.string().optional().describe("semver version or latest (default). latest if omitted"),
        },
      },
      ({ id, version }) =>
        run(principal, "datasets:read", async () => ok(await datasets.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "diff_datasets",
      {
        description:
          "Diff of two dataset versions — cases added/removed/changed (with the differing fields) + metadata changes. base/candidate may be 'latest'. Another workspace is NOT_FOUND",
        inputSchema: {
          id: z.string(),
          base: z.string().describe("base version (e.g. 1.0.0 or latest)"),
          candidate: z.string().describe("comparison version (e.g. 1.1.0 or latest)"),
        },
      },
      ({ id, base, candidate }) =>
        run(principal, "datasets:read", async () => {
          const [baseDs, candidateDs] = await Promise.all([
            datasets.get(ws, id, base),
            datasets.get(ws, id, candidate),
          ]);
          return ok(diffDatasets(baseDs, candidateDs));
        }),
    );

    server.registerTool(
      "validate_dataset",
      {
        description:
          "Dry-run validate a Dataset (JSON) (does not register) — shows the schema result + this active workspace's existing versions/collision for the same id (existingVersions, versionExists). Use this before create_dataset to decide 'does the id already exist → bump to a new version' (do not duplicate the same dataset under a new id).",
        inputSchema: { dataset: z.string().describe("Dataset JSON (id·version·cases)") },
      },
      ({ dataset }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataset);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = DatasetSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await datasets.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            id: result.data.id,
            version: result.data.version,
            cases: result.data.cases.length,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_dataset",
      {
        description:
          "Register a Dataset (JSON string) as owned by the active workspace (versions immutable; re-registering the same id@version with different content is CONFLICT). Before registering, always confirm in order: (1) workspace — confirm with the user which workspace (fixed by credential, not changeable via a parameter). (2) id — one id groups multiple versions. If you are adding/editing cases in the same dataset, reuse the existing id and bump to a new 'version' (e.g. 1.0.0 → 1.1.0). Do not flatten into a new id each time. (3) version — a new semver that doesn't collide with an existing one. First check existing ids/versions via list_datasets/validate_dataset.",
        inputSchema: { dataset: z.string().describe("Dataset JSON (id·version·cases)") },
      },
      ({ dataset }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataset);
          } catch {
            return fail("BAD_REQUEST: not a valid Dataset JSON.");
          }
          const result = DatasetSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await datasets.register(ws, result.data, principal.subject); // creator = subject (delete permission)
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );

    server.registerTool(
      "import_terminal_bench",
      {
        description:
          "Register a Terminal-Bench task set as a Dataset owned by the active workspace (standard task-format on-ramp). Each task → an EvalCase (prebuilt image env + instruction prompt + tests-pass grader). A task needs a prebuilt image (task.image, or an image_template with {id}) — Everdict references images, it does not build them. Versions are immutable (re-registering the same id@version with different content is CONFLICT). Once registered it runs like any dataset (run_scorecard, trials/pass@k, diff, leaderboard).",
        inputSchema: {
          dataset_id: z.string(),
          dataset_version: z.string(),
          tasks: z
            .string()
            .describe(
              "JSON array of Terminal-Bench tasks: {id, instruction, image?, testCommand?, workdir?, difficulty?, tags?, timeoutSec?}",
            ),
          image_template: z
            .string()
            .optional()
            .describe("resolve a task's image via {id} when the task carries none, e.g. ghcr.io/acme/tb/{id}:v1"),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      ({ dataset_id, dataset_version, tasks, image_template, description, tags }) =>
        run(principal, "datasets:write", async () => {
          let parsedTasks: unknown;
          try {
            parsedTasks = JSON.parse(tasks);
          } catch {
            return fail("BAD_REQUEST: tasks must be a JSON array.");
          }
          const result = z.array(TerminalBenchTaskSchema).min(1).safeParse(parsedTasks);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          // terminalBenchToDataset throws BadRequestError for an unresolved image — run() maps it to a tool error.
          const dataset = terminalBenchToDataset(
            result.data,
            {
              id: dataset_id,
              version: dataset_version,
              ...(description ? { description } : {}),
              ...(tags ? { tags } : {}),
            },
            image_template ? { imageTemplate: image_template } : {},
          );
          await datasets.register(ws, dataset, principal.subject);
          return ok({ workspace: ws, id: dataset.id, version: dataset.version, cases: dataset.cases.length });
        }),
    );

    server.registerTool(
      "import_harbor",
      {
        description:
          "Register an Anthropic Harbor task set as a Dataset owned by the active workspace (standard task-format on-ramp, same as import_terminal_bench). Each task → an EvalCase (prebuilt image env + instruction prompt + tests-pass over the verifier command). A task needs a prebuilt image (task.image, or an image_template with {id}) — Everdict references images, it does not build them. Versions are immutable.",
        inputSchema: {
          dataset_id: z.string(),
          dataset_version: z.string(),
          tasks: z
            .string()
            .describe(
              "JSON array of Harbor tasks: {id, instruction, image?, verifierCommand?, workdir?, difficulty?, tags?, timeoutSec?}",
            ),
          image_template: z
            .string()
            .optional()
            .describe("resolve a task's image via {id} when the task carries none, e.g. ghcr.io/acme/harbor/{id}:v1"),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      ({ dataset_id, dataset_version, tasks, image_template, description, tags }) =>
        run(principal, "datasets:write", async () => {
          let parsedTasks: unknown;
          try {
            parsedTasks = JSON.parse(tasks);
          } catch {
            return fail("BAD_REQUEST: tasks must be a JSON array.");
          }
          const result = z.array(HarborTaskSchema).min(1).safeParse(parsedTasks);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          const dataset = harborToDataset(
            result.data,
            {
              id: dataset_id,
              version: dataset_version,
              ...(description ? { description } : {}),
              ...(tags ? { tags } : {}),
            },
            image_template ? { imageTemplate: image_template } : {},
          );
          await datasets.register(ws, dataset, principal.subject);
          return ok({ workspace: ws, id: dataset.id, version: dataset.version, cases: dataset.cases.length });
        }),
    );

    server.registerTool(
      "delete_dataset",
      {
        description:
          "Soft-delete one dataset (version) (tombstone — disappears from list/get but the data is preserved, keeping past scorecards reproducible). version is required — deletes exactly one version (do not lump it under 'latest'). Confirm in order: which workspace (fixed by credential) → which id → which version. Permission: only that version's 'creator' or a 'workspace admin' (else FORBIDDEN). Missing / already-deleted / _shared / other-workspace versions are NOT_FOUND.",
        inputSchema: {
          id: z.string().describe("dataset id"),
          version: z
            .string()
            .describe("exact version to delete (required; latest not allowed — deletes exactly one version)"),
        },
      },
      ({ id, version }) => plain(async () => ok(await deleteDatasetVersion(datasets, principal, id, version))),
    );

    server.registerTool(
      "set_dataset_version_tags",
      {
        description:
          "Replace a dataset version's full tag set (empty array = remove all) — free labels for telling versions apart. Off-spec mutable metadata separate from content (Dataset.tags, entity classification), so independent of version immutability. Gate: datasets:write. _shared / other-workspace versions are NOT_FOUND.",
        inputSchema: {
          id: z.string().describe("dataset id"),
          version: z.string().describe("exact version (latest not allowed)"),
          tags: z
            .array(z.string())
            .describe("this version's full tag set (each ≤60 chars, ≤20 per version; replace semantics)"),
        },
      },
      ({ id, version, tags }) =>
        plain(async () => ok(await setVersionTags(datasets, principal, "datasets:write", id, version, tags))),
    );
  }
}
