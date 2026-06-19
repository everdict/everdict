import type { CommandHarnessSpec, ComputeHandle, RunContext, TraceEvent } from "@assay/core";
import type { StartedUsageProxy, TraceSource } from "@assay/trace";
import { describe, expect, it } from "vitest";
import { CommandHarness } from "./command.js";

function fakeCompute() {
  const execs: Array<{ cmd: string; env?: Record<string, string> }> = [];
  const compute: ComputeHandle = {
    async exec(cmd, opts) {
      execs.push({ cmd, env: opts?.env });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { compute, execs };
}
const ctx: RunContext = { apiKeyEnv: {}, timeoutSec: 60 };

const spec = (over: Partial<CommandHarnessSpec> = {}): CommandHarnessSpec => ({
  kind: "command",
  id: "aider",
  version: "0.74.0",
  setup: ["pip install aider-chat"],
  command: "aider --message {{task}} --model {{model}} .",
  env: { FOO: "bar" },
  model: "sonnet",
  trace: { kind: "none" },
  ...over,
});

async function collect(it: AsyncIterable<TraceEvent>): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("CommandHarness", () => {
  it("install 은 setup 명령을 순서대로 실행한다", async () => {
    const { compute, execs } = fakeCompute();
    await new CommandHarness(spec({ setup: ["a", "b"] })).install(compute);
    expect(execs.map((e) => e.cmd)).toEqual(["a", "b"]);
  });

  it("run 은 command 를 템플릿 치환(셸 안전)하고 env(ASSAY_RUN_ID + spec.env)를 주입; trace none → 이벤트 없음", async () => {
    const { compute, execs } = fakeCompute();
    const events = await collect(new CommandHarness(spec(), { runId: () => "rid1" }).run(compute, "fix the bug", ctx));
    expect(events).toEqual([]); // trace none
    const e = execs[0];
    expect(e?.cmd).toContain("--model sonnet");
    expect(e?.cmd).toContain("--message 'fix the bug'"); // {{task}} 는 shq 처리
    expect(e?.env?.ASSAY_RUN_ID).toBe("rid1");
    expect(e?.env?.FOO).toBe("bar");
  });

  it("trace otel → 주입된 소스에서 runId 로 이벤트를 가져온다", async () => {
    const { compute } = fakeCompute();
    let fetched = "";
    const traceSourceFor = (kind: "otel" | "mlflow", endpoint: string): TraceSource => ({
      async fetch(id: string) {
        fetched = `${kind}:${endpoint}:${id}`;
        return [{ t: 0, kind: "tool_call", id: "x", name: "n", args: {} }];
      },
    });
    const h = new CommandHarness(spec({ trace: { kind: "otel", endpoint: "http://j" } }), {
      runId: () => "rid2",
      traceSourceFor,
    });
    const events = await collect(h.run(compute, "t", ctx));
    expect(fetched).toBe("otel:http://j:rid2");
    expect(events).toHaveLength(1);
  });

  // 사용량 계측: trace:none 하니스의 모델 호출을 usage-proxy 로 통과시켜 토큰을 합성 llm_call 로 회수.
  function fakeMeter(usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, usd: 0.012, calls: 1 }) {
    const calls: { upstream: string; closed: boolean } = { upstream: "", closed: false };
    const start = async (opts: { upstreamBaseUrl: string; defaultRunId?: string }): Promise<StartedUsageProxy> => {
      calls.upstream = opts.upstreamBaseUrl;
      return {
        url: "http://127.0.0.1:9999",
        tally: { record() {}, get: () => ({ ...usage }), snapshot: () => ({}) },
        close: async () => {
          calls.closed = true;
        },
      };
    };
    return { start, calls };
  }

  it("meterUsage: 베이스를 프록시로 바꾸고, 회수 토큰을 합성 llm_call 로 내보내고, 프록시를 닫는다", async () => {
    const { compute, execs } = fakeCompute();
    const { start, calls } = fakeMeter();
    const h = new CommandHarness(spec({ env: { OPENAI_API_BASE: "http://litellm:4000" } }), {
      runId: () => "rid",
      meterUsage: true,
      startUsageProxy: start,
    });
    const events = await collect(h.run(compute, "t", ctx));
    expect(calls.upstream).toBe("http://litellm:4000"); // 원래 베이스가 업스트림
    expect(execs[0]?.env?.OPENAI_API_BASE).toBe("http://127.0.0.1:9999"); // 자식은 프록시로
    expect(events).toEqual([
      {
        t: expect.any(Number),
        kind: "llm_call",
        model: "sonnet",
        cost: { inputTokens: 100, outputTokens: 20, usd: 0.012 }, // $도 헤더에서 회수
      },
    ]);
    expect(calls.closed).toBe(true);
  });

  it("meterUsage 라도 trace 가 none 이 아니면 계측 안 함(자기 트레이스 사용 — 이중집계 방지)", async () => {
    const { compute, execs } = fakeCompute();
    const { start, calls } = fakeMeter();
    const h = new CommandHarness(
      spec({ trace: { kind: "otel", endpoint: "http://j" }, env: { OPENAI_API_BASE: "http://litellm:4000" } }),
      {
        runId: () => "rid",
        meterUsage: true,
        startUsageProxy: start,
        traceSourceFor: () => ({
          async fetch() {
            return [];
          },
        }),
      },
    );
    await collect(h.run(compute, "t", ctx));
    expect(calls.upstream).toBe(""); // 프록시 미시작
    expect(execs[0]?.env?.OPENAI_API_BASE).toBe("http://litellm:4000"); // 베이스 그대로
  });

  it("setup 실패(exit≠0)는 에러", async () => {
    const compute: ComputeHandle = {
      async exec() {
        return { exitCode: 1, stdout: "", stderr: "boom" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    await expect(new CommandHarness(spec()).install(compute)).rejects.toThrow(/setup 실패/);
  });
});
