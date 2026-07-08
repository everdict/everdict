import { API_KEY_SCOPES, type Action, EVERDICT_ROLES, type Principal, authorize } from "@everdict/auth";
import {
  AppError,
  CaseResultSchema,
  DatasetSchema,
  EvalCaseSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  JudgeSpecSchema,
  ModelSpecSchema,
  type RuntimeSpec,
  RuntimeSpecSchema,
} from "@everdict/core";
import { TerminalBenchTaskSchema, diffDatasets, terminalBenchToDataset } from "@everdict/datasets";
import { type SecretStore, type TenantKeyStore, type WorkspaceSettingsStore, issueKey } from "@everdict/db";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BenchmarkImportBodySchema, BenchmarkPreviewBodySchema, type BenchmarkService } from "./benchmark-service.js";
import { BundleSchema, type BundleService, requiredActionsForBundle } from "./bundle-service.js";
import type { CiLinkService } from "./ci-link-service.js";
import { COMMENT_RESOURCE_TYPES, type CommentService } from "./comment-service.js";
import { deleteDatasetVersion } from "./dataset-service.js";
import type { GithubAppService } from "./github-app-service.js";
import { installGithubWorkspaceRunner } from "./github-runner-install.js";
import { repinHarnessImages } from "./harness-pin-service.js";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./harness-service.js";
import type { ImageRegistryService } from "./image-registry-service.js";
import type { MattermostService } from "./mattermost-service.js";
import type { MembershipService } from "./membership-service.js";
import type { NotificationService } from "./notification-service.js";
import type { ProfileService } from "./profile-service.js";
import type { QueueService } from "./queue-service.js";
import type { RunService } from "./run-service.js";
import type { RunnerHub, SelfHostedKey } from "./runner-hub.js";
import { RUNNER_CAPABILITIES, type RunnerService } from "./runner-service.js";
import type { RuntimeProbeResult } from "./runtime-probe.js";
import type { ScheduleService, UpdateScheduleInput } from "./schedule-service.js";
import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type ScorecardService,
  originSource,
} from "./scorecard-service.js";
import type { TraceSinkService } from "./trace-sink-service.js";
import { setVersionTags } from "./version-tag-service.js";
import type { UpdateViewInput, ViewService } from "./view-service.js";
import type { WorkspaceService } from "./workspace-service.js";

