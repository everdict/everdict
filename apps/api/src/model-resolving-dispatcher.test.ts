import type { AgentJob, CaseResult, CommandHarnessSpec } from "@assay/core";
import { InMemoryModelRegistry } from "@assay/registry";
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
  // 등록 model "opus" → 하부 모델 "claude-opus-4-8"
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
  it("command.model 이 등록된 Model id 면 하부 모델 식별자로 해석한다", async () => {
    const models = await registry();
    const resolved = await resolveJobModel(models, job(commandSpec("opus")));
    expect((resolved.harnessSpec as CommandHarnessSpec).model).toBe("claude-opus-4-8");
  });

  it("등록 id 가 아니면 raw 모델 문자열을 그대로 둔다(폴백)", async () => {
    const models = await registry();
    const resolved = await resolveJobModel(models, job(commandSpec("gpt-5.4-mini")));
    expect((resolved.harnessSpec as CommandHarnessSpec).model).toBe("gpt-5.4-mini");
  });

  it("다른 워크스페이스의 model id 는 해석하지 않는다(테넌트 스코프)", async () => {
    const models = await registry(); // "opus" 는 acme 소유
    const resolved = await resolveJobModel(models, job(commandSpec("opus"), "beta"));
    expect((resolved.harnessSpec as CommandHarnessSpec).model).toBe("opus");
  });

  it("command 하니스가 아니거나 model 미설정이면 잡을 그대로 돌려준다", async () => {
    const models = await registry();
    const noModel = job(commandSpec(undefined));
    expect(await resolveJobModel(models, noModel)).toBe(noModel);
    const noSpec = job(undefined);
    expect(await resolveJobModel(models, noSpec)).toBe(noSpec);
  });
});

describe("ModelResolvingDispatcher", () => {
  it("해석된 모델로 inner 디스패처에 위임한다", async () => {
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
