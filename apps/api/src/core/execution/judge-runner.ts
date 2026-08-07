import type { JudgeRunner, TrajectoryStore } from "@everdict/application-control";
import type {
  CaseJob,
  CaseResult,
  EvalCase,
  GradeContext,
  Grader,
  HarnessSpec,
  JudgeCriterion,
  JudgeRunConfig,
  JudgeSpec,
  ModelSpec,
  Placement,
  Score,
  TraceEvent,
  UnmeasuredReason,
  UsageCost,
} from "@everdict/contracts";
import { isMeasured, sanitizeScore, toScores } from "@everdict/contracts";
import { billingCharges, modelApiKeySecretName, normalizeModelBinding, priceUsd } from "@everdict/domain";
import {
  JUDGE_OVERALL_METRIC,
  type JudgeCompletion,
  JudgeGrader,
  harnessComplete,
  modelJudge,
  transportComplete,
} from "@everdict/graders";
import type { LlmTransport, LlmUsage, StreamRequest, StreamResult } from "@everdict/llm";
import { transportFor } from "@everdict/llm";
import type { HarnessInstanceRegistry, ModelRegistry, RubricRegistry } from "@everdict/registry";
import { resolveJudgeArtifacts } from "./resolve-judge-artifacts.js";

// Judge runner — JudgeSpec + tenant + GradeContext (trace) → Score[]. The control plane judges from the trace.
// model (anthropic/openai) and harness are unified via modelJudge (a transport) — only the transport differs (API call / agent dispatch).
// One judge usually yields one score; a multi-criteria judge yields one per criterion plus the overall (multi-metric contract).
// The JudgeRunner interface (the port ScoringService depends on) now lives in @everdict/application-control; this file
// is its default impl (defaultJudgeRunner) — kept in apps/api because it composes @everdict/graders transports the
// application layer must not import (re-architecture P2 S3 skip-valve). Re-exported for the compat surface.
export type { JudgeRunner };

// The metric key that distinguishes multiple judges in the summary.
const metricOf = (spec: JudgeSpec): string => `judge:${spec.id}`;

// skip score — no key / no dispatch, etc. State the reason in detail so a judge the user chose doesn't silently
// vanish, and stamp status "unmeasured": the variant carries no value and no pass at all, so a judge that never
// ran has no number to leak into an aggregate and no verdict to leak into a passRate.
// retryable=true only when retrying AS-IS can recover (a transient error); config-shaped skips (missing secret,
// unresolvable ref, no dispatcher) need a human change first and stay non-retryable.
function skip(spec: JudgeSpec, reason: UnmeasuredReason, detail: string, retryable = false): Score[] {
  return [
    {
      graderId: spec.id,
      metric: metricOf(spec),
      status: "unmeasured",
      reason,
      retryable,
      detail: `skipped: ${detail}`,
    },
  ];
}

const ANTHROPIC_KEY = "ANTHROPIC_API_KEY"; // the key name looked up in the tenant SecretStore
const OPENAI_KEY = "OPENAI_API_KEY";
const OPENAI_BASE_URL = "OPENAI_BASE_URL"; // OpenAI-compatible proxy base like LiteLLM (optional)

export interface DefaultJudgeRunnerDeps {
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries (decrypted, server-internal only)
  dispatch?: (job: CaseJob) => Promise<CaseResult>; // agent dispatch for harness judges (same path as a single run)
  harnesses?: HarnessInstanceRegistry; // resolve the harness instance a judge references (template+pins→resolved)
  models?: ModelRegistry; // if judge.model is a registered model id, resolve provider/baseUrl/underlying model (else a raw string)
  rubrics?: RubricRegistry; // if judge.rubric is a {id, version} ref, resolve the registered rubric (owner+_shared fallback)
  fetchImpl?: typeof fetch;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  // Judge-execution evidence: seal the judge's own activity (the verdict's LLM call / the dispatched judge job's
  // trace) as a `judge:<id>` plane on the judged case's child run trajectory. Best-effort — evidence, never
  // lifecycle. Absent = no plane is written.
  trajectories?: Pick<TrajectoryStore, "seal">;
  // Judge-execution metering: one line per (billing tenant × model) of the judge's own LLM cost. The composition
  // wires it to the usage meter under source "judge" + the enforcement budget (settle only — never blocks).
  // Absent = judge cost is not metered.
  meterJudgeCost?: (tenant: string, model: string, cost: UsageCost) => void;
}

