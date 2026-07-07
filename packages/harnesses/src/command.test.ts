import type { CommandHarnessSpec, ComputeHandle, RunContext, TraceEvent } from "@assay/core";
import type { StartedUsageProxy, TraceSource } from "@assay/trace";
import { describe, expect, it } from "vitest";
import { CommandHarness } from "./command.js";

function fakeCompute() {
  const execs: Array<{ cmd: string; env?: Record<string, string>; cwd?: string }> = [];
  const compute: ComputeHandle = {
    async exec(cmd, opts) {
      execs.push({ cmd, env: opts?.env, cwd: opts?.cwd });
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
  params: {},
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

  it("기본 cwd 는 'work', spec.workDir 가 있으면 setup/command 둘 다 그 디렉터리에서 실행(os-use 는 절대경로)", async () => {
    const def = fakeCompute();
    await new CommandHarness(spec({ setup: ["s"] })).install(def.compute);
    await collect(new CommandHarness(spec()).run(def.compute, "t", ctx));
    expect(def.execs.every((e) => e.cwd === "work")).toBe(true);

    const wd = fakeCompute();
    await new CommandHarness(spec({ workDir: "/tmp", setup: ["s"] })).install(wd.compute);
    await collect(new CommandHarness(spec({ workDir: "/tmp" })).run(wd.compute, "t", ctx));
    expect(wd.execs.every((e) => e.cwd === "/tmp")).toBe(true); // setup(install) + command(run) 모두 /tmp
  });

  it("run 은 command 를 템플릿 치환(셸 안전)하고 env(ASSAY_RUN_ID + spec.env)를 주입; trace none + 출력 없음 → 이벤트 없음", async () => {
    const { compute, execs } = fakeCompute();
    const events = await collect(new CommandHarness(spec(), { runId: () => "rid1" }).run(compute, "fix the bug", ctx));
    expect(events).toEqual([]); // trace none + stdout 빈 값
    const e = execs[0];
    expect(e?.cmd).toContain("--model sonnet");
    expect(e?.cmd).toContain("--message 'fix the bug'"); // {{task}} 는 shq 처리
    expect(e?.env?.ASSAY_RUN_ID).toBe("rid1");
    expect(e?.env?.FOO).toBe("bar");
  });

  it("trace none 이면 stdout 이 최종 assistant message 가 된다(블랙박스 CLI 의 QA 채점 — answer-match 가 읽는 답)", async () => {
    // 회귀: 이전엔 trace:none 이 아무 이벤트도 내지 않아 prompt QA 벤치마크가 무조건 0점이었다(OfficeQA 류).
    const compute: ComputeHandle = {
      async exec() {
        return { exitCode: 0, stdout: "thinking...\nThe answer is 258.7 billion.\n", stderr: "" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    const events = await collect(new CommandHarness(spec()).run(compute, "debt?", ctx));
    expect(events).toEqual([
      { t: expect.any(Number), kind: "message", role: "assistant", text: "thinking...\nThe answer is 258.7 billion." },
    ]);
  });

  it("command 가 exit≠0 이면 error 이벤트로 가시화한다(조용한 삼킴 금지)", async () => {
    const compute: ComputeHandle = {
      async exec() {
        return { exitCode: 127, stdout: "", stderr: "sh: codex: command not found" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    const events = await collect(new CommandHarness(spec()).run(compute, "t", ctx));
    expect(events).toEqual([
      { t: expect.any(Number), kind: "error", message: "command exit 127: sh: codex: command not found" },
    ]);
  });

  it("trace 가 있으면 run() 은 stdout message 를 내지 않고(그쪽 트레이스가 답), 플랫폼 이벤트는 collectTrace 로 온다", async () => {
    const sourceEvents: TraceEvent[] = [{ t: 1, kind: "message", role: "assistant", text: "from-otel" }];
    const source: TraceSource = { fetch: async () => sourceEvents };
    const compute: ComputeHandle = {
      async exec() {
        return { exitCode: 0, stdout: "raw stdout noise", stderr: "" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    const h = new CommandHarness(
      spec({ trace: { kind: "otel", endpoint: "http://j", collect: "job", correlate: "id" } }),
      {
        traceSourceFor: () => source,
      },
    );
    const events = await collect(h.run(compute, "t", ctx));
    expect(events).toEqual([]); // stdout message 없음 + run() 은 플랫폼 pull 안 함(수집은 compute 해제 후)
    expect(await h.collectTrace("rid")).toEqual(sourceEvents);
  });

  it("일반 {{var}} 는 spec.params 로 치환되고 예약어({{model}})는 params 가 덮지 못한다", async () => {
    const { compute, execs } = fakeCompute();
    const h = new CommandHarness(
      spec({
        command: "aider --model {{model}} --edit-format {{edit_format}} --map-tokens {{map_tokens}} .",
        params: { edit_format: "diff", map_tokens: "2048", model: "ignored" },
      }),
      { runId: () => "rid1" },
    );
    await collect(h.run(compute, "t", ctx));
    const cmd = execs[0]?.cmd ?? "";
    expect(cmd).toContain("--edit-format diff");
    expect(cmd).toContain("--map-tokens 2048");
    expect(cmd).toContain("--model sonnet"); // 예약어가 먼저 치환됨 → params.model 무시
  });

  it("trace otel → collectTrace(runId) 가 주입된 소스에서 이벤트를 가져온다(run 과 같은 상관 키)", async () => {
    const { compute, execs } = fakeCompute();
    let fetched = "";
    const traceSourceFor = (kind: string, endpoint: string): TraceSource => ({
      async fetch(id: string) {
        fetched = `${kind}:${endpoint}:${id}`;
        return [{ t: 0, kind: "tool_call", id: "x", name: "n", args: {} }];
      },
    });
    const h = new CommandHarness(
      spec({ trace: { kind: "otel", endpoint: "http://j", collect: "job", correlate: "id" } }),
      {
        runId: () => "rid2",
        traceSourceFor,
      },
    );
    await collect(h.run(compute, "t", ctx));
    expect(execs[0]?.env?.ASSAY_RUN_ID).toBe("rid2"); // 실행에 주입된 상관 키
    const events = await h.collectTrace("rid2"); // 같은 키로 pull(runCase 가 compute 해제 후 호출)
    expect(fetched).toBe("otel:http://j:rid2");
    expect(events).toHaveLength(1);
  });

  it("ctx.runId 가 오면 자체 mint 대신 그 값으로 상관하고, traceSource() 가 스펙 좌표(collect 포함)를 노출한다", async () => {
    const { compute, execs } = fakeCompute();
    const h = new CommandHarness(
      spec({
        trace: {
          kind: "mlflow",
          endpoint: "http://m",
          collect: "control-plane",
          correlate: "tag",
          experiment: "7",
          authSecret: "MLFLOW_AUTH",
        },
      }),
      { runId: () => "self-minted" },
    );
    await collect(h.run(compute, "t", { ...ctx, runId: "from-runcase" }));
    expect(execs[0]?.env?.ASSAY_RUN_ID).toBe("from-runcase"); // runCase 상관 키 우선
    // authSecret 은 '이름'만(값 trace.auth 는 노출 금지), mlflow 는 correlate/experiment 도 좌표에 포함.
    expect(h.traceSource()).toEqual({
      kind: "mlflow",
      endpoint: "http://m",
      collect: "control-plane",
      correlate: "tag",
      experiment: "7",
      authSecret: "MLFLOW_AUTH",
    });
    expect(new CommandHarness(spec()).traceSource()).toBeUndefined(); // trace:none
  });

  it("collectTrace: 해석된 auth(값)·correlate·검색범위(project)를 소스에 전달하고, 0건이면 재시도한다(플러시 지연)", async () => {
    let seenOpts: { auth?: string; correlate?: "id" | "tag"; project?: string } | undefined;
    let fetches = 0;
    const traceSourceFor = (
      _k: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix",
      _e: string,
      opts?: { auth?: string; correlate?: "id" | "tag"; project?: string },
    ): TraceSource => {
      seenOpts = opts;
      return {
        async fetch() {
          fetches += 1;
          // 두 번은 플러시 전(0건), 세 번째에 도착 — 재시도가 없으면 빈 트레이스로 끝난다.
          return fetches < 3 ? [] : [{ t: 0, kind: "llm_call", model: "m" }];
        },
      };
    };
    const slept: number[] = [];
    const h = new CommandHarness(
      spec({
        trace: {
          kind: "mlflow",
          endpoint: "http://m",
          collect: "job",
          correlate: "tag",
          experiment: "7",
          auth: "Basic abc", // resolveHarnessSecrets 가 디스패치 직전 채운 transient 값
        },
      }),
      { traceSourceFor, sleep: async (ms) => void slept.push(ms) },
    );

    const events = await h.collectTrace("rid");

    expect(seenOpts).toEqual({ auth: "Basic abc", correlate: "tag", project: "7" }); // experiment→project 수렴
    expect(fetches).toBe(3); // 0건 → 재시도 → 도착
    expect(slept).toEqual([2000, 2000]);
    expect(events).toHaveLength(1);
  });

  it("trace kind 5종: phoenix 는 project 를 좌표·소스 설정에 싣고, langfuse/langsmith 도 동일 계약으로 동작한다", async () => {
    const seen: Array<{ kind: string; project?: string; auth?: string }> = [];
    const sourceFor = (kind: string) => (opts?: { auth?: string; project?: string }) => {
      seen.push({
        kind,
        ...(opts?.project ? { project: opts.project } : {}),
        ...(opts?.auth ? { auth: opts.auth } : {}),
      });
      return {
        async fetch(): Promise<TraceEvent[]> {
          return [{ t: 0, kind: "llm_call", model: "m" }];
        },
      };
    };
    const phoenix = new CommandHarness(
      spec({
        trace: { kind: "phoenix", endpoint: "http://p", project: "assay-e2e", collect: "job", auth: "Bearer k" },
      }),
      { traceSourceFor: (k, _e, o) => sourceFor(k)(o) },
    );
    expect(await phoenix.collectTrace("tid")).toHaveLength(1);
    // traceSource() 좌표에도 project 동봉 — control-plane 수집(traceRef)이 그대로 쓴다.
    expect(phoenix.traceSource()).toMatchObject({ kind: "phoenix", project: "assay-e2e", collect: "job" });

    const langsmith = new CommandHarness(
      spec({ trace: { kind: "langsmith", endpoint: "http://ls", collect: "job", auth: "lsv2_key" } }),
      { traceSourceFor: (k, _e, o) => sourceFor(k)(o) },
    );
    expect(await langsmith.collectTrace("uuid")).toHaveLength(1);
    expect(langsmith.traceSource()).toMatchObject({ kind: "langsmith", collect: "job" });

    expect(seen).toEqual([
      { kind: "phoenix", project: "assay-e2e", auth: "Bearer k" },
      { kind: "langsmith", auth: "lsv2_key" },
    ]);
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
      spec({
        trace: { kind: "otel", endpoint: "http://j", collect: "job", correlate: "id" },
        env: { OPENAI_API_BASE: "http://litellm:4000" },
      }),
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
