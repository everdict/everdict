import { describe, expect, it } from "vitest";
import { modelJudge, openaiComplete } from "./model-judge.js";

// Live E2E — calls a real model through an OpenAI-compatible endpoint (e.g. LiteLLM) to verify the full judge path (transport→parse).
// Requires real infra, so skip if env is unset (CI-safe). Locally:
//   EVERDICT_E2E_OPENAI_BASE_URL=http://localhost:4000/v1 \
//   EVERDICT_E2E_OPENAI_KEY=sk-... EVERDICT_E2E_OPENAI_MODEL=chatgpt/gpt-5.4-mini \
//   pnpm --filter @everdict/graders test model-judge.scenario
const BASE = process.env.EVERDICT_E2E_OPENAI_BASE_URL;
const KEY = process.env.EVERDICT_E2E_OPENAI_KEY;
const MODEL = process.env.EVERDICT_E2E_OPENAI_MODEL;

describe.skipIf(!BASE || !KEY || !MODEL)("model judge — live OpenAI-compatible (LiteLLM)", () => {
  if (!BASE || !KEY || !MODEL) return; // type narrowing (separate from skipIf)
  const judge = modelJudge(openaiComplete({ apiKey: KEY, model: MODEL, baseUrl: BASE, maxTokens: 200 }));
  const task = "Create a file ok.txt containing 'done'.";
  const rubric = "PASS only if ok.txt is created with the exact content 'done'.";

  // Live models are non-deterministic, so judge both good/bad in one test and assert on meaning (pass) + separation (score).
  it("an achieving trace passes, a non-achieving trace fails, and the scores separate", async () => {
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
    expect(good.score).toBeGreaterThan(bad.score); // separation (more robust than an absolute threshold)
    expect(typeof good.reason).toBe("string");
  });
});
