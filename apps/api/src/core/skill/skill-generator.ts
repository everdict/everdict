import { BadRequestError } from "@everdict/contracts";
import type { GenerateSkillResult } from "@everdict/contracts/wire";
import { modelApiKeySecretName } from "@everdict/domain";
import { type JudgeCompletion, transportComplete } from "@everdict/graders";
import { transportFor } from "@everdict/llm";
import type { ModelRegistry } from "@everdict/registry";
import type { ScopedSecretTiers } from "../execution/judge-auth-dispatcher.js";

// skill-generate — turn a member's natural-language description into a SKILL.md-style draft (name + description +
// instructions) via the workspace's own registered model + key. The draft is returned for the member to edit and save;
// generation persists nothing. Reuses the model-connection resolution ModelService.testConnection uses (registered
// ModelSpec → apiKeySecret from the workspace/personal secret tiers → anthropic/openai completion).

const SYSTEM_PROMPT = [
  "You are a skill author for Everdict — a runtime that runs and evaluates agent harnesses and produces scorecards,",
  "judge verdicts, and traces. A SKILL is a short, reusable procedure Everdict's own conversational agent follows for a",
  "recurring task. The agent reaches workspace data through READ-ONLY tools over MCP (e.g. list_scorecards, get_scorecard,",
  "inspect_trace, diff_scorecards, list_runs, get_run, get_harness_instance, inspect_runtime, get_queue). It cannot",
  "mutate unless the workspace connected its own write tools.",
  "",
  "Write ONE skill from the user's description. Output ONLY a JSON object with exactly these keys:",
  '  "name": a short kebab-case identifier (e.g. "scorecard-triage"),',
  '  "description": one line — when to use this skill / what it produces,',
  '  "instructions": the skill body as a numbered markdown procedure the agent follows step by step, naming concrete',
  "     Everdict read tools where relevant and telling the agent how to present its findings.",
  "Do not wrap the JSON in prose or code fences. Output the JSON object and nothing else.",
].join("\n");

const GENERATE_MAX_TOKENS = 4096; // a skill body is longer than a probe; give the model room to write the procedure.

export interface SkillGeneratorDeps {
  models: ModelRegistry;
  scopedSecretsFor: (tenant: string, subject?: string) => Promise<ScopedSecretTiers>;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

// Extract the skill draft from the model's reply. Lenient: prefer a parsed JSON object; if the model didn't comply,
// fall back to using its whole reply as the instructions body so the member always gets an editable draft.
function parseDraft(text: string, description: string): GenerateSkillResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const name = typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : "new-skill";
      const desc =
        typeof obj.description === "string" && obj.description.trim().length > 0
          ? obj.description.trim()
          : description.slice(0, 120);
      const instructions =
        typeof obj.instructions === "string" && obj.instructions.trim().length > 0
          ? obj.instructions.trim()
          : text.trim();
      return { name, description: desc, instructions };
    } catch {
      // fall through to the raw-text fallback
    }
  }
  return { name: "new-skill", description: description.slice(0, 120), instructions: text.trim() };
}

export class SkillGenerator {
  constructor(private readonly deps: SkillGeneratorDeps) {}

  async generate(
    tenant: string,
    subject: string | undefined,
    input: { description: string; model: string },
  ): Promise<GenerateSkillResult> {
    const spec = await this.deps.models.get(tenant, input.model); // unknown model → NotFound (404)
    const secretName = modelApiKeySecretName(spec);
    const scoped = await this.deps.scopedSecretsFor(tenant, subject);
    const apiKey = scoped.workspace[secretName] ?? scoped.user[secretName];
    if (apiKey === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { secretName, model: input.model },
        `No API key resolved for '${secretName}' — set it in workspace or personal secrets, then generate again.`,
      );
    const envBaseUrl = spec.provider === "anthropic" ? this.deps.anthropicBaseUrl : this.deps.openaiBaseUrl;
    const baseUrl = spec.baseUrl ?? envBaseUrl;
    const transport = transportFor({
      provider: spec.provider,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    const complete: JudgeCompletion = transportComplete(transport, {
      model: spec.model,
      maxTokens: GENERATE_MAX_TOKENS,
    });
    const prompt = `${SYSTEM_PROMPT}\n\nUser's description of the skill to create:\n${input.description}`;
    const text = await complete(prompt); // upstream/network failures are already remapped to UpstreamError
    return parseDraft(text, input.description);
  }
}
