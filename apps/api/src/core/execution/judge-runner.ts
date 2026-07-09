import type {
  AgentJob,
  CaseResult,
  EvalCase,
  GradeContext,
  Grader,
  HarnessSpec,
  JudgeSpec,
  Placement,
  Score,
} from "@everdict/core";
import { toScores } from "@everdict/core";
import {
  type JudgeCompletion,
  JudgeGrader,
  anthropicComplete,
  harnessComplete,
  modelJudge,
  openaiComplete,
} from "@everdict/graders";
import type { HarnessInstanceRegistry, ModelRegistry } from "@everdict/registry";

// Judge runner — JudgeSpec + tenant + GradeContext (trace) → Score[]. The control plane judges from the trace.
// model (anthropic/openai) and harness are unified via modelJudge (a transport) — only the transport differs (API call / agent dispatch).
// One judge usually yields one score; a multi-criteria judge yields one per criterion plus the overall (multi-metric contract).
export interface JudgeRunner {
  // placement = the source run's placement (where the observations are). A harness judge prefers spec.runtime, else inherits this (co-locate).
  run(spec: JudgeSpec, tenant: string, ctx: GradeContext, placement?: Placement): Promise<Score[]>;
}

// The metric key that distinguishes multiple judges in the summary.
const metricOf = (spec: JudgeSpec): string => `judge:${spec.id}`;

// skip score — no key / no dispatch, etc. State the reason in detail so a judge the user chose doesn't silently vanish.
function skip(spec: JudgeSpec, reason: string): Score[] {
  return [{ graderId: spec.id, metric: metricOf(spec), value: 0, pass: undefined, detail: `skipped: ${reason}` }];
}

const ANTHROPIC_KEY = "ANTHROPIC_API_KEY"; // the key name looked up in the tenant SecretStore
const OPENAI_KEY = "OPENAI_API_KEY";
const OPENAI_BASE_URL = "OPENAI_BASE_URL"; // OpenAI-compatible proxy base like LiteLLM (optional)

export interface DefaultJudgeRunnerDeps {
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries (decrypted, server-internal only)
  dispatch?: (job: AgentJob) => Promise<CaseResult>; // agent dispatch for harness judges (same path as a single run)
  harnesses?: HarnessInstanceRegistry; // resolve the harness instance a judge references (template+pins→resolved)
  models?: ModelRegistry; // if judge.model is a registered model id, resolve provider/baseUrl/underlying model (else a raw string)
  fetchImpl?: typeof fetch;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
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

// Default implementation: model calls the provider with the tenant secret key (anthropic/openai), harness spins up the referenced agent to judge.
export function defaultJudgeRunner(deps: DefaultJudgeRunnerDeps): JudgeRunner {
  return {
    async run(spec, tenant, ctx, placement) {
      // 1) Choose the transport. Skip (with a stated reason) if there's no key/dispatcher.
      let complete: JudgeCompletion;
      if (spec.kind === "harness") {
        if (!deps.dispatch) return skip(spec, "harness judge dispatch not configured");
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
            const job: AgentJob = {
              evalCase,
              harness: { id: ref.id, version: resolved.version },
              tenant,
              ...(resolved.spec ? { harnessSpec: resolved.spec } : {}),
            };
            return (await dispatch(job)).trace;
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
          return skip(spec, `secret decryption failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // If judge.model is a registered model id, resolve it via that spec (provider/underlying model/baseUrl) — else use the raw model string.
        let provider: "anthropic" | "openai" = spec.provider;
        let model = spec.model;
        let modelBaseUrl: string | undefined;
        if (deps.models) {
          try {
            const m = await deps.models.get(tenant, spec.model, "latest");
            provider = m.provider;
            model = m.model;
            modelBaseUrl = m.baseUrl;
          } catch {
            // Not a registered model id → use spec.model as a raw model string.
          }
        }
        if (provider === "anthropic") {
          const apiKey = secrets[ANTHROPIC_KEY];
          if (!apiKey) return skip(spec, `${ANTHROPIC_KEY} secret not configured`);
          const baseUrl = modelBaseUrl ?? deps.anthropicBaseUrl;
          complete = anthropicComplete({
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        } else {
          const apiKey = secrets[OPENAI_KEY];
          if (!apiKey) return skip(spec, `${OPENAI_KEY} secret not configured`);
          const baseUrl = secrets[OPENAI_BASE_URL] ?? modelBaseUrl ?? deps.openaiBaseUrl;
          complete = openaiComplete({
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        }
      }

      // 2) Unified judging: wrap modelJudge (transport) in JudgeGrader to score the trace → judge:<id> score(s).
      try {
        const rubric = spec.rubric;
        const useScreenshot = spec.kind === "model" && (spec.inputs ?? []).includes("screenshot");
        const grader: Grader = new JudgeGrader(modelJudge(complete), {
          id: spec.id,
          ...(rubric ? { rubric } : {}),
          ...(spec.criteria?.length ? { criteria: spec.criteria } : {}),
          ...(spec.promptTemplate ? { promptTemplate: spec.promptTemplate } : {}),
          useScreenshot,
        });
        const graded = toScores(await grader.grade(ctx));
        const threshold = spec.kind === "model" ? spec.passThreshold : undefined;
        // JudgeGrader emits the metric prefix "judge" (criteria as "judge:<criterion>") — rewrite the prefix to this
        // judge's identity so multiple selected judges stay distinct: judge:<id> / judge:<id>:<criterion>.
        // spec.passThreshold re-decides pass for the OVERALL score only (criteria carry their own passThreshold).
        return graded.map((score) => {
          const isOverall = score.metric === "judge";
          const pass = isOverall && threshold != null ? score.value >= threshold : score.pass;
          return {
            ...score,
            metric: score.metric.replace(/^judge/, metricOf(spec)),
            ...(pass != null ? { pass } : {}),
          };
        });
      } catch (err) {
        return skip(spec, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
