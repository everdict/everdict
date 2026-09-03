import { deleteJudgeVersion, setVersionTags } from "@everdict/application-control";
import { JudgeSpecSchema, UntrustedTraceEventSchema } from "@everdict/contracts";
import { diffJudgeSpecs } from "@everdict/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  FROM_ISSUE_TOOL_DESCRIPTION,
  ORIGIN_NOTE_TOOL_DESCRIPTION,
  capabilityOriginFor,
  declaredOriginFromIssue,
} from "../capability-origin.js";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";
export function registerJudgeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.judgeRegistry) {
    const judges = deps.judgeRegistry;
    server.registerTool(
      "list_judges",
      {
        annotations: { readOnlyHint: true },
        description:
          "Agent Judges visible to this workspace (owned + _shared default judges). `team` narrows to one " +
          "team's own judges (id or key, ENG).",
        inputSchema: { team: z.string().optional().describe('only this team\'s judges — id or key ("ENG")') },
      },
      ({ team }) =>
        run(principal, "judges:read", async () => {
          // The visible-team ceiling first; `team` is the narrow on top of it, never a way past it.
          const visible = await judges.list(ws);
          return ok(visible);
        }),
    );

    server.registerTool(
      "get_judge",
      {
        annotations: { readOnlyHint: true },
        description: "A full JudgeSpec (model | harness). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) =>
        run(principal, "judges:read", async () => {
          return ok(await judges.get(ws, id, version ?? "latest"));
        }),
    );

    server.registerTool(
      "diff_judge_versions",
      {
        annotations: { readOnlyHint: true },
        description:
          'Structural field-level diff between two versions of the same judge id — leaf changes by path (model/provider/rubric/inputs/passThreshold/criteria/…). Both refs accept "latest". Requires judges:read (viewer+). Reproducible by the immutable-version guarantee.',
        inputSchema: {
          id: z.string(),
          base: z.string().describe('base version ref (accepts "latest")'),
          candidate: z.string().describe('candidate version ref (accepts "latest")'),
        },
      },
      ({ id, base, candidate }) =>
        run(principal, "judges:read", async () => {
          // A private team's asset reads as one that does not exist — the guard its own `get_` sibling
          // already carries, on the door that returns the same bytes (arch-review 119).
          const [baseSpec, candidateSpec] = await Promise.all([
            judges.get(ws, id, base),
            judges.get(ws, id, candidate),
          ]);
          return ok(diffJudgeSpecs(baseSpec, candidateSpec));
        }),
    );

    server.registerTool(
      "delete_judge",
      {
        description:
          "Soft-delete a judge version (tombstone — past scorecard history is preserved, future scorecards fail to resolve). Only that version's creator or a workspace admin.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("judge version to delete (exact version — latest not allowed)"),
        },
      },
      ({ id, version }) => plain(async () => ok(await deleteJudgeVersion(judges, principal, id, version))),
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
        annotations: { readOnlyHint: false },
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
        annotations: { readOnlyHint: false },
        description:
          "Register a JudgeSpec (JSON string) as owned by this workspace (model/harness; immutable; CONFLICT on collision)",
        inputSchema: {
          judge: z.string().describe("JudgeSpec JSON"),
          team: z
            .string()
            .optional()
            .describe(
              'the owning team — id or key ("ENG"). A team you are not on is refused. Absent: your own team, else the workspace default',
            ),
          fromIssue: z.string().optional().describe(FROM_ISSUE_TOOL_DESCRIPTION),
          originNote: z.string().max(500).optional().describe(ORIGIN_NOTE_TOOL_DESCRIPTION),
        },
      },
      ({ judge, team, fromIssue, originNote }) =>
        run(ctx.principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(judge);
          } catch {
            return fail("BAD_REQUEST: not a valid JudgeSpec JSON.");
          }
          const result = JudgeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          const origin = await capabilityOriginFor(
            deps,
            ws,
            "mcp",
            ctx.agent,
            declaredOriginFromIssue(fromIssue, originNote),
            { type: "judge", id: result.data.id },
          );
          await judges.register(ws, result.data, principal.subject, origin); // creator stamp — HTTP parity
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.judgePreviewService) {
    const preview = deps.judgePreviewService;
    server.registerTool(
      "preview_judge",
      {
        annotations: { readOnlyHint: true },
        description:
          "Preview what a judge would see on a sample trace — renders the exact judging prompt + per-placeholder " +
          "evidence coverage (present/chars/truncated) + warnings, with NO model call. Verify a judge before " +
          "committing it to a scorecard. Requires judges:read.",
        inputSchema: {
          judge: z.string().describe("JudgeSpec JSON (kind: model | harness)"),
          trace: z.string().describe("TraceEvent[] JSON — the sample execution trace to judge over"),
          task: z.string().optional().describe("the task the agent was given (evidence context)"),
          expected: z.string().optional().describe("reference/expected output, if any"),
        },
      },
      ({ judge, trace, task, expected }) =>
        run(principal, "judges:read", async () => {
          let specJson: unknown;
          let traceJson: unknown;
          try {
            specJson = JSON.parse(judge);
            traceJson = JSON.parse(trace);
          } catch {
            return fail("BAD_REQUEST: judge and trace must be valid JSON.");
          }
          const spec = JudgeSpecSchema.safeParse(specJson);
          if (!spec.success) return fail(`BAD_REQUEST: ${spec.error.message}`);
          const events = UntrustedTraceEventSchema.array().safeParse(traceJson);
          if (!events.success) return fail(`BAD_REQUEST: ${events.error.message}`);
          return ok(
            await preview.preview({
              tenant: ws,
              spec: spec.data,
              evidence: {
                source: "trace",
                trace: events.data,
                ...(task ? { task } : {}),
                ...(expected ? { expected } : {}),
              },
            }),
          );
        }),
    );

    server.registerTool(
      "try_judge",
      {
        annotations: { readOnlyHint: false },
        description:
          "Dry-run a judge — ACTUALLY runs it (one case) over a pasted trace OR a prior run's re-scored trace " +
          "(pass runId). model/harness judges return the real scores + rendered prompt (a missing key/unresolved " +
          "rubric surfaces as a skip score with a reason). A code judge is promoted to a REAL standalone run and " +
          "returns its runId — poll get_run for progress and the verdict. Requires scorecards:run (keys/budget).",
        inputSchema: {
          judge: z.string().describe("JudgeSpec JSON (kind: model | harness)"),
          runId: z.string().optional().describe("re-score this prior run's trace (source A). Omit to use `trace`."),
          trace: z.string().optional().describe("TraceEvent[] JSON (source B). Used when runId is omitted."),
          task: z.string().optional().describe("the task the agent was given (trace source only)"),
          expected: z.string().optional().describe("reference/expected output, if any (trace source only)"),
        },
      },
      ({ judge, runId, trace, task, expected }) =>
        run(principal, "scorecards:run", async () => {
          let specJson: unknown;
          try {
            specJson = JSON.parse(judge);
          } catch {
            return fail("BAD_REQUEST: judge must be valid JSON.");
          }
          const spec = JudgeSpecSchema.safeParse(specJson);
          if (!spec.success) return fail(`BAD_REQUEST: ${spec.error.message}`);
          if (runId)
            return ok(
              await preview.try({
                tenant: ws,
                spec: spec.data,
                evidence: { source: "run", runId },
                createdBy: principal.subject,
              }),
            );
          if (!trace) return fail("BAD_REQUEST: provide runId or trace.");
          let traceJson: unknown;
          try {
            traceJson = JSON.parse(trace);
          } catch {
            return fail("BAD_REQUEST: trace must be valid JSON.");
          }
          const events = UntrustedTraceEventSchema.array().safeParse(traceJson);
          if (!events.success) return fail(`BAD_REQUEST: ${events.error.message}`);
          return ok(
            await preview.try({
              tenant: ws,
              spec: spec.data,
              evidence: {
                source: "trace",
                trace: events.data,
                ...(task ? { task } : {}),
                ...(expected ? { expected } : {}),
              },
              createdBy: principal.subject,
            }),
          );
        }),
    );
  }
}
