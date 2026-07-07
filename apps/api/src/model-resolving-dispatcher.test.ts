import type { AgentJob, CaseResult, CommandHarnessSpec } from "@everdict/core";
import { InMemoryModelRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { ModelResolvingDispatcher, resolveJobModel } from "./model-resolving-dispatcher.js";

function commandSpec(model?: string): CommandHarnessSpec {
  return {
    kind: "command",
    id: "aider",
    version: "1.0.0",
    setup: [],
    command: "aider --model {{model}} --message {{task}}",
    env: {},
    params: {},
    trace: { kind: "none" },
    ...(model !== undefined ? { model } : {}),
  };
}

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
  // registered model "opus" → underlying model "claude-opus-4-8"
  await models.register("acme", {
    id: "opus",
    version: "1.0.0",
    provider: "anthropic",
    model: "claude-opus-4-8",
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
