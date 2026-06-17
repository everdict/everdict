import { type ComputeHandle, type EvaluableHarness, type RunContext, type TraceEvent, shq } from "@assay/core";
import { mapClaudeStreamJson } from "./stream-json.js";

export interface ClaudeCodeOptions {
  install?: boolean; // true면 compute에 CLI를 npm 설치 (E2B 등). LocalDriver는 PATH의 claude 사용.
  workDir?: string;
}

// 실제 Claude Code 어댑터. compute(샌드박스) 안에서 `claude -p ... --output-format stream-json`을
// 구동하고 출력을 정규화 TraceEvent로 변환한다. 모델 호출은 LLM 프록시로 라우팅(비용 균일 수집).
export class ClaudeCodeHarness implements EvaluableHarness {
  readonly id = "claude-code";
  constructor(
    readonly version: string,
    private readonly opts: ClaudeCodeOptions = {},
  ) {}

  async install(compute: ComputeHandle): Promise<void> {
    if (this.opts.install) {
      await compute.exec(`npm i -g @anthropic-ai/claude-code@${this.version}`);
    }
  }

  async *run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent> {
    const env = { ...ctx.apiKeyEnv, ANTHROPIC_BASE_URL: ctx.llmProxyBaseUrl };
    const cwd = this.opts.workDir ?? "work";
    const cmd = `claude -p ${shq(task)} --output-format stream-json --verbose --dangerously-skip-permissions`;
    const res = await compute.exec(cmd, { cwd, env, timeoutSec: ctx.timeoutSec });

    let t = 0;
    const nextT = () => t++;
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const ev of mapClaudeStreamJson(obj, nextT)) yield ev;
    }
  }
}