// MCP tool surface — the "agent transport" sharing the same service core as the HTTP routes.
// Each tool is authorized by the Principal's roles and scoped to workspace (the control plane is the auth/authz authority).
export interface McpDeps {
  service: RunService;
  scorecardService?: ScorecardService;
  scheduleService?: ScheduleService;
  queueService?: QueueService; // work queue snapshot (running/waiting/next-scheduled per runtime lane)
  viewService?: ViewService; // saved scorecard-analysis Views — create/list/get/update/delete
  harnessTemplates?: HarnessTemplateRegistry;
  harnessInstances?: HarnessInstanceRegistry;
  datasetRegistry?: DatasetRegistry;
  judgeRegistry?: JudgeRegistry;
  modelRegistry?: ModelRegistry; // Model (inference/judgment model) register/read — judge and command harnesses reference it by id
  runtimeRegistry?: RuntimeRegistry;
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>; // runtime connection test
  secretStore?: SecretStore;
  githubAppService?: GithubAppService; // workspace-owned GitHub App integration (org install → selected repos)
  mattermostService?: MattermostService; // workspace-owned Mattermost integration (register → bot notifications)
  traceSinkService?: TraceSinkService; // workspace trace sinks (export to an observability platform)
  imageRegistryService?: ImageRegistryService; // workspace image registry (classification baseline + push publishing)
  ciLinkService?: CiLinkService; // CI repo link (repo↔harness slot + OIDC trust) + picker/setup-PR
  runnerService?: RunnerService; // self-hosted runners (personal device pairing) — pair/list/revoke + workspace roster
  notificationService?: NotificationService; // personal notification feed (bell inbox) — list/read (self-scoped)
  commentService?: CommentService; // resource comments (datasets, etc.) — list/create/delete
  runnerHub?: RunnerHub; // runner lease hub — lease_job/submit_job_result/fail_job/heartbeat_job (runner token only)
  settingsStore?: WorkspaceSettingsStore;
  benchmarkService?: BenchmarkService; // benchmark preview + import (source → dataset)
  bundleService?: BundleService; // bundle one-shot apply (harness + benchmark + runtime, etc.)
  workspaceService?: WorkspaceService; // workspace self-serve list/create (no role gate — by subject)
  membershipService?: MembershipService; // member management (list/role/remove/leave) + invites (issue/accept)
  profileService?: ProfileService; // my profile (name/username/avatar) read/edit (self-serve)
  keyStore?: TenantKeyStore; // API key self-serve issue/list/revoke (admin)
  apiPublicUrl?: string; // control-plane public base — the everdict runner --api-url in github_install_workspace_runner (falls back to the request base)
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// authorize + AppError → isError conversion (so the agent recognizes it as a tool error / permission error).
async function run(principal: Principal, action: Action, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    authorize(principal, action);
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return fail(`${err.code}: ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// Tools with no role gate (workspace self-serve list/create). AppError → isError conversion only.
async function plain(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return fail(`${err.code}: ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// MCP server bound to this Principal (stateless per-request instance). tools = runs/harnesses CRUD.
export function buildMcpServer(deps: McpDeps, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "everdict", version: "0.1.0" },
    { instructions: "Everdict eval control plane. Workspace-scoped run/harness tools." },
  );
  const ws = principal.workspace;

  server.registerTool(
    "list_runs",
    {
      description:
        "This workspace's run list (standalone activity). With scorecard_id, the case child-runs of that scorecard.",
      inputSchema: { scorecard_id: z.string().optional() },
    },
    ({ scorecard_id }) =>
      run(principal, "runs:read", async () =>
        ok(await deps.service.list(ws, scorecard_id ? { scorecardId: scorecard_id } : undefined)),
      ),
  );

  server.registerTool(
    "get_run",
    { description: "Fetch one run (another workspace's is NOT_FOUND)", inputSchema: { id: z.string() } },
    ({ id }) =>
      run(principal, "runs:read", async () => {
        const record = await deps.service.get(id);
        if (!record || record.tenant !== ws) return fail("NOT_FOUND: run not found.");
        return ok(record);
      }),
  );

  if (deps.queueService) {
    const queue = deps.queueService;
    server.registerTool(
      "get_queue",
      {
        description:
          "Work queue snapshot — per runtime lane: running/waiting (FIFO, the front is the next job)/next scheduled fire. A batch (scorecard) = 1 job (with progress).",
        inputSchema: {},
      },
      () => run(principal, "runs:read", async () => ok(await queue.snapshot(ws, principal.subject))),
    );
  }

  server.registerTool(
    "submit_run",
    {
      description:
        "Submit an eval run (empty repo seed + default graders). harness is id@version (default latest). With runtime, run on that runtime.",
      inputSchema: {
        harness_id: z.string(),
        version: z.string().optional(),
        task: z.string(),
        runtime: z.string().optional(), // tenant Runtime id to run on (placement.target). If absent, the default backend.
        timeout_sec: z.number().int().positive().optional(),
      },
    },
    ({ harness_id, version, task, runtime, timeout_sec }) =>
      run(principal, "runs:submit", async () => {
        const evalCase = EvalCaseSchema.parse({
          id: `mcp-${Date.now().toString(36)}`,
          env: { kind: "repo", source: { files: {} } },
          task,
          graders: [{ id: "steps" }, { id: "cost" }, { id: "latency" }],
          timeoutSec: timeout_sec ?? 300,
          tags: ["mcp"],
        });
        const rec = await deps.service.submit({
          tenant: ws,
          submittedBy: principal.subject, // clone the private-repo seed via my personal connection
          harness: { id: harness_id, version: version ?? "latest" },
          case: evalCase,
          trigger: "mcp", // activity-view source axis — submitted by the agent over MCP
          ...(runtime ? { runtime } : {}),
        });
        return ok(rec);
      }),
  );

  // Harness category (template: structure/slots). No gate (viewer+) — collaborative content.
  if (deps.harnessTemplates) {
    const templates = deps.harnessTemplates;
    server.registerTool(
      "list_harness_templates",
      { description: "Harness templates this workspace sees (categories; owned + _shared)", inputSchema: {} },
      () => run(principal, "harnesses:read", async () => ok(await templates.list(ws))),
    );

    server.registerTool(
      "get_harness_template",
      {
        description:
          "Fetch one harness template (category) structure spec — for config view / new-version edit prefill",
        inputSchema: { id: z.string(), version: z.string().describe('template version or "latest"') },
      },
      ({ id, version }) => run(principal, "harnesses:read", async () => ok(await templates.get(ws, id, version))),
    );

    server.registerTool(
      "register_harness_template",
      {
        description:
          "Register a harness template (category structure, JSON string) (immutable; CONFLICT on clash). No gate (viewer+)",
        inputSchema: { spec: z.string().describe("HarnessTemplateSpec JSON") },
      },
      ({ spec }) =>
        run(principal, "templates:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: not a valid HarnessTemplateSpec JSON.");
          }
          const result = HarnessTemplateSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await templates.register(ws, result.data, principal.subject); // creator stamp — HTTP parity
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  // Individual harness (instance: template reference + pins). No gate (viewer+).
  if (deps.harnessInstances) {
    const instances = deps.harnessInstances;
    server.registerTool(
      "list_harnesses",
      { description: "Harness instances this workspace sees (grouped by template; owned + _shared)", inputSchema: {} },
      () =>
        run(principal, "harnesses:read", async () => {
          // A private harness (references a personal secret) is createdBy-only — hidden from other users (same as the HTTP list).
          const entries = await instances.list(ws);
          return ok(entries.filter((e) => !e.private || (e.latestCreatedBy ?? e.createdBy) === principal.subject));
        }),
    );

    server.registerTool(
      "get_harness_instance",
      {
        description:
          "Fetch one harness instance raw spec (template reference + pins) — for config view / new-version re-pin prefill",
        inputSchema: { id: z.string(), version: z.string().describe('instance version tag or "latest"') },
      },
      ({ id, version }) =>
        run(principal, "harnesses:read", async () => ok(await instances.getInstance(ws, id, version))),
    );

    server.registerTool(
      "delete_harness",
      {
        description:
          "Soft-delete a harness version (tombstone — past scorecard history is preserved, future runs fail to resolve). Only that version's creator or a workspace admin.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("instance version to delete (exact version — latest not allowed)"),
        },
      },
      ({ id, version }) => plain(async () => ok(await deleteHarnessVersion(instances, principal, id, version))),
    );

    server.registerTool(
      "set_harness_version_tags",
      {
        description:
          "Replace a harness version's full tag set (empty array = remove all) — free labels for when a version number alone is hard to tell apart (e.g. baseline, gpt-5 experiment). Off-spec mutable metadata, so independent of version immutability and editable after registration. Same gate as registration (harnesses:register). _shared / other-workspace versions are NOT_FOUND.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("exact instance version (latest not allowed)"),
          tags: z
            .array(z.string())
            .describe("this version's full tag set (each ≤60 chars, ≤20 per version; replace semantics)"),
        },
      },
      ({ id, version, tags }) =>
        plain(async () => {
          // A private harness (references a personal secret) is createdBy-only — its existence is hidden from others (same as the HTTP route).
          if (!(await harnessVisibleTo(instances, principal, id))) return fail("NOT_FOUND: harness not found.");
          return ok(await setVersionTags(instances, principal, "harnesses:register", id, version, tags));
        }),
    );

    server.registerTool(
      "register_harness",
      {
        description:
          "Register a harness instance (template reference + pins, JSON string) (immutable; error if the template is missing / pins are absent). No gate (viewer+). Optional description = this version's changelog (shown on the detail page)",
        inputSchema: {
          spec: z
            .string()
            .describe(
              "HarnessInstanceSpec JSON: { template:{id,version}, id, version, pins, description? } (description = this version's changelog, optional)",
            ),
        },
      },
      ({ spec }) =>
        run(principal, "harnesses:register", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: not a valid HarnessInstanceSpec JSON.");
          }
          const result = HarnessInstanceSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          // creator stamp = HTTP parity — without it a user-secret (private) instance becomes invisible even to its registrant
          await instances.register(ws, result.data, principal.subject); // resolve validation (missing template / absent pins → error)
          // Visibility tradeoff surfaced at write time (HTTP parity): user-scope secretRef → visible to you only.
          const isPrivate = await harnessIsPrivate(instances, ws, result.data.id, result.data.version);
          return ok({
            workspace: ws,
            id: result.data.id,
            version: result.data.version,
            ...(isPrivate ? { private: true } : {}),
          });
        }),
    );

    server.registerTool(
      "pin_harness_images",
      {
        description:
          "Durable re-pin of a harness instance (headless re-pin) — merge into the base version's pins and register a new version. The path where CI (dev/main merge) swaps only its own service slots. Enforces digest pins (default), idempotent (identical pins → unchanged)",
        inputSchema: {
          id: z.string(),
          pins: z.record(z.string()).describe("slot → image ref (@sha256:… digest recommended)"),
          version: z.string().optional().describe('explicit version (e.g. "dev-<sha>"). Auto-bump if unspecified'),
          base: z.string().optional().describe("base instance version (default latest)"),
          allow_tags: z
            .boolean()
            .optional()
            .describe("lift the digest requirement (default false — tag pins break reproducibility)"),
        },
      },
      ({ id, pins, version, base, allow_tags }) =>
        run(principal, "harnesses:register", async () =>
          ok(
            await repinHarnessImages(instances, ws, principal.subject, id, {
              pins,
              ...(version !== undefined ? { version } : {}),
              ...(base !== undefined ? { base } : {}),
              allowTags: allow_tags ?? false,
            }),
          ),
        ),
    );
  }

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

  if (deps.judgeRegistry) {
    const judges = deps.judgeRegistry;
    server.registerTool(
      "list_judges",
      { description: "Agent Judges visible to this workspace (owned + _shared default judges)", inputSchema: {} },
      () => run(principal, "judges:read", async () => ok(await judges.list(ws))),
    );

    server.registerTool(
      "get_judge",
      {
        description: "A full JudgeSpec (model | harness). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) => run(principal, "judges:read", async () => ok(await judges.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "set_judge_version_tags",
      {
        description:
          "Replace all tags on a judge version (empty array = remove all) — free-form labels to tell versions apart (mutable metadata outside the spec, independent of immutability). Gate: judges:write. _shared / other-workspace versions get NOT_FOUND.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("exact version (latest not allowed)"),
          tags: z.array(z.string()).describe("all tags for this version (≤60 chars each, ≤20 per version; replaces)"),
        },
      },
      ({ id, version, tags }) =>
        plain(async () => ok(await setVersionTags(judges, principal, "judges:write", id, version, tags))),
    );

    server.registerTool(
      "validate_judge",
      {
        description:
          "Dry-run validate a JudgeSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { judge: z.string().describe("JudgeSpec JSON (kind: model | harness)") },
      },
      ({ judge }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(judge);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = JudgeSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await judges.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            kind: result.data.kind,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_judge",
      {
        description:
          "Register a JudgeSpec (JSON string) as owned by this workspace (model/harness; immutable; CONFLICT on collision)",
        inputSchema: { judge: z.string().describe("JudgeSpec JSON") },
      },
      ({ judge }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(judge);
          } catch {
            return fail("BAD_REQUEST: not a valid JudgeSpec JSON.");
          }
          const result = JudgeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await judges.register(ws, result.data, principal.subject); // creator stamp — HTTP parity
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.modelRegistry) {
    const models = deps.modelRegistry;
    server.registerTool(
      "list_models",
      { description: "Models visible to this workspace (inference/judge models: owned + _shared)", inputSchema: {} },
      () => run(principal, "models:read", async () => ok(await models.list(ws))),
    );

    server.registerTool(
      "get_model",
      {
        description:
          "A full ModelSpec (provider + underlying model + baseUrl). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) => run(principal, "models:read", async () => ok(await models.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_model",
      {
        description:
          "Dry-run validate a ModelSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { model: z.string().describe("ModelSpec JSON") },
      },
      ({ model }) =>
        run(principal, "models:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(model);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = ModelSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await models.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            provider: result.data.provider,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_model",
      {
        description:
          "Register a ModelSpec (JSON string) as owned by this workspace (provider + underlying model + baseUrl; immutable; CONFLICT on collision)",
        inputSchema: { model: z.string().describe("ModelSpec JSON") },
      },
      ({ model }) =>
        run(principal, "models:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(model);
          } catch {
            return fail("BAD_REQUEST: not a valid ModelSpec JSON.");
          }
          const result = ModelSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await models.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.runtimeRegistry) {
    const runtimes = deps.runtimeRegistry;
    server.registerTool(
      "list_runtimes",
      { description: "Execution infra visible to this workspace (Runtime: owned + _shared)", inputSchema: {} },
      () => run(principal, "runtimes:read", async () => ok(await runtimes.list(ws))),
    );

    server.registerTool(
      "get_runtime",
      {
        description:
          "A full RuntimeSpec (local | nomad | k8s). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) =>
        run(principal, "runtimes:read", async () => ok(await runtimes.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "set_runtime_version_tags",
      {
        description:
          "Replace all tags on a runtime version (empty array = remove all) — free-form labels to tell versions apart (mutable metadata outside the spec, independent of immutability). Gate: runtimes:write. _shared / other-workspace versions get NOT_FOUND.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("exact version (latest not allowed)"),
          tags: z.array(z.string()).describe("all tags for this version (≤60 chars each, ≤20 per version; replaces)"),
        },
      },
      ({ id, version, tags }) =>
        plain(async () => ok(await setVersionTags(runtimes, principal, "runtimes:write", id, version, tags))),
    );

    server.registerTool(
      "validate_runtime",
      {
        description:
          "Dry-run validate a RuntimeSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON (kind: local | nomad | k8s)") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await runtimes.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            kind: result.data.kind,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_runtime",
      {
        description:
          "Register a RuntimeSpec (JSON string) as owned by this workspace (immutable; CONFLICT on collision). Credentials live in the SecretStore",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return fail("BAD_REQUEST: not a valid RuntimeSpec JSON.");
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await runtimes.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.probeRuntime) {
    const probeRuntime = deps.probeRuntime;
    server.registerTool(
      "probe_runtime",
      {
        description:
          "Connection test for a RuntimeSpec (JSON) — attaches to the real cluster with no job to check reachability/auth (excludes local). {kind,reachable,detail}",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON (kind: local | nomad | k8s)") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return fail("BAD_REQUEST: not a valid RuntimeSpec JSON.");
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await probeRuntime(ws, result.data));
        }),
    );
  }

  if (deps.scorecardService) {
    const scorecards = deps.scorecardService;
    server.registerTool(
      "run_scorecard",
      {
        description:
          "Run a dataset against harness@version and aggregate a scorecard (async — returns a queued record, then poll with get_scorecard). If runtime is given, execute on that runtime.",
        inputSchema: {
          dataset_id: z.string(),
          dataset_version: z.string().optional(),
          harness_id: z.string(),
          harness_version: z.string().optional(),
          runtime: z
            .string()
            .optional()
            .describe(
              'tenant Runtime id (placement.target) or self runner target; a comma-separated list SHARDS the batch round-robin across runtimes; "auto" expands to every registered runtime. If absent, 400 per the deployment policy',
            ),
          harness_pins: z
            .record(z.string())
            .optional()
            .describe(
              "submit-time ephemeral pins (slot→image, registry unchanged) — for CI PR image swaps. Recorded in origin",
            ),
          judges: z
            .array(z.object({ id: z.string(), version: z.string().optional() }))
            .optional()
            .describe("Agent Judges to apply to the trace (version defaults to latest)"),
          judge: z
            .object({ provider: z.enum(["openai", "anthropic"]).optional(), model: z.string() })
            .optional()
            .describe(
              "inline judge-grader scoring model override for this batch (unset = workspace default) — HTTP parity",
            ),
          concurrency: z
            .number()
            .int()
            .min(1)
            .max(512)
            .optional()
            .describe(
              "number of cases this batch keeps in flight (parallelism; actual placement is capacity-governed by the scheduler). Defaults to the service default (=4) if unset",
            ),
          retries: z
            .number()
            .int()
            .min(0)
            .max(5)
            .optional()
            .describe(
              "transient dispatch retries per case (throw-only; a failing eval result is never retried). Default 1",
            ),
          trials: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe(
              "run each case N times for pass@k / flakiness (fans out N dispatches per case). Default 1; the scorecard detail carries a derived trialSummary — HTTP parity",
            ),
          cases: z
            .object({
              ids: z.array(z.string().min(1)).min(1).optional(),
              tags: z.array(z.string().min(1)).min(1).optional(),
              limit: z.number().int().min(1).max(10_000).optional(),
            })
            .optional()
            .describe(
              "partial run — only a subset of the full dataset (explicit ids → tags any-match → limit first N, applied in that order)",
            ),
          trace_sink: z
            .string()
            .min(1)
            .optional()
            .describe(
              'per-batch trace-sink override: a configured workspace sink name, or "none" to suppress export for this batch. Unset = the harness own selection — HTTP parity',
            ),
          origin: z
            .object({
              repo: z.string().optional(),
              sha: z.string().optional(),
              ref: z.string().optional(),
              prNumber: z.number().int().optional(),
              runUrl: z.string().optional(),
            })
            .optional()
            .describe("origin coordinates (commit/PR/CI run) — source is decided by the server"),
        },
      },
      ({
        dataset_id,
        dataset_version,
        harness_id,
        harness_version,
        harness_pins,
        runtime,
        judges,
        judge,
        concurrency,
        retries,
        trials,
        cases,
        trace_sink,
        origin,
      }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.submit({
              tenant: ws,
              submittedBy: principal.subject, // clone private-repo cases via my personal connection
              dataset: { id: dataset_id, version: dataset_version ?? "latest" },
              harness: {
                id: harness_id,
                version: harness_version ?? "latest",
                ...(harness_pins ? { pins: harness_pins } : {}),
              },
              origin: { source: originSource(principal.via), ...(origin ?? {}) },
              judges: (judges ?? []).map((j) => ({ id: j.id, version: j.version ?? "latest" })),
              ...(judge ? { judge } : {}),
              ...(runtime ? { runtime } : {}),
              ...(concurrency !== undefined ? { concurrency } : {}),
              ...(retries !== undefined ? { retries } : {}),
              ...(trials !== undefined ? { trials } : {}),
              ...(cases ? { cases } : {}),
              ...(trace_sink ? { traceSink: trace_sink } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "retry_scorecard",
      {
        description:
          "Retry a finished batch's FAILED cases as a new scorecard — passing results are carried over verbatim (full comparable case set), origin.retryOf keeps the lineage. The source record is never mutated.",
        inputSchema: {
          id: z.string().describe("source scorecard id (must be succeeded/failed)"),
          failure_class: z
            .enum(["infra", "config", "harness", "agent"])
            .optional()
            .describe(
              "re-run only this failure class (e.g. infra after a cluster incident) — agent FAILs stay carried",
            ),
        },
      },
      ({ id, failure_class }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.retryFailed({
              tenant: ws,
              id,
              submittedBy: principal.subject,
              ...(failure_class ? { failureClass: failure_class } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "list_scorecards",
      { description: "This workspace's scorecards (summary only — excludes heavy per-case results)", inputSchema: {} },
      () => run(principal, "scorecards:read", async () => ok(await scorecards.list(ws))),
    );

    server.registerTool(
      "get_scorecard",
      {
        description: "A full scorecard (including per-case results). Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "scorecards:read", async () => {
          const record = await scorecards.get(id);
          if (!record || record.tenant !== ws) return fail("NOT_FOUND: scorecard not found.");
          return ok(record);
        }),
    );

    server.registerTool(
      "diff_scorecards",
      {
        description:
          "Compare two scorecards (baseline vs candidate) → metric delta + per-case regression/improvement. Both must be completed in this workspace. When either ran trials, the result also carries a statistically-gated 'trials' diff (pass@k regression)",
        inputSchema: {
          baseline: z.string(),
          candidate: z.string(),
          z: z
            .number()
            .positive()
            .optional()
            .describe("confidence threshold for the trial regression gate (default 1.96 ≈ 95%; only used with trials)"),
        },
      },
      ({ baseline, candidate, z: zThreshold }) =>
        run(principal, "scorecards:read", async () =>
          ok(await scorecards.diff(ws, baseline, candidate, zThreshold !== undefined ? { zThreshold } : {})),
        ),
    );

    server.registerTool(
      "leaderboard_scorecards",
      {
        description:
          "(harness × model) ranking for one dataset (benchmark) — descending by metric. window=latest(default)|best. Optional harness/model/judge_model filters (judge_model = fair comparison among the same grader).",
        inputSchema: {
          dataset: z.string(),
          metric: z.string().optional(),
          harness: z.string().optional(),
          model: z.string().optional(),
          judge_model: z.string().optional(),
          window: z.enum(["latest", "best"]).optional(),
        },
      },
      ({ dataset, metric, harness, model, judge_model, window }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            await scorecards.leaderboard(ws, {
              datasetId: dataset,
              metric: metric ?? "judge",
              ...(harness ? { harnessId: harness } : {}),
              ...(model ? { model } : {}),
              ...(judge_model ? { judgeModel: judge_model } : {}),
              window: window ?? "latest",
            }),
          ),
        ),
    );

    server.registerTool(
      "backfill_scorecard_models",
      {
        description:
          "Backfill the observed model from stored traces into past succeeded scorecards that lack models (idempotent). Use to include past runs on the leaderboard.",
        inputSchema: {},
      },
      () => run(principal, "scorecards:run", async () => ok(await scorecards.backfillModels(ws))),
    );

    server.registerTool(
      "ingest_scorecard",
      {
        description:
          "Upload externally produced traces (TraceEvent[]) into a scorecard (harness not run). body=IngestScorecard JSON {dataset,harness,traces:[{caseId,trace}],judges?}",
        inputSchema: { body: z.string().describe("IngestScorecard JSON") },
      },
      ({ body }) =>
        run(principal, "scorecards:run", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: not a valid IngestScorecard JSON.");
          }
          const result = IngestScorecardBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await scorecards.ingest({ tenant: ws, submittedBy: principal.subject, ...result.data }));
        }),
    );

    server.registerTool(
      "pull_scorecard",
      {
        description:
          "Pull per-runId traces from the tenant's observability platform (otel|mlflow|langfuse|langsmith|phoenix) into a scorecard (harness not run). body=PullIngest JSON {dataset,harness,source:{kind,endpoint,authSecret?,project?[required for phoenix]},runs:[{caseId,runId}],judges?}",
        inputSchema: { body: z.string().describe("PullIngest JSON") },
      },
      ({ body }) =>
        run(principal, "scorecards:run", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: not a valid PullIngest JSON.");
          }
          const result = PullIngestBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await scorecards.ingestPull({ tenant: ws, submittedBy: principal.subject, ...result.data }));
        }),
    );
  }

  if (deps.bundleService) {
    const bundles = deps.bundleService;
    server.registerTool(
      "apply_bundle",
      {
        description:
          "Apply a bundle (JSON) — register harness + benchmark + dataset + runtime + judge/model in one shot (idempotent, partial success). Requires per-type permissions depending on the bundle contents.",
        inputSchema: { bundle: z.string().describe("Bundle JSON") },
      },
      ({ bundle }) =>
        plain(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bundle);
          } catch {
            return fail("BAD_REQUEST: not a valid Bundle JSON.");
          }
          const result = BundleSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          // per-section authorization (throw→plain catch→fail) — combines existing per-type gates with no new action.
          for (const action of requiredActionsForBundle(result.data)) authorize(principal, action);
          return ok(await bundles.apply(ws, principal.subject, result.data));
        }),
    );
  }

  if (deps.scheduleService) {
    const schedules = deps.scheduleService;
    server.registerTool(
      "create_schedule",
      {
        description:
          "Create a scheduled (cron) scorecard — periodically run dataset×harness on a cron (regression tracking). Fired runs execute under my identity (budget→workspace). cron is 5 fields (min hour day month weekday).",
        inputSchema: {
          name: z.string(),
          cron: z.string().describe("5-field cron (e.g. '0 3 * * *' = daily at 03:00)"),
          timezone: z.string().optional().describe("IANA tz (default UTC)"),
          overlap_policy: z
            .enum(["skip", "bufferOne", "allowAll"])
            .optional()
            .describe("overlap policy (default skip)"),
          enabled: z.boolean().optional(),
          dataset_id: z.string(),
          dataset_version: z.string().optional(),
          harness_id: z.string(),
          harness_version: z.string().optional(),
          judges: z.array(z.object({ id: z.string(), version: z.string().optional() })).optional(),
          runtime: z.string().optional(),
          concurrency: z.number().int().min(1).max(64).optional(),
        },
      },
      (a) =>
        run(principal, "schedules:write", async () =>
          ok(
            await schedules.create({
              tenant: ws,
              createdBy: principal.subject,
              name: a.name,
              cron: a.cron,
              ...(a.timezone !== undefined ? { timezone: a.timezone } : {}),
              ...(a.overlap_policy !== undefined ? { overlapPolicy: a.overlap_policy } : {}),
              ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
              runTemplate: {
                dataset: { id: a.dataset_id, version: a.dataset_version ?? "latest" },
                harness: { id: a.harness_id, version: a.harness_version ?? "latest" },
                judges: (a.judges ?? []).map((j) => ({ id: j.id, version: j.version ?? "latest" })),
                ...(a.runtime !== undefined ? { runtime: a.runtime } : {}),
                ...(a.concurrency !== undefined ? { concurrency: a.concurrency } : {}),
              },
            }),
          ),
        ),
    );

    server.registerTool(
      "list_schedules",
      { description: "This workspace's scheduled scorecards", inputSchema: {} },
      () => run(principal, "schedules:read", async () => ok(await schedules.list(ws))),
    );

    server.registerTool(
      "get_schedule",
      { description: "Read one schedule (other workspaces get NOT_FOUND)", inputSchema: { id: z.string() } },
      ({ id }) => run(principal, "schedules:read", async () => ok(await schedules.get(ws, id))),
    );

    server.registerTool(
      "update_schedule",
      {
        description:
          "Update a schedule — pause/resume (enabled), reschedule (cron/timezone), change name/overlap policy. Swap runTemplate (dataset·harness) via the BFF or by recreating.",
        inputSchema: {
          id: z.string(),
          name: z.string().optional(),
          cron: z.string().optional(),
          timezone: z.string().optional(),
          overlap_policy: z.enum(["skip", "bufferOne", "allowAll"]).optional(),
          enabled: z.boolean().optional(),
        },
      },
      (a) =>
        run(principal, "schedules:write", async () => {
          const patch: UpdateScheduleInput = {};
          if (a.name !== undefined) patch.name = a.name;
          if (a.cron !== undefined) patch.cron = a.cron;
          if (a.timezone !== undefined) patch.timezone = a.timezone;
          if (a.overlap_policy !== undefined) patch.overlapPolicy = a.overlap_policy;
          if (a.enabled !== undefined) patch.enabled = a.enabled;
          return ok(
            await schedules.update(ws, a.id, patch, {
              subject: principal.subject,
              isAdmin: principal.roles.includes("admin"),
            }),
          );
        }),
    );

    server.registerTool(
      "delete_schedule",
      { description: "Delete a schedule (other workspaces get NOT_FOUND)", inputSchema: { id: z.string() } },
      ({ id }) =>
        run(principal, "schedules:write", async () => {
          await schedules.remove(ws, id);
          return ok({ id, deleted: true });
        }),
    );
  }

  if (deps.viewService) {
    const views = deps.viewService;
    // Saved scorecard-analysis Views — a named AnalysisConfig (opaque). Reuses scorecards:read/run (no new authz).
    server.registerTool(
      "create_view",
      {
        description:
          "Save a scorecard-analysis View — store a named analysis config in the workspace. visibility=private (just me) | workspace (shared). config is the web AnalysisConfig (opaque).",
        inputSchema: {
          name: z.string(),
          config: z.unknown().describe("web AnalysisConfig (recipe). Re-run live, not a snapshot."),
          visibility: z.enum(["private", "workspace"]).optional().describe("default private"),
        },
      },
      (a) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await views.create({
              tenant: ws,
              createdBy: principal.subject,
              name: a.name,
              config: a.config,
              ...(a.visibility !== undefined ? { visibility: a.visibility } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "list_views",
      { description: "Analysis Views I can see (workspace-shared + my private)", inputSchema: {} },
      () => run(principal, "scorecards:read", async () => ok(await views.list(ws, principal.subject))),
    );

    server.registerTool(
      "get_view",
      {
        description: "Read one analysis View (others' private / missing → NOT_FOUND)",
        inputSchema: { id: z.string() },
      },
      ({ id }) => run(principal, "scorecards:read", async () => ok(await views.get(ws, id, principal.subject))),
    );

    server.registerTool(
      "update_view",
      {
        description: "Update an analysis View — change name/config/visibility. Owner or workspace admin only.",
        inputSchema: {
          id: z.string(),
          name: z.string().optional(),
          config: z.unknown().optional(),
          visibility: z.enum(["private", "workspace"]).optional(),
        },
      },
      (a) =>
        run(principal, "scorecards:run", async () => {
          const patch: UpdateViewInput = {};
          if (a.name !== undefined) patch.name = a.name;
          if (a.config !== undefined) patch.config = a.config;
          if (a.visibility !== undefined) patch.visibility = a.visibility;
          return ok(
            await views.update(ws, a.id, patch, {
              subject: principal.subject,
              isAdmin: principal.roles.includes("admin"),
            }),
          );
        }),
    );

    server.registerTool(
      "delete_view",
      {
        description: "Delete an analysis View — owner or workspace admin only (other workspaces get NOT_FOUND)",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "scorecards:run", async () => {
          await views.remove(ws, id, {
            subject: principal.subject,
            isAdmin: principal.roles.includes("admin"),
          });
          return ok({ id, deleted: true });
        }),
    );
  }

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

  if (deps.secretStore) {
    const secrets = deps.secretStore;
    server.registerTool(
      "list_secrets",
      {
        description:
          "List secret names (no values) — shared (workspace) + my personal (user) secrets, each tagged with scope. Values are never returned.",
        inputSchema: {},
      },
      () => run(principal, "secrets:read", async () => ok(await secrets.list(ws, principal.subject))),
    );
    server.registerTool(
      "set_secret",
      {
        description:
          "Set/update a secret (encrypted at rest; the value can't be read back). name is env-style. scope: workspace (shared, default) | user (my personal).",
        inputSchema: {
          name: z.string().describe("env name ^[A-Z_][A-Z0-9_]*$"),
          value: z.string(),
          scope: z.enum(["user", "workspace"]).optional().describe("workspace (shared, default) | user (personal)"),
        },
      },
      ({ name, value, scope }) =>
        run(principal, "secrets:write", async () => {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return fail("BAD_REQUEST: secret name must match ^[A-Z_][A-Z0-9_]*$");
          const owner = scope === "user" ? principal.subject : "";
          await secrets.set(ws, name, value, owner);
          return ok({ workspace: ws, name, scope: scope ?? "workspace", set: true });
        }),
    );
    server.registerTool(
      "delete_secret",
      {
        description: "Delete a secret. scope: workspace (shared, default) | user (my personal).",
        inputSchema: { name: z.string(), scope: z.enum(["user", "workspace"]).optional() },
      },
      ({ name, scope }) =>
        run(principal, "secrets:write", async () => {
          const owner = scope === "user" ? principal.subject : "";
          await secrets.remove(ws, name, owner);
          return ok({ workspace: ws, name, scope: scope ?? "workspace", deleted: true });
        }),
    );
  }

  // Workspace-owned GitHub App integration (replaces personal connections) — org install→selected repos→workspace-owned installation. settings:read/write.
  if (deps.githubAppService) {
    const gh = deps.githubAppService;
    server.registerTool(
      "list_workspace_github_app",
      {
        description:
          "This workspace's GitHub App integration — GHE App registrations + workspace-owned installations (host/installationId/account + allowed repos) + the callbackUrl to register as the App Setup URL. No secret values.",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:read", async () => {
          const view = await gh.viewWithRepos(ws);
          const callbackUrl = gh.callbackUrl();
          return ok({ ...view, ...(callbackUrl !== undefined ? { callbackUrl } : {}) });
        }),
    );
    server.registerTool(
      "start_workspace_github_app_install",
      {
        description:
          "Start a GitHub App install (admin) → returns the GitHub installation-page URL (admin opens it and selects repos). host unset=github.com (env App), set=a registered GHE App.",
        inputSchema: { host: z.string().url().optional().describe("GHE base URL (unset=github.com)") },
      },
      ({ host }) =>
        run(principal, "settings:write", async () =>
          ok(await gh.startInstall({ workspace: ws, createdBy: principal.subject, ...(host ? { host } : {}) })),
        ),
    );
    server.registerTool(
      "register_workspace_github_app",
      {
        description:
          "Register/update a GHE App (admin). Upsert by host. Put the App private key (PEM) in the SecretStore first and pass its name as privateKeySecretName.",
        inputSchema: {
          host: z.string().url().describe("GHE base URL"),
          slug: z.string().min(1).describe("App slug (used in the install URL)"),
          appId: z.string().min(1).describe("GitHub App ID"),
          privateKeySecretName: z.string().min(1).describe("SecretStore key name holding the App private key (PEM)"),
        },
      },
      ({ host, slug, appId, privateKeySecretName }) =>
        run(principal, "settings:write", async () =>
          ok(await gh.registerGheApp(ws, { host, slug, appId, privateKeySecretName })),
        ),
    );
    server.registerTool(
      "remove_workspace_github_app_registration",
      {
        description:
          "Unregister a GHE App (admin). Existing installation records remain but no token can be minted without credentials.",
        inputSchema: { host: z.string().url().describe("GHE base URL") },
      },
      ({ host }) => run(principal, "settings:write", async () => ok(await gh.removeRegistration(ws, host))),
    );
    server.registerTool(
      "unlink_workspace_github_app_installation",
      {
        description:
          "Unlink an installation (admin). The actual uninstall happens on GitHub — here we just forget the record (idempotent).",
        inputSchema: { installationId: z.number().int().describe("GitHub installation id") },
      },
      ({ installationId }) =>
        run(principal, "settings:write", async () => ok(await gh.unlinkInstallation(ws, installationId))),
    );
  }

  // Workspace-owned Mattermost integration (replaces personal-connection notifications) — post completion/regression alerts to a channel with a bot token. settings:read/write.
  if (deps.mattermostService) {
    const mm = deps.mattermostService;
    server.registerTool(
      "get_workspace_mattermost",
      {
        description:
          "This workspace's Mattermost integration settings — host/botTokenSecretName/defaultChannelId (not secret values). If unset, no config.",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:read", async () => {
          const config = await mm.get(ws);
          return ok({ ...(config ? { config } : {}) });
        }),
    );
    server.registerTool(
      "set_workspace_mattermost",
      {
        description:
          "Register/update the Mattermost integration (admin). Put the bot token (value) in the SecretStore first and pass its name as botTokenSecretName. defaultChannelId = the completion/regression alert channel.",
        inputSchema: {
          host: z.string().url().describe("internal Mattermost base URL"),
          botTokenSecretName: z.string().min(1).describe("SecretStore key name holding the bot access token"),
          defaultChannelId: z
            .string()
            .min(1)
            .optional()
            .describe("default channel id for completion/regression alerts"),
          commandTokenSecretName: z
            .string()
            .min(1)
            .optional()
            .describe(
              "SecretStore name of the inbound (slash-command/button) verification token — set it to enable the /everdict command",
            ),
        },
      },
      ({ host, botTokenSecretName, defaultChannelId, commandTokenSecretName }) =>
        run(principal, "settings:write", async () =>
          ok({
            config: await mm.set(ws, {
              host,
              botTokenSecretName,
              ...(defaultChannelId ? { defaultChannelId } : {}),
              ...(commandTokenSecretName ? { commandTokenSecretName } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "remove_workspace_mattermost",
      {
        description:
          "Unregister the Mattermost integration (admin). Completion/regression alerts are no longer posted afterward.",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:write", async () => {
          await mm.clear(ws);
          return ok({ ok: true });
        }),
    );
  }

  // Workspace trace sinks (multiple) — export judged scorecard detail to the team's observability platform. Register multiple sinks by
  // name and select 'per harness'. Read harnesses:read / register·remove settings:write / select harnesses:register.
  // Design: docs/architecture/trace-sink.md
  if (deps.traceSinkService) {
    const sink = deps.traceSinkService;
    server.registerTool(
      "list_workspace_trace_sinks",
      {
        description:
          "This workspace's trace sinks + per-harness selection state — {sinks:[{name,kind,endpoint,…}], assignments:{harnessId→sinkName}} (not secret values).",
        inputSchema: {},
      },
      () => run(principal, "harnesses:read", async () => ok(await sink.list(ws))),
    );
    server.registerTool(
      "set_workspace_trace_sink",
      {
        description:
          "Register/update a trace sink (admin, upsert by name). When a harness selects this sink, per-case trace+scores are exported to this platform on scorecard completion. Put the auth token (value) in the SecretStore first and pass its name as authSecretName.",
        inputSchema: {
          name: z.string().min(1).describe("sink name (reference key — per-harness selection points at this name)"),
          kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]).describe("observability platform kind"),
          endpoint: z.string().url().describe("platform API base URL"),
          authSecretName: z
            .string()
            .min(1)
            .optional()
            .describe("SecretStore key name holding the auth-header 'value' (omit for an unauthenticated dev server)"),
          project: z
            .string()
            .min(1)
            .optional()
            .describe(
              "per-kind project coordinate — mlflow experiment_id · langsmith project · phoenix project · langfuse projectId",
            ),
          webUrl: z.string().url().optional().describe("UI deep-link base (when it differs from the API endpoint)"),
        },
      },
      (input) => run(principal, "settings:write", async () => ok({ config: await sink.upsert(ws, input) })),
    );
    server.registerTool(
      "remove_workspace_trace_sink",
      {
        description:
          "Remove a trace sink (admin, by name). Any per-harness selection pointing at it is cleaned up too.",
        inputSchema: { name: z.string().min(1).describe("name of the sink to remove") },
      },
      ({ name }) =>
        run(principal, "settings:write", async () => {
          await sink.remove(ws, name);
          return ok({ ok: true });
        }),
    );
    server.registerTool(
      "assign_harness_trace_sink",
      {
        description:
          "Per-harness trace sink selection (member+) — which sink to export to when that harness's scorecard completes. Omit sink to clear the selection (export off).",
        inputSchema: {
          harness: z.string().min(1).describe("harness id"),
          sink: z.string().min(1).optional().describe("sink name (omit = clear selection)"),
        },
      },
      ({ harness, sink: sinkName }) =>
        run(principal, "harnesses:register", async () =>
          ok({ assignments: await sink.assign(ws, harness, sinkName ?? null) }),
        ),
    );
  }

  // Workspace image registries (BYO, multiple) — the harness-image classification baseline + target for everdict image push issuance.
  // Register several by name and select one on push. Read harnesses:read / register·remove settings:write / push credentials images:push (member+).
  if (deps.imageRegistryService) {
    const registry = deps.imageRegistryService;
    server.registerTool(
      "list_workspace_image_registries",
      {
        description:
          "This workspace's image registries — [{name,host,namespace?,username?,secret-name reference,imagePrefix}] (not secret values). Classification/pull auth matches by host across all of them.",
        inputSchema: {},
      },
      () => run(principal, "harnesses:read", async () => ok({ registries: await registry.list(ws) })),
    );
    server.registerTool(
      "set_workspace_image_registry",
      {
        description:
          "Register/update an image registry (admin, upsert by name — declarative full replace). Put the pull/push token (value) in the SecretStore first and pass its name. Warns via missingSecrets if a referenced secret is absent.",
        inputSchema: {
          name: z.string().min(1).describe("registry name (reference key — push selection points at this name)"),
          host: z.string().min(1).describe('registry host[:port] — "ghcr.io" · "registry.acme.dev:5000"'),
          namespace: z.string().min(1).optional().describe('path prefix under host — "acme" → ghcr.io/acme/<name>'),
          username: z.string().min(1).optional().describe("docker login username (omit for token-only registries)"),
          pullSecretName: z.string().min(1).optional().describe("SecretStore key name holding the pull token/password"),
          pushSecretName: z.string().min(1).optional().describe("SecretStore key name holding the push token/password"),
        },
      },
      (input) => run(principal, "settings:write", async () => ok(await registry.upsert(ws, input))),
    );
    server.registerTool(
      "remove_workspace_image_registry",
      {
        description: "Remove an image registry (admin, by name). Afterward its images are classified as external.",
        inputSchema: { name: z.string().min(1).describe("name of the registry to remove") },
      },
      ({ name }) =>
        run(principal, "settings:write", async () => {
          await registry.remove(ws, name);
          return ok({ ok: true });
        }),
    );
    server.registerTool(
      "get_image_push_credentials",
      {
        description:
          "Mint push credentials for a workspace registry (member+) — {name,host,namespace?,username?,password,imagePrefix}. Choose via registry (omittable if there's only one). Discard after docker tag+login+push (non-persistent).",
        inputSchema: {
          registry: z.string().min(1).optional().describe("registry name (omittable if there's only one)"),
        },
      },
      ({ registry: name }) =>
        run(principal, "images:push", async () => ok({ credentials: await registry.pushCredentials(ws, name) })),
    );
  }

  // CI repo links — repository↔harness slot mapping (= GitHub Actions OIDC trust policy) + picker + setup-PR.
  if (deps.ciLinkService) {
    const ci = deps.ciLinkService;
    server.registerTool(
      "list_ci_links",
      { description: "This workspace's CI repo links (repo↔harness slot mapping = OIDC trust)", inputSchema: {} },
      () => run(principal, "harnesses:read", async () => ok({ links: await ci.list(ws) })),
    );
    server.registerTool(
      "link_ci_repository",
      {
        description:
          "Register/update a CI repo link (admin) — the link's existence trusts that repo's GitHub Actions OIDC token into this workspace (keyless CI).",
        inputSchema: {
          repository: z.string().describe('"owner/name"'),
          host: z.string().url().optional().describe('GHE base URL (e.g. "https://ghe.acme.io") — unset = github.com'),
          harness: z.string().describe("harness instance id"),
          dataset: z.string().optional().describe("dataset id the CI fires (used in the setup-PR workflow)"),
          slots: z
            .record(z.object({ path: z.string().optional() }))
            .optional()
            .describe("service slot → monorepo path (optional) — the slots this repo's CI swaps"),
          runsOn: z
            .string()
            .optional()
            .describe(
              'narrowing override — workflow runs-on (default "[self-hosted]", e.g. "[self-hosted, everdict-<id>]")',
            ),
          runtime: z
            .string()
            .optional()
            .describe(
              'narrowing override — run-eval runtime (default "self:ws" workspace runner pool, e.g. "self:ws:<id>"). Personal runners (self…) → 400',
            ),
          trigger: z
            .enum(["auto", "comment", "both"])
            .optional()
            .describe(
              "how PR evaluation is triggered (optional) — auto=only automatic on PR events, comment=only the /evaluate PR comment (on-demand), both(default)=both",
            ),
        },
      },
      ({ repository, host, harness, dataset, slots, runsOn, runtime, trigger }) =>
        run(principal, "settings:write", async () =>
          ok({
            links: await ci.upsert(ws, principal.subject, {
              repository,
              harness,
              slots: slots ?? {},
              ...(host !== undefined ? { host } : {}),
              ...(dataset !== undefined ? { dataset } : {}),
              ...(runsOn !== undefined ? { runsOn } : {}),
              ...(runtime !== undefined ? { runtime } : {}),
              ...(trigger !== undefined ? { trigger } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "unlink_ci_repository",
      {
        description: "Remove a CI repo link (admin) — that repo's OIDC trust is severed too.",
        inputSchema: {
          repository: z.string().describe('"owner/name"'),
          host: z.string().url().optional().describe("GHE base URL — unset = github.com link"),
        },
      },
      ({ repository, host }) =>
        run(principal, "settings:write", async () => ok({ links: await ci.remove(ws, repository, host) })),
    );
    server.registerTool(
      "list_github_app_repos",
      {
        description:
          "Repos accessible to the workspace's GitHub App installation (picker) — only those chosen at install time. settings:read.",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await ci.listRepos(ws))),
    );
    server.registerTool(
      "open_ci_setup_pr",
      {
        description:
          "Synthesize the Everdict eval workflow YAML in a linked repo and open a setup-PR (workspace GitHub App token). Merging it activates CI eval. The workflow always targets self-hosted runners — 400 if the self:ws pool has no shared runner (register one first via github_install_workspace_runner).",
        inputSchema: {
          repository: z.string().describe('"owner/name"'),
          host: z.string().url().optional().describe("GHE base URL — unset = github.com link"),
        },
      },
      ({ repository, host }) =>
        run(principal, "harnesses:read", async () =>
          ok(await ci.openSetupPr(ws, repository, host !== undefined ? { host } : {})),
        ),
    );
  }

  if (deps.notificationService) {
    const notifications = deps.notificationService;
    // The notification feed is personally owned (recipient=principal.subject) — no role gate (self-scoped, plain). BFF parity: GET/POST /notifications.
    server.registerTool(
      "list_notifications",
      {
        description: "My notification feed (job completions, etc.) — newest first. unread=true for unread only.",
        inputSchema: {
          unread: z.boolean().optional().describe("if true, unread only"),
          limit: z.number().int().positive().max(200).optional(),
        },
      },
      ({ unread, limit }) =>
        plain(async () =>
          ok({
            notifications: await notifications.listFeed(principal.subject, ws, {
              ...(unread === true ? { unreadOnly: true } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "read_notifications",
      {
        description: "Mark notifications read — give ids or all=true. Returns the count processed (idempotent).",
        inputSchema: {
          ids: z.array(z.string()).optional(),
          all: z.boolean().optional(),
        },
      },
      ({ ids, all }) =>
        plain(async () =>
          ok({ read: await notifications.markFeedRead(principal.subject, ws, all === true ? "all" : (ids ?? [])) }),
        ),
    );
  }

  if (deps.commentService) {
    const comments = deps.commentService;
    // Resource comments — read=comments:read, write=comments:write, delete=author-or-admin (decided by the service). BFF parity: GET/POST/DELETE /comments.
    server.registerTool(
      "list_comments",
      {
        description: "Comments on a resource (dataset, etc.) — oldest→newest (timeline order).",
        inputSchema: {
          resource_type: z.enum(COMMENT_RESOURCE_TYPES),
          resource_id: z.string(),
        },
      },
      ({ resource_type, resource_id }) =>
        run(principal, "comments:read", async () =>
          ok({ comments: await comments.list(ws, resource_type, resource_id) }),
        ),
    );
    server.registerTool(
      "create_comment",
      {
        description:
          "Post a comment on a resource. Author = me (subject). Reply via parent_id; @-mentioning member subjects via mentions notifies them.",
        inputSchema: {
          resource_type: z.enum(COMMENT_RESOURCE_TYPES),
          resource_id: z.string(),
          parent_id: z.string().optional().describe("parent comment id if this is a reply (single-level thread)"),
          body: z.string().min(1),
          mentions: z.array(z.string()).optional().describe("member subjects to @-mention (notification targets)"),
        },
      },
      ({ resource_type, resource_id, parent_id, body, mentions }) =>
        run(principal, "comments:write", async () =>
          ok(
            await comments.create({
              tenant: ws,
              resourceType: resource_type,
              resourceId: resource_id,
              author: principal.subject,
              body,
              ...(parent_id ? { parentId: parent_id } : {}),
              ...(mentions ? { mentions } : {}),
            }),
          ),
        ),
    );
    server.registerTool(
      "delete_comment",
      {
        description: "Delete a comment — author or workspace admin only.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        plain(async () => {
          await comments.delete({
            tenant: ws,
            id,
            subject: principal.subject,
            isAdmin: principal.roles.includes("admin"),
          });
          return ok({ id, deleted: true });
        }),
    );
  }

  if (deps.runnerService) {
    const runners = deps.runnerService;
    // Self-hosted runners are personally owned (owner=principal.subject) — no role gate, you handle only your own runners (self-scoped, plain, like connections).
    server.registerTool("list_runners", { description: "My self-hosted runners (no tokens)", inputSchema: {} }, () =>
      plain(async () => ok({ runners: await runners.list(principal.subject) })),
    );
    server.registerTool(
      "pair_runner",
      {
        description:
          "Pair a new device as a self-hosted runner. The plaintext token (rnr_…) is shown once in the response and can't be read again — everdict runner authenticates with it.",
        inputSchema: {
          label: z.string().min(1).max(80).describe("display device name (e.g. ho-macbook)"),
          os: z.string().min(1).max(40).optional().describe("linux | darwin | win32, etc."),
          capabilities: z
            .array(z.enum(RUNNER_CAPABILITIES))
            .optional()
            .describe("what this machine can run (git|docker|browser|computer-use|sandbox|codex-login|claude-login)"),
        },
      },
      ({ label, os, capabilities }) =>
        // Personally owned: owner=subject. ws records the paired workspace (roster/visibility).
        plain(async () => {
          const paired = await runners.pair({
            owner: principal.subject,
            workspace: ws,
            label,
            ...(os !== undefined ? { os } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          });
          return ok({ runner: paired.meta, token: paired.token });
        }),
    );
    server.registerTool(
      "revoke_runner",
      {
        description: "Unpair (delete) my self-hosted runner. id is the id from list_runners.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        plain(async () => {
          await runners.revoke(principal.subject, id);
          return ok({ id, revoked: true });
        }),
    );
    // Workspace runner roster — runners paired in this workspace (metadata only). Read-only (members:read). Management is personal (list_runners).
    server.registerTool(
      "list_workspace_runners",
      {
        description: "Roster of self-hosted runners paired in this workspace — metadata only (no tokens)",
        inputSchema: {},
      },
      () => run(principal, "members:read", async () => ok({ runners: await runners.listForWorkspace(ws) })),
    );
    // Workspace-shared runners (team resource, owner=ws:<workspace>) — once an admin registers one, any member can target self:ws:<id>.
    // Unlike personal runners (pair_runner, self-scoped), gated by settings:write (admin).
    server.registerTool(
      "pair_workspace_runner",
      {
        description:
          "Pair a workspace-shared runner (team build server/CI). Any member targets it as self:ws:<id>. The plaintext token (rnr_…) is shown once in the response. Admin only.",
        inputSchema: {
          label: z.string().min(1).max(80).describe("display runner name (e.g. acme-ci-runner)"),
          os: z.string().min(1).max(40).optional().describe("linux | darwin | win32, etc."),
          capabilities: z
            .array(z.enum(RUNNER_CAPABILITIES))
            .optional()
            .describe("what this runner can run (git|docker|browser|computer-use|sandbox|codex-login|claude-login)"),
        },
      },
      ({ label, os, capabilities }) =>
        run(principal, "settings:write", async () => {
          const paired = await runners.pairWorkspace({
            workspace: ws,
            label,
            ...(os !== undefined ? { os } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          });
          return ok({ runner: paired.meta, token: paired.token });
        }),
    );
    server.registerTool(
      "list_workspace_owned_runners",
      {
        description:
          "Only shared runners owned by this workspace (owner=ws:<workspace>) — unlike the roster, excludes personal runners. Admin only.",
        inputSchema: {},
      },
      () => run(principal, "settings:write", async () => ok({ runners: await runners.listWorkspaceOwned(ws) })),
    );
    server.registerTool(
      "revoke_workspace_runner",
      {
        description:
          "Unpair (delete) a workspace-shared runner. id is the id from list_workspace_owned_runners. Admin only.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "settings:write", async () => {
          await runners.revokeWorkspaceRunner(ws, id);
          return ok({ id, revoked: true });
        }),
    );
    // GitHub Actions runner self-registration — installer that stands up a GitHub runner + an Everdict workspace-shared runner together on a build server
    // script generation (design doc §4). Mints a registration token via the workspace GitHub App → only when ciLinkService exists. Admin only.
    if (deps.ciLinkService) {
      const ciForRunner = deps.ciLinkService;
      server.registerTool(
        "github_install_workspace_runner",
        {
          description:
            "Generate an install script that stands up a GitHub Actions self-hosted runner + an Everdict workspace-shared runner together on one build server (design §4). Pairs a new workspace-shared runner (rnr_ token once) + mints a registration token via the workspace GitHub App. Exactly one of repository (repo level) or org (org level) — the App must be installed on that org/repo. Run the returned script on the build server. Admin only.",
          inputSchema: {
            repository: z.string().optional().describe('repo-level target "owner/name"'),
            org: z.string().optional().describe("org-level target (shared by all repos in that org)"),
            host: z.string().url().optional().describe("GHE base URL — unset = github.com matched first"),
            runnerGroup: z
              .string()
              .optional()
              .describe("org runner group (org level only, optional) — applies that group's access policy"),
            label: z.string().max(80).optional().describe("Everdict runner display name (default: repo/org name)"),
            githubLabels: z.array(z.string()).optional().describe("extra labels for the GH runner"),
            capabilities: z.array(z.enum(RUNNER_CAPABILITIES)).optional(),
          },
        },
        ({ repository, org, host, runnerGroup, label, githubLabels, capabilities }) =>
          run(principal, "settings:write", async () =>
            ok(
              await installGithubWorkspaceRunner(
                { runnerService: runners, ciLinkService: ciForRunner },
                {
                  workspace: ws,
                  label: label ?? org ?? repository?.split("/")[1] ?? "everdict-ci",
                  apiUrl: deps.apiPublicUrl ?? "http://localhost:8787",
                  ...(repository !== undefined ? { repository } : {}),
                  ...(org !== undefined ? { org } : {}),
                  ...(host !== undefined ? { host } : {}),
                  ...(runnerGroup !== undefined ? { runnerGroup } : {}),
                  ...(githubLabels !== undefined ? { githubLabels } : {}),
                  ...(capabilities !== undefined ? { capabilities } : {}),
                },
              ),
            ),
          ),
      );
    }
  }

  // Runner protocol — `everdict runner` calls this from its own machine (runner token rnr_ → via=runner, principal.runnerId).
  // It leases a job, runs it locally, and reports the result (submit/fail). Runner token only — regular credentials are rejected.
  if (deps.runnerHub) {
    const hub = deps.runnerHub;
    // (owner=subject, runnerId) — the same key the dispatcher parked the self: job under. runnerId comes from the token.
    // Workspace-agnostic: one runner takes jobs from every workspace its owner belongs to (cross-workspace).
    const runnerKey = (): SelfHostedKey | undefined =>
      principal.runnerId ? { owner: principal.subject, runnerId: principal.runnerId } : undefined;
    const NEED_RUNNER = "FORBIDDEN: runner credentials (rnr_ pairing token) required.";

    server.registerTool(
      "lease_job",
      {
        description:
          "Fetch the next eval job (runner pull, long-poll). If none, wait up to wait_ms then {job:null} — safe to call again immediately. Passing capabilities self-advertises the runner (e.g. docker detection → service-harness gate). Report the result via submit_job_result.",
        inputSchema: {
          wait_ms: z.number().int().min(0).max(60_000).optional(),
          capabilities: z.array(z.string()).optional(),
        },
      },
      ({ wait_ms, capabilities }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) {
            await deps.runnerService.touch(key.owner, key.runnerId); // mark as connected
            // Update when the runner reports its actual capabilities (docker detection → sharpens the service-harness dispatch gate).
            if (capabilities) await deps.runnerService.setCapabilities(key.owner, key.runnerId, capabilities);
          }
          // Pass capabilities to the hub → placement gate (if a case.image needs docker but the runner lacks it, reject that job outright).
          const leased = await hub.leaseWait(key, wait_ms ?? 0, capabilities); // unset = return immediately (backward compatible)
          return ok(leased ?? { job: null });
        }),
    );
    server.registerTool(
      "submit_job_result",
      {
        description: "Report the leased job's result (CaseResult) → completes the control plane's pending dispatch.",
        inputSchema: { jobId: z.string(), result: CaseResultSchema },
      },
      ({ jobId, result }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: hub.complete(key, jobId, result) });
        }),
    );
    server.registerTool(
      "fail_job",
      {
        description: "Report the leased job's failure → ends the pending dispatch with an error.",
        inputSchema: { jobId: z.string(), message: z.string() },
      },
      ({ jobId, message }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: hub.fail(key, jobId, message) });
        }),
    );
    server.registerTool(
      "heartbeat_job",
      {
        description:
          "Runner liveness signal — refresh lastSeenAt. Passing jobId also renews that job's lease to prevent requeue during long runs.",
        inputSchema: { jobId: z.string().optional() },
      },
      ({ jobId }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) await deps.runnerService.touch(key.owner, key.runnerId);
          const extended = jobId ? hub.heartbeat(key, jobId) : false;
          return ok({ ok: true, ...(jobId ? { extended } : {}) });
        }),
    );
  }

  if (deps.keyStore) {
    const keys = deps.keyStore;
    // Personal API keys — self-scoped (no role gate). Each user views/issues/revokes only their own (subject) keys. A key acts with the issuer's privileges.
    server.registerTool(
      "list_api_keys",
      { description: "My API keys (metadata only — no plaintext/hash, identified by prefix)", inputSchema: {} },
      () => plain(async () => ok(await keys.list(ws, principal.subject))),
    );
    server.registerTool(
      "create_api_key",
      {
        description:
          "Issue a new personal API key — acts with the issuer's (my) privileges. scopes can narrow it further (read|write|admin, never exceeding your role). If unset, keeps my role. The plaintext (ak_…) is shown once in the response and can't be read again.",
        inputSchema: {
          label: z.string().max(80).optional().describe("identifying label (optional)"),
          scopes: z
            .array(z.enum(API_KEY_SCOPES))
            .nonempty()
            .optional()
            .describe("permission scope (read|write|admin). unset = keep my role"),
        },
      },
      ({ label, scopes }) =>
        plain(async () => ok({ apiKey: await issueKey(keys, ws, label, scopes ?? ["admin"], principal.subject) })),
    );
    server.registerTool(
      "revoke_api_key",
      {
        description: "Revoke my API key (effective immediately). id is the id from list_api_keys.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        plain(async () => {
          await keys.revoke(ws, id, principal.subject); // only my keys — others' keys / machine keys are a no-op
          return ok({ workspace: ws, id, revoked: true });
        }),
    );
  }

  if (deps.membershipService) {
    const membership = deps.membershipService;
    server.registerTool(
      "list_members",
      { description: "This workspace's members (subject·role·email·joined-at)", inputSchema: {} },
      () => run(principal, "members:read", async () => ok(await membership.listMembers(ws))),
    );
    server.registerTool(
      "set_member_role",
      {
        description:
          "Change a member's role (viewer|member|admin). NOT_FOUND if not a member, CONFLICT when demoting the last admin.",
        inputSchema: { subject: z.string(), role: z.enum(EVERDICT_ROLES) },
      },
      ({ subject, role }) =>
        run(principal, "members:write", async () => {
          await membership.setRole(ws, subject, role);
          return ok({ workspace: ws, subject, role });
        }),
    );
    server.registerTool(
      "remove_member",
      {
        description: "Remove a member (idempotent). Removing the last admin is CONFLICT.",
        inputSchema: { subject: z.string() },
      },
      ({ subject }) =>
        run(principal, "members:write", async () => {
          await membership.removeMember(ws, subject);
          return ok({ workspace: ws, subject, removed: true });
        }),
    );
    server.registerTool(
      "list_invites",
      { description: "This workspace's pending invites (metadata only — no token/hash)", inputSchema: {} },
      () => run(principal, "members:write", async () => ok(await membership.listInvites(ws))),
    );
    server.registerTool(
      "create_invite",
      {
        description:
          "Issue an invite token. The response token (inv_…) is shown once — share it as a link, and accepting joins with that role.",
        inputSchema: { role: z.enum(EVERDICT_ROLES), expiresInHours: z.number().int().positive().max(8760).optional() },
      },
      ({ role, expiresInHours }) =>
        run(principal, "members:write", async () => {
          const { token, meta } = await membership.createInvite({
            workspace: ws,
            role,
            createdBy: principal.subject,
            ...(expiresInHours !== undefined ? { expiresInHours } : {}),
          });
          return ok({ ...meta, token });
        }),
    );
    server.registerTool(
      "revoke_invite",
      { description: "Cancel a pending invite (id is the id from list_invites)", inputSchema: { id: z.string() } },
      ({ id }) =>
        run(principal, "members:write", async () => {
          await membership.revokeInvite(ws, id);
          return ok({ workspace: ws, id, revoked: true });
        }),
    );
    server.registerTool(
      "accept_invite",
      {
        description:
          "Accept an invite token → join that workspace (no role gate; human accounts only). Expired/used/invalid → error.",
        inputSchema: { token: z.string() },
      },
      ({ token }) => plain(async () => ok(await membership.acceptInvite(principal, token))),
    );
  }

  if (deps.workspaceService) {
    const workspaces = deps.workspaceService;
    server.registerTool(
      "list_workspaces",
      { description: "Workspaces I belong to (including role)", inputSchema: {} },
      () => plain(async () => ok(await workspaces.listForSubject(principal.subject))),
    );
    server.registerTool(
      "create_workspace",
      {
        description:
          "Create a new workspace (I become an admin member). name required, id (slug) optional — scope moves to it after creation.",
        inputSchema: {
          name: z.string().describe("display name"),
          id: z.string().optional().describe("workspace id (slug, ^[a-z0-9][a-z0-9-]*$). Derived from name if omitted"),
        },
      },
      ({ name, id }) =>
        plain(async () => ok(await workspaces.create(principal.subject, { name, ...(id ? { id } : {}) }))),
    );
    server.registerTool(
      "get_workspace",
      {
        description: "The active workspace record (id/name/logoUrl/owner/createdAt). admin (settings:read).",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await workspaces.get(ws))),
    );
    server.registerTool(
      "update_workspace",
      {
        description:
          "Update the workspace name/logo (admin, settings:write). The slug (URL) is immutable. Logo is an http(s) URL or data:image base64. Empty string removes the logo.",
        inputSchema: {
          name: z.string().optional().describe("display name (≤80 chars)"),
          logoUrl: z.string().optional().describe("logo image — http(s) URL or data:image base64"),
        },
      },
      ({ name, logoUrl }) =>
        run(principal, "settings:write", async () =>
          ok(
            await workspaces.update(ws, {
              ...(name !== undefined ? { name } : {}),
              ...(logoUrl !== undefined ? { logoUrl } : {}),
            }),
          ),
        ),
    );
    server.registerTool(
      "delete_workspace",
      {
        description:
          "Delete the active workspace (owner/creator only; irreversible). All workspace data — members, runs, settings, etc. — is deleted with it.",
        inputSchema: {},
      },
      () =>
        plain(async () => {
          await workspaces.delete(ws, principal.subject); // the service verifies owner (else FORBIDDEN)
          return ok({ workspace: ws, deleted: true });
        }),
    );
  }

  if (deps.profileService) {
    const profiles = deps.profileService;
    server.registerTool(
      "get_profile",
      {
        description:
          "Read my profile (name/username/avatar). Empty object if none. email is SSO (read-only), seen via whoami/me.",
        inputSchema: {},
      },
      () => plain(async () => ok((await profiles.get(principal.subject)) ?? {})),
    );
    server.registerTool(
      "update_profile",
      {
        description:
          "Update my profile (self-serve, role-agnostic). Only provided fields change, an empty string clears that field. email is SSO and can't be edited.",
        inputSchema: {
          name: z.string().optional().describe("display name (≤80 chars)"),
          username: z.string().optional().describe("username (alphanumeric/_/-, 2–39 chars)"),
          avatarUrl: z.string().optional().describe("avatar image — http(s) URL or data:image base64"),
        },
      },
      ({ name, username, avatarUrl }) =>
        plain(async () =>
          ok(
            await profiles.update(principal.subject, {
              ...(name !== undefined ? { name } : {}),
              ...(username !== undefined ? { username } : {}),
              ...(avatarUrl !== undefined ? { avatarUrl } : {}),
            }),
          ),
        ),
    );
  }

  if (deps.membershipService) {
    const membership = deps.membershipService;
    server.registerTool(
      "leave_workspace",
      {
        description:
          "Leave this workspace (self-serve, your own membership only). The last admin can't leave (error). After leaving, scope to another workspace.",
        inputSchema: {},
      },
      () =>
        plain(async () => {
          await membership.leaveWorkspace(ws, principal.subject);
          return ok({ workspace: ws, left: true });
        }),
    );
  }

  if (deps.settingsStore) {
    const settings = deps.settingsStore;
    server.registerTool(
      "get_workspace_settings",
      { description: "This workspace's settings (metering policy, etc.). Empty object if unset.", inputSchema: {} },
      () => run(principal, "settings:read", async () => ok((await settings.get(ws)) ?? {})),
    );
    server.registerTool(
      "set_workspace_settings",
      {
        description:
          "Partially update (merge) workspace settings. meterUsage: turn usage metering for this workspace's runs on/off. judge: the workspace default model that scores inline judge graders (HTTP parity).",
        inputSchema: {
          meterUsage: z
            .boolean()
            .optional()
            .describe("default for usage metering (per-request override takes precedence)"),
          judge: z
            .object({ provider: z.enum(["openai", "anthropic"]).optional(), model: z.string() })
            .optional()
            .describe("workspace default judge model for inline judge graders (per-request override wins)"),
        },
      },
      ({ meterUsage, judge }) =>
        run(principal, "settings:write", async () =>
          ok(
            await settings.set(ws, {
              ...(meterUsage === undefined ? {} : { meterUsage }),
              ...(judge ? { judge } : {}),
            }),
          ),
        ),
    );
  }

  return server;
}
