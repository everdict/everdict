import { describe, expect, it } from "vitest";
import { modelJudge, openaiComplete } from "./model-judge.js";

// 라이브 E2E — OpenAI-호환 엔드포인트(LiteLLM 등)로 실제 모델을 호출해 judge 전 경로(전송→파싱)를 검증한다.
// 실 인프라가 필요하므로 env 미설정이면 skip(CI 안전). 로컬에서:
//   ASSAY_E2E_OPENAI_BASE_URL=http://localhost:4000/v1 \
//   ASSAY_E2E_OPENAI_KEY=sk-... ASSAY_E2E_OPENAI_MODEL=chatgpt/gpt-5.4-mini \
//   pnpm --filter @assay/graders test model-judge.scenario
const BASE = process.env.ASSAY_E2E_OPENAI_BASE_URL;
const KEY = process.env.ASSAY_E2E_OPENAI_KEY;
const MODEL = process.env.ASSAY_E2E_OPENAI_MODEL;

describe.skipIf(!BASE || !KEY || !MODEL)("model judge — live OpenAI-compatible (LiteLLM)", () => {
  if (!BASE || !KEY || !MODEL) return; // 타입 내로잉(skipIf 와 별개)
  const judge = modelJudge(openaiComplete({ apiKey: KEY, model: MODEL, baseUrl: BASE, maxTokens: 200 }));
  const task = "Create a file ok.txt containing 'done'.";
  const rubric = "PASS only if ok.txt is created with the exact content 'done'.";

  // 라이브 모델은 비결정적이라 한 테스트에서 good/bad 를 모두 판정하고 의미(pass)+분리(score)로 단언한다.
  it("달성 트레이스는 pass, 미달성 트레이스는 fail, 그리고 점수가 분리된다", async () => {
    const good = await judge.judge({
      task,
      rubric,
      trace: [
        { t: 0, kind: "tool_call", id: "1", name: "bash", args: { cmd: "echo done > ok.txt" } },
        { t: 1, kind: "tool_result", id: "1", ok: true, output: "" },
        { t: 2, kind: "message", role: "assistant", text: "Created ok.txt with 'done'." },
      ],
    });
    const bad = await judge.judge({
      task,
      rubric,
      trace: [{ t: 0, kind: "message", role: "assistant", text: "I am not sure how to do that." }],
    });
    expect(good.pass).toBe(true);
    expect(bad.pass).toBe(false);
    expect(good.score).toBeGreaterThan(bad.score); // 분리(절대 임계보다 견고)
    expect(typeof good.reason).toBe("string");
  });
});
