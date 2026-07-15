import type {
  AgentJob,
  CaseResult,
  CommandHarnessSpec,
  ModelBinding,
  ServiceHarnessSpec,
  TopologyService,
} from "@everdict/contracts";
import { InMemoryModelRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import type { ScopedSecretTiers } from "./judge-auth-dispatcher.js";
import { ModelResolvingDispatcher, resolveJobModel } from "./model-resolving-dispatcher.js";

function commandSpec(model?: ModelBinding, env: CommandHarnessSpec["env"] = {}): CommandHarnessSpec {
  return {
    kind: "command",
    id: "aider",
    version: "1.0.0",
    setup: [],
    command: "aider --model {{model}} --message {{task}}",
    env,
    params: {},
    trace: { kind: "none" },
    ...(model !== undefined ? { model } : {}),
  };
}

function svc(name: string, extra: Partial<TopologyService> = {}): TopologyService {
  return { name, image: `${name}:latest`, needs: [], perRun: [], replicas: 1, env: {}, ...extra };
}

function serviceSpec(services: TopologyService[]): ServiceHarnessSpec {
  return {
    kind: "service",
    id: "svc",
    version: "1.0.0",
    services,
    dependencies: [],
    frontDoor: { service: "agent", submit: "POST /run" },
    traceSource: { kind: "otel", endpoint: "http://otel" },
  };
}

// A fake scoped-secrets resolver (the two tiers the control plane can read). workspace tier first, personal as fallback.
const secretsFor =
  (workspace: Record<string, string>, user: Record<string, string> = {}) =>
  async (): Promise<ScopedSecretTiers> => ({ workspace, user });

function job(harnessSpec: AgentJob["harnessSpec"], tenant = "acme"): AgentJob {
  return {
    evalCase: {
      id: "c1",
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 1,
      tags: [],
    },
    harness: { id: "aider", version: "1.0.0" },
    tenant,
    ...(harnessSpec ? { harnessSpec } : {}),
  };
}

async function registry(): Promise<InMemoryModelRegistry> {
  const models = new InMemoryModelRegistry();
  // "opus" → underlying "claude-opus-4-8"; no baseUrl, no apiKeySecret (provider-default key).
  await models.register("acme", {
    id: "opus",
    version: "1.0.0",
    provider: "anthropic",
    model: "claude-opus-4-8",
    tags: [],
  });
  // "litellm-mini" → an OpenAI-compatible proxy model with a linked secret name and a proxy baseUrl.
  await models.register("acme", {
    id: "litellm-mini",
    version: "1.0.0",
    provider: "openai",
    model: "gpt-5.4-mini",
    baseUrl: "https://litellm.internal/v1",
    apiKeySecret: "MY_LITELLM_KEY",
    tags: [],
  });
  return models;
}

describe("resolveJobModel", () => {
  it("resolves command.model to the underlying model identifier when it's a registered Model id", async () => {
    const models = await registry();
    const resolved = await resolveJobModel(models, job(commandSpec("opus")));
    expect((resolved.harnessSpec as CommandHarnessSpec).model).toBe("claude-opus-4-8");
  });

  it("leaves the raw model string as-is when it's not a registered id (fallback)", async () => {
    const models = await registry();
    const resolved = await resolveJobModel(models, job(commandSpec("gpt-5.4-mini")));
    expect((resolved.harnessSpec as CommandHarnessSpec).model).toBe("gpt-5.4-mini");
  });

  it("doesn't resolve another workspace's model id (tenant scope)", async () => {
    const models = await registry(); // "opus" is owned by acme
    const resolved = await resolveJobModel(models, job(commandSpec("opus"), "beta"));
    expect((resolved.harnessSpec as CommandHarnessSpec).model).toBe("opus");
  });

  it("returns the job unchanged if it's not a command harness or model is unset", async () => {
    const models = await registry();
    const noModel = job(commandSpec(undefined));
    expect(await resolveJobModel(models, noModel)).toBe(noModel);
    const noSpec = job(undefined);
    expect(await resolveJobModel(models, noSpec)).toBe(noSpec);
  });
});

describe("resolveJobModel — connection env injection", () => {
  it("injects a command harness's model connection (baseUrl + key + model) from the linked secret", async () => {
    const models = await registry();
    const resolved = await resolveJobModel(
      models,
      job(commandSpec("litellm-mini")),
      secretsFor({ MY_LITELLM_KEY: "sk-live" }),
    );
    const spec = resolved.harnessSpec as CommandHarnessSpec;
    expect(spec.model).toBe("gpt-5.4-mini"); // {{model}} slot still resolves to the underlying identifier
    expect(spec.env).toEqual({
      OPENAI_MODEL: "gpt-5.4-mini",
      OPENAI_BASE_URL: "https://litellm.internal/v1",
      OPENAI_API_KEY: "sk-live",
    });
  });

  it("falls back to the submitter's personal secret when the workspace tier lacks the key", async () => {
    const models = await registry();
    const resolved = await resolveJobModel(
      models,
      job(commandSpec("litellm-mini")),
      secretsFor({}, { MY_LITELLM_KEY: "sk-personal" }),
    );
    expect((resolved.harnessSpec as CommandHarnessSpec).env.OPENAI_API_KEY).toBe("sk-personal");
  });

  it("throws a fail-fast 400 when the model's named apiKeySecret is set in no tier", async () => {
    const models = await registry();
    await expect(resolveJobModel(models, job(commandSpec("litellm-mini")), secretsFor({}))).rejects.toThrow(
      /MY_LITELLM_KEY/,
    );
  });

  it("throws when an explicit ModelRef object references an unregistered model", async () => {
    const models = await registry();
    await expect(resolveJobModel(models, job(commandSpec({ ref: "ghost" })), secretsFor({}))).rejects.toThrow(
      /no such model/,
    );
  });

  it("runs without a key when the model relies on the provider default and it isn't set (own-pays)", async () => {
    const models = await registry();
    const resolved = await resolveJobModel(models, job(commandSpec("opus")), secretsFor({}));
    const spec = resolved.harnessSpec as CommandHarnessSpec;
    expect(spec.model).toBe("claude-opus-4-8");
    expect(spec.env).toEqual({ ANTHROPIC_MODEL: "claude-opus-4-8" }); // no baseUrl, no key
  });

  it("injects into the service that carries the model binding, not its peers, preserving static env", async () => {
    const models = await registry();
    const spec = serviceSpec([svc("db"), svc("agent", { model: "litellm-mini", env: { LOG_LEVEL: "info" } })]);
    const resolved = await resolveJobModel(models, job(spec), secretsFor({ MY_LITELLM_KEY: "sk-live" }));
    const services = (resolved.harnessSpec as ServiceHarnessSpec).services;
    expect(services.find((s) => s.name === "db")?.env).toEqual({});
    expect(services.find((s) => s.name === "agent")?.env).toEqual({
      LOG_LEVEL: "info",
      OPENAI_MODEL: "gpt-5.4-mini",
      OPENAI_BASE_URL: "https://litellm.internal/v1",
      OPENAI_API_KEY: "sk-live",
    });
  });

  it("honors a per-binding env-name override (a server that reads non-standard vars)", async () => {
    const models = await registry();
    const spec = serviceSpec([
      svc("agent", {
        model: { ref: "litellm-mini", env: { apiKey: "LLM_KEY", baseUrl: "LLM_URL", model: "LLM_MODEL" } },
      }),
    ]);
    const resolved = await resolveJobModel(models, job(spec), secretsFor({ MY_LITELLM_KEY: "sk-live" }));
    expect((resolved.harnessSpec as ServiceHarnessSpec).services[0].env).toEqual({
      LLM_MODEL: "gpt-5.4-mini",
      LLM_URL: "https://litellm.internal/v1",
      LLM_KEY: "sk-live",
    });
  });

  it("leaves a service untouched without a secret resolver (provenance-only path)", async () => {
    const models = await registry();
    const spec = serviceSpec([svc("agent", { model: "litellm-mini" })]);
    const j = job(spec);
    expect(await resolveJobModel(models, j)).toBe(j); // no secretsFor → nothing to inject on a service
  });
});

describe("ModelResolvingDispatcher", () => {
  it("delegates to the inner dispatcher with the resolved model", async () => {
    const models = await registry();
    let seen: AgentJob | undefined;
    const result = {
      caseId: "c1",
      harness: "aider@1.0.0",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    } satisfies CaseResult;
    const inner = {
      async dispatch(j: AgentJob): Promise<CaseResult> {
        seen = j;
        return result;
      },
    };
    const dispatcher = new ModelResolvingDispatcher(models, inner);

    expect(await dispatcher.dispatch(job(commandSpec("opus")))).toBe(result);
    expect((seen?.harnessSpec as CommandHarnessSpec).model).toBe("claude-opus-4-8");
  });
});