// One completion the judge's transport made — recorded by the usage tee below so the judge's own execution can be
// sealed as evidence and metered. Without the tee, transportComplete discarded the transport's token usage: a judge
// verdict cost nothing and left nothing behind but its Score.detail.
interface JudgeLlmCall {
  t: number; // ms offset from the judge's start (the sealed plane's relative clock)
  model: string;
  usage?: LlmUsage;
  latencyMs: number;
  responseText?: string; // the raw verdict text — sealed as an assistant message beside the llm_call
}

// Wrap a transport so every completion (one for a single-verdict judge; the multi-criteria judge is also ONE call)
// lands in `calls`. Failures record nothing — a thrown call reported no usage to record.
function usageTeeTransport(inner: LlmTransport, startedAtMs: number, calls: JudgeLlmCall[]): LlmTransport {
  const record = async (
    req: StreamRequest,
    run: (r: StreamRequest) => Promise<StreamResult>,
  ): Promise<StreamResult> => {
    const t = Math.max(0, Date.now() - startedAtMs);
    const callStart = Date.now();
    const result = await run(req);
    calls.push({
      t,
      model: req.model,
      ...(result.usage ? { usage: result.usage } : {}),
      latencyMs: Date.now() - callStart,
      ...(typeof result.content === "string" && result.content.length > 0 ? { responseText: result.content } : {}),
    });
    return result;
  };
  const innerComplete = inner.complete?.bind(inner);
  return {
    provider: inner.provider,
    stream: (req) => record(req, (r) => inner.stream(r)),
    ...(innerComplete ? { complete: (req: StreamRequest) => record(req, innerComplete) } : {}),
  };
}

// A model judge's execution as trace events: one llm_call per completion — cost priced from the transport's token
// usage (the judge is OUR call; unlike a harness there is no self-reported total_cost_usd to read) — plus the raw
// verdict text as an assistant message, so the run detail shows WHY beside HOW MUCH.
function modelJudgeEvents(calls: JudgeLlmCall[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const call of calls) {
    events.push({
      t: call.t,
      kind: "llm_call",
      model: call.model,
      ...(call.usage
        ? {
            cost: {
              inputTokens: call.usage.inputTokens,
              outputTokens: call.usage.outputTokens,
              usd: priceUsd(call.model, call.usage),
            },
          }
        : {}),
      latencyMs: call.latencyMs,
    });
    if (call.responseText !== undefined)
      events.push({ t: call.t, kind: "message", role: "assistant", text: call.responseText });
  }
  return events;
}

// Meter + seal one judge execution. Metering: a dispatched judge (code/harness) reuses the SAME provenance policy a
// case's own billing uses (billingCharges — managed → the tenant pays; a personal self-hosted run is own-pays unless
// the model is workspace-billed), source rewritten to "judge" by the composition; a model judge is a control-plane
// call on the workspace's key, so the tenant pays directly. A judge score is never a metered evaluation. Sealing:
// the events land as a `judge:<id>` plane on the child run's trajectory — BESIDE the execution/infra planes, never
// inside them, so the judged evidence stays clean (a judge must not read its own account) and billingCharges over
// the case's trace cannot double-bill the judge's cost as harness cost. Best-effort by contract: evidence, never
// lifecycle — a meter/seal failure never fails the verdict.
async function reportJudgeExecution(
  deps: DefaultJudgeRunnerDeps,
  input: { spec: JudgeSpec; tenant: string; events: TraceEvent[]; t0: string; runId?: string; billing?: CaseResult },
): Promise<void> {
  if (input.events.length === 0) return;
  try {
    if (deps.meterJudgeCost) {
      if (input.billing) {
        for (const charge of billingCharges(input.billing, input.tenant)) {
          // The empty-model line is billingCharges' evaluation counter — a judge adds cost, not an evaluation.
          if (charge.model !== "") deps.meterJudgeCost(charge.tenant, charge.model, charge.cost);
        }
      } else {
        for (const e of input.events) {
          // A zero-usage call (a provider that reported nothing) is not a billing line — the evidence still seals.
          if (e.kind === "llm_call" && e.cost && (e.cost.inputTokens + e.cost.outputTokens > 0 || e.cost.usd > 0))
            deps.meterJudgeCost(input.tenant, e.model, {
              usd: e.cost.usd,
              tokens: e.cost.inputTokens + e.cost.outputTokens,
            });
        }
      }
    }
  } catch {
    // metering is best-effort — never fail the verdict over it
  }
  if (input.runId !== undefined && deps.trajectories) {
    await deps.trajectories
      .seal({
        runId: input.runId,
        tenant: input.tenant,
        source: "run",
        emitter: `judge:${input.spec.id}`,
        events: input.events,
        t0: input.t0,
      })
      .catch(() => {});
  }
}

// The effective judging fields after rubric resolution — what actually reaches the JudgeGrader.
export interface EffectiveRubric {
  rubricText?: string;
  criteria?: JudgeCriterion[];
  promptTemplate?: string;
}

// Resolve spec.rubric to the effective judging fields. Inline string → as-is; {id, version} ref → registry lookup
// (owner-first + _shared fallback). The judge's own criteria/promptTemplate override the rubric's (more specific wins).
// A missing registry dep or unresolved rubric returns a skip reason — a judge the user chose never silently vanishes.
// Exported so the preview/dry-run surfaces resolve the effective rubric IDENTICALLY to a real grade (no duplication).
export async function resolveRubric(
  rubrics: RubricRegistry | undefined,
  tenant: string,
  spec: JudgeSpec,
): Promise<{ effective: EffectiveRubric } | { skipReason: string }> {
  if (spec.kind === "code") return { effective: {} }; // a code judge has no rubric/criteria/template — code IS the rubric
  const ref = spec.rubric;
  const own: EffectiveRubric = {
    ...(spec.criteria?.length ? { criteria: spec.criteria } : {}),
    ...(spec.promptTemplate ? { promptTemplate: spec.promptTemplate } : {}),
  };
  if (ref === undefined) return { effective: own };
  if (typeof ref === "string") return { effective: { rubricText: ref, ...own } };
  const version = ref.version || "latest";
  if (!rubrics) return { skipReason: `rubric registry not configured (rubric ref '${ref.id}@${version}')` };
  try {
    const resolved = await rubrics.get(tenant, ref.id, version);
    return {
      effective: {
        ...(resolved.text ? { rubricText: resolved.text } : {}),
        ...(spec.criteria?.length
          ? { criteria: spec.criteria }
          : resolved.criteria?.length
            ? { criteria: resolved.criteria }
            : {}),
        ...(spec.promptTemplate
          ? { promptTemplate: spec.promptTemplate }
          : resolved.promptTemplate
            ? { promptTemplate: resolved.promptTemplate }
            : {}),
      },
    };
  } catch (err) {
    return {
      skipReason: `rubric '${ref.id}@${version}' unresolved: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Resolve the referenced harness: concrete version + (declarative) spec. Built-in/unregistered are as-given.
async function resolveJudgeHarness(
  harnesses: HarnessInstanceRegistry | undefined,
  tenant: string,
  ref: { id: string; version: string },
): Promise<{ version: string; spec?: HarnessSpec }> {
  if (!harnesses) return { version: ref.version || "latest" };
  try {
    const spec = await harnesses.get(tenant, ref.id, ref.version || "latest");
    return { version: spec.version, spec };
  } catch {
    return { version: ref.version || "latest" };
  }
}

// The env file the code judge's ORIGINAL context is materialized into (relative to the job's work dir) — the
// script grader passes it as argv[1], so a code judge script has the exact ScriptGrader contract.
const JUDGE_CONTEXT_FILE = "judge-context.json";

// The sandboxed wrapper job a code judge executes as: a no-op command harness (`true` → empty trace) plus a script
// grader over the ORIGINAL case's serialized judge context ({case, trace, snapshot, evidence} as an env file).
// spec.model rides the job.judge channel (JudgeAuthDispatcher → EVERDICT_JUDGE_MODEL/PROVIDER + provider key env).
// Shared by the batch scoring path (runCodeJudge dispatches it inline) and the wizard dry-run (JudgePreviewService
// submits it as a standalone run so the user can watch it progress).
export interface CodeJudgeJob {
  evalCase: EvalCase;
  harness: { id: string; version: string };
  harnessSpec: HarnessSpec;
  judge?: JudgeRunConfig;
}

export function buildCodeJudgeJob(
  spec: Extract<JudgeSpec, { kind: "code" }>,
  ctx: GradeContext,
  placement?: Placement,
): CodeJudgeJob {
  const scriptFile = spec.language === "python" ? "judge.py" : "judge.mjs";
  const files: Record<string, string> = {
    [JUDGE_CONTEXT_FILE]: JSON.stringify({
      case: ctx.case,
      trace: ctx.trace,
      snapshot: ctx.snapshot,
      ...(ctx.evidence ? { evidence: ctx.evidence } : {}),
    }),
    ...(spec.code ? { [scriptFile]: spec.code } : {}),
  };
  // Placement: spec.runtime (explicit) first → else inherit the source run's placement (co-locate).
  const judgePlacement: Placement | undefined = spec.runtime ? { target: spec.runtime } : placement;
  const evalCase: EvalCase = {
    id: `judge-${spec.id}-${ctx.case.id}`,
    env: { kind: "repo", source: { files } },
    task: "code judge", // the verdict comes from the script grader, not the harness
    graders: [
      {
        id: "script",
        config: {
          language: spec.language,
          entrypoint: spec.code ? scriptFile : (spec.entrypoint ?? scriptFile),
          cwd: "work",
          contextPath: JUDGE_CONTEXT_FILE,
          timeoutSec: spec.timeoutSec,
          id: "judge",
        },
      },
    ],
    timeoutSec: spec.timeoutSec + 120, // job slack over the grading budget (env materialize + no-op harness)
    tags: ["judge"],
    ...(spec.image ? { image: spec.image } : {}),
    ...(judgePlacement ? { placement: judgePlacement } : {}),
  };
  return {
    evalCase,
    harness: { id: `judge-${spec.id}`, version: spec.version },
    // Declarative no-op command harness — the agent interprets it with no code; `true` produces an empty trace.
    harnessSpec: {
      kind: "command",
      id: `judge-${spec.id}`,
      version: spec.version,
      setup: [],
      command: "true",
      env: {},
      params: {},
      trace: { kind: "none" },
    },
    ...(spec.model ? { judge: { model: spec.model, ...(spec.provider ? { provider: spec.provider } : {}) } } : {}),
  };
}

// Rewrite the wrapper job's raw script scores into this judge's identity — graderId stamped, "judge" metric prefix
// → judge:<id> (judge:<sub> → judge:<id>:<sub>), exactly like the model path.
function stampCodeJudgeScores(spec: Extract<JudgeSpec, { kind: "code" }>, scores: Score[]): Score[] {
  // sanitizeScore: a code judge emitting garbage (NaN, empty ids) becomes a visible invalid score here too.
  return scores.map((score) =>
    sanitizeScore({
      ...score,
      graderId: spec.id,
      metric: score.metric.replace(/^judge/, metricOf(spec)),
    }),
  );
}

// code judge — dispatch the sandboxed wrapper job inline (batch scoring path). The code never runs on the control
// plane; placement/trust-zone/self-hosted routing are the same machinery as any dispatch.
async function runCodeJudge(
  spec: Extract<JudgeSpec, { kind: "code" }>,
  tenant: string,
  ctx: GradeContext,
  deps: DefaultJudgeRunnerDeps,
  placement?: Placement,
  submittedBy?: string,
  runId?: string,
): Promise<Score[]> {
  if (!deps.dispatch) return skip(spec, "unsupported", "code judge dispatch not configured");
  const built = buildCodeJudgeJob(spec, ctx, placement);
  const job: CaseJob = {
    evalCase: built.evalCase,
    harness: built.harness,
    harnessSpec: built.harnessSpec,
    tenant,
    // Carry the producing run's submitter — a co-located self:<runnerId> placement resolves its owner from
    // submittedBy (RuntimeDispatcher). Dropping it made every code judge on a self-hosted scorecard skip.
    ...(submittedBy ? { submittedBy } : {}),
    ...(built.judge ? { judge: built.judge } : {}),
  };
  const startedAt = new Date().toISOString();
  try {
    const result = await deps.dispatch(job);
    // The wrapper job's own account (placement plane + any script output) is this judge's execution evidence —
    // sealed whether or not the job failed: a dead judge job's trace IS the diagnosis. Its llm_call cost (if the
    // trace carries any) meters under source "judge" with the case-billing provenance policy.
    await reportJudgeExecution(deps, {
      spec,
      tenant,
      events: result.trace,
      t0: startedAt,
      ...(runId !== undefined ? { runId } : {}),
      billing: result,
    });
    if (result.failure) {
      return skip(
        spec,
        "grader_error",
        `code judge job failed at ${result.failure.stage}: ${result.failure.message}`,
        true,
      );
    }
    // The wrapper job's scores ARE the code's verdict — stamp this judge's identity onto them.
    return stampCodeJudgeScores(spec, result.scores);
  } catch (err) {
    return skip(spec, "grader_error", err instanceof Error ? err.message : String(err), true);
  }
}

// Default implementation: model calls the provider with the tenant secret key (anthropic/openai), harness spins up the referenced agent to judge.
export function defaultJudgeRunner(deps: DefaultJudgeRunnerDeps): JudgeRunner {
  return {
    async run(spec, tenant, rawCtx, placement, submittedBy, runId) {
      // Resolve artifact URLs → real data before ANY judge sees the context (offloaded/ingested/re-scored refs):
      // text artifacts (evidence {name} slots + dom that ARE urls) for every judge; the screenshot image only when a
      // model judge actually consumes it (avoids a large fetch a text-only judge would ignore). A no-op when the
      // context carries no url refs. `ctx` below is the resolved view for every downstream path.
      const wantsImage = spec.kind === "model" && (spec.inputs ?? []).includes("screenshot");
      const ctx = await resolveJudgeArtifacts(rawCtx, deps.fetchImpl ?? fetch, { image: wantsImage });
      // code judge — its own dispatch path (no rubric/transport); see runCodeJudge above.
      if (spec.kind === "code") return runCodeJudge(spec, tenant, ctx, deps, placement, submittedBy, runId);
      // 1) Resolve the rubric first (cheapest gate — no secret read / provider call when it can't resolve).
      //    Inline string = as-is; {id, version} ref = registry lookup; unresolved → visible skip.
      const rubricResolution = await resolveRubric(deps.rubrics, tenant, spec);
      if ("skipReason" in rubricResolution) return skip(spec, "unsupported", rubricResolution.skipReason);
      const { rubricText, criteria, promptTemplate } = rubricResolution.effective;

      // 2) Choose the transport. Skip (with a stated reason) if there's no key/dispatcher.
      // Both transports record their execution for the report below: the model tee captures each completion's
      // usage/verdict text, the harness closure captures the dispatched judge job's whole CaseResult.
      const judgeStartedAt = new Date().toISOString();
      const judgeStartMs = Date.now();
      const modelCalls: JudgeLlmCall[] = [];
      let dispatchedJudge: CaseResult | undefined;
      let complete: JudgeCompletion;
      if (spec.kind === "harness") {
        if (!deps.dispatch) return skip(spec, "unsupported", "harness judge dispatch not configured");
        const dispatch = deps.dispatch;
        const ref = spec.harness;
        const resolved = await resolveJudgeHarness(deps.harnesses, tenant, ref);
        // Placement decision: spec.runtime (explicit) first → else inherit the source run's placement (co-locate, judge next to the observations).
        // If neither, no placement (default backend). An unregistered runtime makes the dispatcher throw → the try/catch below handles it as skip.
        const judgePlacement: Placement | undefined = spec.runtime ? { target: spec.runtime } : placement;
        complete = harnessComplete({
          dispatch: async (task) => {
            const evalCase: EvalCase = {
              id: `judge-${spec.id}-${ctx.case.id}`,
              env: { kind: "repo", source: { files: {} } },
              task, // pass the judging prompt (rubric + trace + JSON requirement) straight to the agent
              graders: [],
              timeoutSec: 300,
              tags: ["judge"],
              ...(judgePlacement ? { placement: judgePlacement } : {}),
            };
            const job: CaseJob = {
              evalCase,
              harness: { id: ref.id, version: resolved.version },
              tenant,
              // Same co-locate ownership contract as the code judge — a self:<runnerId> judge placement needs the submitter.
              ...(submittedBy ? { submittedBy } : {}),
              ...(resolved.spec ? { harnessSpec: resolved.spec } : {}),
            };
            const result = await dispatch(job);
            dispatchedJudge = result; // the judge agent's own run — this judge's execution evidence
            return result.trace;
          },
        });
      } else {
        // Swallowing a secret-decryption failure (e.g. EVERDICT_SECRETS_KEY / encryption-key mismatch) as an empty map would make a secret that
        // actually exists read as undefined at `secrets[KEY]` below, misjudged as "not configured", silently skipping the judge.
        // Catch the throw but skip while exposing the real decryption reason, with no empty-map fallback.
        let secrets: Record<string, string>;
        try {
          secrets = await deps.secretsFor(tenant);
        } catch (err) {
          return skip(
            spec,
            "missing_secret",
            `secret decryption failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // judge.model is a Model BINDING (registered id/ref | raw string). Resolve a registered Model exactly like a
        // harness does: its provider/underlying model/baseUrl/apiKeySecret + params carry the whole connection, so one
        // model definition is the single source of "what to call + how to authenticate" everywhere it's referenced.
        // A bare string that is not a registered id stays a raw model name (provider-default key, back-compat); an
        // EXPLICIT ref that can't resolve is a visible skip — never silently sent to the provider as a literal model name.
        const { ref, version } = normalizeModelBinding(spec.model);
        const explicitRef = typeof spec.model !== "string";
        let provider: "anthropic" | "openai" = spec.provider;
        let model = ref;
        let modelBaseUrl: string | undefined;
        let maxTokens: number | undefined;
        let keyName = provider === "anthropic" ? ANTHROPIC_KEY : OPENAI_KEY;
        let resolvedModel: ModelSpec | undefined;
        if (deps.models) {
          try {
            resolvedModel = await deps.models.get(tenant, ref, version);
          } catch {
            resolvedModel = undefined; // not a registered id
          }
        }
        if (resolvedModel) {
          provider = resolvedModel.provider;
          model = resolvedModel.model;
          modelBaseUrl = resolvedModel.baseUrl;
          maxTokens = resolvedModel.params?.maxTokens;
          keyName = modelApiKeySecretName(resolvedModel);
        } else if (explicitRef) {
          return skip(
            spec,
            "unsupported",
            `model '${ref}${version === "latest" ? "" : `@${version}`}' is not a registered model in this workspace`,
          );
        }
        const apiKey = secrets[keyName];
        if (!apiKey) return skip(spec, "missing_secret", `${keyName} secret not configured`);
        // Same provider-native transport the agent uses (@everdict/llm) — Anthropic Messages / OpenAI, custom baseUrl
        // for an OpenAI-compatible endpoint. The OPENAI_BASE_URL secret still overrides for the openai provider.
        const baseUrl =
          provider === "anthropic"
            ? (modelBaseUrl ?? deps.anthropicBaseUrl)
            : (secrets[OPENAI_BASE_URL] ?? modelBaseUrl ?? deps.openaiBaseUrl);
        const transport = transportFor({
          provider,
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        // The tee records each completion's usage/verdict for the execution report — transportComplete alone
        // discards the transport's usage, which is exactly how judge cost used to vanish.
        complete = transportComplete(usageTeeTransport(transport, judgeStartMs, modelCalls), {
          model,
          ...(maxTokens ? { maxTokens } : {}),
        });
      }

      // 3) Unified judging: wrap modelJudge (transport) in JudgeGrader to score the trace → judge:<id> score(s).
      try {
        const useScreenshot = spec.kind === "model" && (spec.inputs ?? []).includes("screenshot");
        const grader: Grader = new JudgeGrader(modelJudge(complete), {
          id: spec.id,
          ...(rubricText ? { rubric: rubricText } : {}),
          ...(criteria?.length ? { criteria } : {}),
          ...(promptTemplate ? { promptTemplate } : {}),
          useScreenshot,
        });
        // Artifact URLs (screenshot bytes, url evidence slots) are already resolved to real data at the top of run().
        const graded = toScores(await grader.grade(ctx));
        const threshold = spec.kind === "model" ? spec.passThreshold : undefined;
        // JudgeGrader emits the metric prefix "judge" (criteria as "judge:<criterion>") — rewrite the prefix to this
        // judge's identity so multiple selected judges stay distinct: judge:<id> / judge:<id>:<criterion>.
        // spec.passThreshold re-decides pass for the OVERALL score only (criteria carry their own passThreshold).
        // sanitizeScore: a judge transport returning garbage (NaN score) becomes a visible INVALID score at
        // THIS collection boundary too — safeGrade guards the in-job path, this guards the control-plane one.
        return graded.map((score) => {
          const metric = score.metric.replace(/^judge/, metricOf(spec));
          // A criterion the judge could not score is unmeasured — it has no value for a threshold to read
          // and no pass to re-decide, so only its identity is rewritten.
          if (!isMeasured(score)) return sanitizeScore({ ...score, metric });
          const isOverall = score.metric === JUDGE_OVERALL_METRIC; // the graders-exported name, not a re-typed literal
          const pass = isOverall && threshold != null ? score.value >= threshold : score.pass;
          return sanitizeScore({ ...score, metric, ...(pass != null ? { pass } : {}) });
        });
      } catch (err) {
        return skip(spec, "grader_error", err instanceof Error ? err.message : String(err), true);
      } finally {
        // The execution happened whether or not the verdict parsed — a failed parse still spent the tokens, so the
        // report (meter + judge:<id> evidence plane) runs on BOTH exits. Pre-transport skips never reach here.
        const events = spec.kind === "harness" ? (dispatchedJudge?.trace ?? []) : modelJudgeEvents(modelCalls);
        await reportJudgeExecution(deps, {
          spec,
          tenant,
          events,
          t0: judgeStartedAt,
          ...(runId !== undefined ? { runId } : {}),
          ...(dispatchedJudge !== undefined ? { billing: dispatchedJudge } : {}),
        });
      }
    },
  };
}
