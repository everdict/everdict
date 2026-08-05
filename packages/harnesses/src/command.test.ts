import {
  type CommandHarnessSpec,
  type ComputeHandle,
  type RunContext,
  type TraceEvent,
  traceIdForRun,
} from "@everdict/contracts";
import type { StartedUsageProxy, TraceSource } from "@everdict/trace";
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

// Everdict's OWN record of the invocation — emitted for every run whatever the harness reports about itself,
// so an agent whose trace lives on someone else's platform still leaves us evidence that we ran it.
const commandExit = (exitCode: number) => ({
  t: expect.any(Number),
  at: expect.any(String),
  kind: "env_action",
  action: "command.exit",
  detail: expect.objectContaining({ exitCode }),
});

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
  // One run is one trace only if the parent's identity crosses the process boundary. `everdict.run_id`
  // correlates; `traceparent` PARENTS — the difference between "these spans mention the same run" and "these
  // spans are part of it" (otel-trace-model.md).
  it("propagates W3C trace context so an instrumented agent's spans join the run's trace", async () => {
    const { compute, execs } = fakeCompute();
    const ctx: RunContext = { apiKeyEnv: {}, timeoutSec: 60, runId: "run-abc" };
    await collect(new CommandHarness(spec()).run(compute, "t", ctx));
    const header = execs[0]?.env?.TRACEPARENT;
    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    // The trace id is DERIVED from the run id, so the control plane and the agent agree without coordinating.
    expect(header?.split("-")[1]).toBe(traceIdForRun("run-abc"));
  });

  it("install runs the setup commands in order", async () => {
    const { compute, execs } = fakeCompute();
    await new CommandHarness(spec({ setup: ["a", "b"] })).install(compute);
    expect(execs.map((e) => e.cmd)).toEqual(["a", "b"]);
  });

  it("default cwd is 'work'; when spec.workDir is set, both setup and command run in that directory (os-use uses an absolute path)", async () => {
    const def = fakeCompute();
    await new CommandHarness(spec({ setup: ["s"] })).install(def.compute);
    await collect(new CommandHarness(spec()).run(def.compute, "t", ctx));
    expect(def.execs.every((e) => e.cwd === "work")).toBe(true);

    const wd = fakeCompute();
    await new CommandHarness(spec({ workDir: "/tmp", setup: ["s"] })).install(wd.compute);
    await collect(new CommandHarness(spec({ workDir: "/tmp" })).run(wd.compute, "t", ctx));
    expect(wd.execs.every((e) => e.cwd === "/tmp")).toBe(true); // both setup(install) + command(run) run in /tmp
  });

  it("run substitutes the command template (shell-safe) and injects env (EVERDICT_RUN_ID + spec.env); a silent command still records the invocation", async () => {
    const { compute, execs } = fakeCompute();
    const events = await collect(new CommandHarness(spec(), { runId: () => "rid1" }).run(compute, "fix the bug", ctx));
    // A command that says nothing is not a run that did nothing — what we invoked and how it ended is ours to record.
    expect(events).toEqual([commandExit(0)]);
    const e = execs[0];
    expect(e?.cmd).toContain("--model sonnet");
    expect(e?.cmd).toContain("--message 'fix the bug'"); // {{task}} is shq-quoted
    expect(e?.env?.EVERDICT_RUN_ID).toBe("rid1");
    expect(e?.env?.FOO).toBe("bar");
  });

  it("with trace none, stdout becomes the final assistant message (QA scoring for a black-box CLI — the answer answer-match reads)", async () => {
    // Regression: previously trace:none emitted no events, so prompt QA benchmarks always scored 0 (OfficeQA-style).
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
      commandExit(0),
      {
        t: expect.any(Number),
        at: expect.any(String),
        kind: "message",
        role: "assistant",
        text: "thinking...\nThe answer is 258.7 billion.",
      },
    ]);
  });

  it("when the command exits ≠0, surface it as an error event (no silent swallowing)", async () => {
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
      commandExit(127),
      {
        t: expect.any(Number),
        at: expect.any(String),
        kind: "error",
        message: "command exit 127: sh: codex: command not found",
      },
      // trace:none evidence fallback — the stderr tail also lands as a log event (full context next to the reason)
      {
        t: expect.any(Number),
        at: expect.any(String),
        kind: "log",
        stream: "stderr",
        text: "sh: codex: command not found",
      },
    ]);
  });

  it("when a trace exists, stdout stays a LOG rather than becoming the answer — but our own record is still kept; platform events come via collectTrace", async () => {
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
    // The platform's trace is the answer, so stdout must NOT be promoted to an assistant message (that would
    // fork what a judge reads) — but the bytes we saw are ours to keep, and run() still doesn't pull the
    // platform here (collection happens after compute is released).
    expect(events).toEqual([
      commandExit(0),
      { t: expect.any(Number), at: expect.any(String), kind: "log", stream: "stdout", text: "raw stdout noise" },
    ]);
    expect(await h.collectTrace("rid")).toEqual(sourceEvents);
  });

  it("ordinary {{var}} are substituted from spec.params, and params can't override reserved words ({{model}})", async () => {
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
    expect(cmd).toContain("--model sonnet"); // reserved word is substituted first → params.model ignored
  });

  it("trace otel → collectTrace(runId) fetches events from the injected source (same correlation key as run)", async () => {
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
    expect(execs[0]?.env?.EVERDICT_RUN_ID).toBe("rid2"); // correlation key injected into execution
    const events = await h.collectTrace("rid2"); // pull with the same key (runCase calls this after releasing compute)
    expect(fetched).toBe("otel:http://j:rid2");
    expect(events).toHaveLength(1);
  });

  it("when ctx.runId is provided, correlate on that value instead of self-minting, and traceSource() exposes the spec coordinates (incl. collect)", async () => {
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
          mapping: { model: ["my.model"], inputTokens: ["my.tok.in"] },
        },
      }),
      { runId: () => "self-minted" },
    );
    await collect(h.run(compute, "t", { ...ctx, runId: "from-runcase" }));
    expect(execs[0]?.env?.EVERDICT_RUN_ID).toBe("from-runcase"); // runCase correlation key takes precedence
    // authSecret exposes only the 'name' (the value trace.auth must not leak); for mlflow, correlate/experiment are also in the coordinates.
    // A per-harness span-attribute mapping (non-GenAI-convention instrumentation) is carried through to the trace source.
    expect(h.traceSource()).toEqual({
      kind: "mlflow",
      endpoint: "http://m",
      collect: "control-plane",
      correlate: "tag",
      experiment: "7",
      authSecret: "MLFLOW_AUTH",
      mapping: { model: ["my.model"], inputTokens: ["my.tok.in"] },
    });
    expect(new CommandHarness(spec()).traceSource()).toBeUndefined(); // trace:none
  });

  it("collectTrace: passes the resolved auth (value), correlate, and search scope (project) to the source, and retries on 0 results (flush delay)", async () => {
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
          // Twice before the flush (0 results), arrives on the third — without retry it would end with an empty trace.
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
          auth: "Basic abc", // transient value filled in by resolveHarnessSecrets just before dispatch
        },
      }),
      { traceSourceFor, sleep: async (ms) => void slept.push(ms) },
    );

    const events = await h.collectTrace("rid");

    expect(seenOpts).toEqual({ auth: "Basic abc", correlate: "tag", project: "7" }); // experiment→project convergence
    expect(fetches).toBe(3); // 0 results → retry → arrives
    expect(slept).toEqual([2000, 2000]);
    expect(events).toHaveLength(1);
  });

  it("5 trace kinds: phoenix carries project into the coordinates and source config, and langfuse/langsmith behave under the same contract", async () => {
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
        trace: { kind: "phoenix", endpoint: "http://p", project: "everdict-e2e", collect: "job", auth: "Bearer k" },
      }),
      { traceSourceFor: (k, _e, o) => sourceFor(k)(o) },
    );
    expect(await phoenix.collectTrace("tid")).toHaveLength(1);
    // traceSource() coordinates also carry project — control-plane collection (traceRef) uses it verbatim.
    expect(phoenix.traceSource()).toMatchObject({ kind: "phoenix", project: "everdict-e2e", collect: "job" });

    const langsmith = new CommandHarness(
      spec({ trace: { kind: "langsmith", endpoint: "http://ls", collect: "job", auth: "lsv2_key" } }),
      { traceSourceFor: (k, _e, o) => sourceFor(k)(o) },
    );
    expect(await langsmith.collectTrace("uuid")).toHaveLength(1);
    expect(langsmith.traceSource()).toMatchObject({ kind: "langsmith", collect: "job" });

    expect(seen).toEqual([
      { kind: "phoenix", project: "everdict-e2e", auth: "Bearer k" },
      { kind: "langsmith", auth: "lsv2_key" },
    ]);
  });

  // Usage metering: route a trace:none harness's model calls through a usage-proxy to recover tokens as a synthetic llm_call.
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

  it("meterUsage: swaps the base to the proxy, emits recovered tokens as a synthetic llm_call, and closes the proxy", async () => {
    const { compute, execs } = fakeCompute();
    const { start, calls } = fakeMeter();
    const h = new CommandHarness(spec({ env: { OPENAI_API_BASE: "http://litellm:4000" } }), {
      runId: () => "rid",
      meterUsage: true,
      startUsageProxy: start,
    });
    const events = await collect(h.run(compute, "t", ctx));
    expect(calls.upstream).toBe("http://litellm:4000"); // the original base is the upstream
    expect(execs[0]?.env?.OPENAI_API_BASE).toBe("http://127.0.0.1:9999"); // the child goes to the proxy
    expect(events).toEqual([
      commandExit(0),
      {
        t: expect.any(Number),
        at: expect.any(String),
        kind: "llm_call",
        model: "sonnet",
        cost: { inputTokens: 100, outputTokens: 20, usd: 0.012 }, // $ recovered from the header too
      },
    ]);
    expect(calls.closed).toBe(true);
  });

  it("even with meterUsage, don't meter when trace isn't none (use its own trace — avoid double-counting)", async () => {
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
    expect(calls.upstream).toBe(""); // proxy not started
    expect(execs[0]?.env?.OPENAI_API_BASE).toBe("http://litellm:4000"); // base unchanged
  });

  it("a setup failure (exit≠0) is an error", async () => {
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
    await expect(new CommandHarness(spec()).install(compute)).rejects.toThrow(/setup failed/);
  });
});

describe("CommandHarness — trace:none evidence fallback (stderr log events)", () => {
  function computeWith(out: { stdout?: string; stderr?: string; exitCode?: number }) {
    const compute: ComputeHandle = {
      async exec() {
        return { exitCode: out.exitCode ?? 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    return compute;
  }

  it("a SUCCESSFUL run still persists the stderr tail as a log event (progress logs are evidence)", async () => {
    const compute = computeWith({ stdout: "final answer", stderr: "step 1/3 …\nstep 3/3 done" });
    const events = await collect(new CommandHarness(spec()).run(compute, "t", ctx));
    expect(events.find((e) => e.kind === "message")).toMatchObject({ role: "assistant", text: "final answer" });
    const log = events.find((e) => e.kind === "log");
    expect(log).toMatchObject({ stream: "stderr", text: "step 1/3 …\nstep 3/3 done" });
  });

  it("on exit≠0 both the error event AND the stderr log event are emitted (short reason + full-tail context)", async () => {
    const compute = computeWith({ exitCode: 2, stderr: "x".repeat(20_000) });
    const events = await collect(new CommandHarness(spec()).run(compute, "t", ctx));
    expect(events.some((e) => e.kind === "error")).toBe(true);
    const log = events.find((e) => e.kind === "log");
    expect(log?.kind === "log" && log.text.length).toBe(16_000); // tail-capped, larger than the error's 2k excerpt
  });

  it("a harness whose trace lives on a platform still leaves OUR evidence — as logs, never as the answer", async () => {
    // The invariant this replaces was "no double evidence", which delegated our own observation to a platform:
    // a dead endpoint or a mistyped correlation key then left the ledger with nothing at all for a run we
    // actually performed. A registered trace source ADDS the agent's account; it never substitutes for ours.
    // What must NOT double is the ANSWER — stdout stays a log here, so answer-match keeps reading the platform's.
    const compute = computeWith({ stdout: "ignored", stderr: "noise" });
    const h = new CommandHarness(
      spec({ trace: { kind: "otel", endpoint: "http://jaeger:16686", collect: "control-plane", correlate: "id" } }),
      { runId: () => "r-1" },
    );
    const events = await collect(h.run(compute, "t", ctx));
    expect(events.some((e) => e.kind === "message")).toBe(false);
    expect(events.filter((e) => e.kind === "log").map((e) => e.kind === "log" && e.stream)).toEqual([
      "stdout",
      "stderr",
    ]);
    expect(events.some((e) => e.kind === "env_action" && e.action === "command.exit")).toBe(true);
  });

  it("empty stderr emits no log event (no noise records)", async () => {
    const compute = computeWith({ stdout: "answer", stderr: "  " });
    const events = await collect(new CommandHarness(spec()).run(compute, "t", ctx));
    expect(events.some((e) => e.kind === "log")).toBe(false);
  });
});

// The self-reported plane (trace:file) — the seam that lets a CLI agent describe its own run instead of
// smuggling numbers out through stdout for a regex grader to recover.
function computeWithTraceFile(body: string | (() => never), stdout = "the answer") {
  const reads: string[] = [];
  const compute: ComputeHandle = {
    async exec() {
      return { exitCode: 0, stdout, stderr: "" };
    },
    async writeFile() {},
    async readFile(path): Promise<string> {
      reads.push(path);
      if (typeof body === "function") return body();
      return body;
    },
    async dispose() {},
  };
  return { compute, reads };
}

async function collectSelfReported(harness: CommandHarness, compute: ComputeHandle): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  for await (const e of harness.run(compute, "do it", ctx)) events.push(e);
  return events;
}

describe("CommandHarness — trace:file (the self-reported plane)", () => {
  const fileSpec = (path?: string): CommandHarnessSpec =>
    spec({ trace: path !== undefined ? { kind: "file", path } : { kind: "file", path: "everdict-trace.json" } });

  it("reads the events the command wrote and yields them as the run's trace", async () => {
    const events = [
      { t: 1, kind: "tool_call", id: "c1", name: "skill_view", args: { name: "amber-band" } },
      { t: 2, kind: "message", role: "assistant", text: "TMB-4412" },
    ];
    const { compute } = computeWithTraceFile(JSON.stringify(events));
    const out = await collectSelfReported(new CommandHarness(fileSpec()), compute);
    expect(out.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(out.filter((e) => e.kind === "message")).toHaveLength(1);
  });

  it("makes the ordinary steps grader work — tool_call events are real, not a regex over stdout", async () => {
    const events = [
      { t: 1, kind: "tool_call", id: "c1", name: "a" },
      { t: 2, kind: "tool_call", id: "c2", name: "b" },
      { t: 3, kind: "message", role: "assistant", text: "done" },
    ];
    const { compute } = computeWithTraceFile(JSON.stringify(events));
    const out = await collectSelfReported(new CommandHarness(fileSpec()), compute);
    expect(out.filter((e) => e.kind === "tool_call")).toHaveLength(2);
  });

  it("accepts JSONL so an agent can append a line per step without buffering the run", async () => {
    const body = [
      '{"t":1,"kind":"tool_call","id":"c1","name":"a"}',
      '{"t":2,"kind":"tool_call","id":"c2","name":"b"}',
    ].join("\n");
    const { compute } = computeWithTraceFile(body);
    const out = await collectSelfReported(new CommandHarness(fileSpec()), compute);
    expect(out.filter((e) => e.kind === "tool_call")).toHaveLength(2);
  });

  it("drops a malformed line instead of failing the case — a gap in evidence is not a lost result", async () => {
    const body = [
      '{"t":1,"kind":"tool_call","id":"c1","name":"a"}',
      "{ not json",
      '{"t":3,"kind":"tool_call","id":"c3","name":"c"}',
    ].join("\n");
    const { compute } = computeWithTraceFile(body);
    const out = await collectSelfReported(new CommandHarness(fileSpec()), compute);
    expect(out.filter((e) => e.kind === "tool_call")).toHaveLength(2);
  });

  it("falls back to stdout as the answer when the file carries no assistant message", async () => {
    const { compute } = computeWithTraceFile('[{"t":1,"kind":"tool_call","id":"c1","name":"a"}]', "the printed answer");
    const out = await collectSelfReported(new CommandHarness(fileSpec()), compute);
    const message = out.find((e) => e.kind === "message");
    expect(message).toMatchObject({ kind: "message", role: "assistant", text: "the printed answer" });
  });

  it("does not duplicate the answer when the agent reported one itself", async () => {
    const body = JSON.stringify([{ t: 1, kind: "message", role: "assistant", text: "reported" }]);
    const { compute } = computeWithTraceFile(body, "also printed");
    const out = await collectSelfReported(new CommandHarness(fileSpec()), compute);
    expect(out.filter((e) => e.kind === "message")).toHaveLength(1);
    expect(out.find((e) => e.kind === "message")).toMatchObject({ text: "reported" });
  });

  it("survives a missing file — the agent simply chose not to report", async () => {
    const { compute } = computeWithTraceFile(() => {
      throw new Error("no such file");
    }, "still answered");
    const out = await collectSelfReported(new CommandHarness(fileSpec()), compute);
    expect(out.find((e) => e.kind === "message")).toMatchObject({ text: "still answered" });
  });

  it("resolves a relative path under the harness workDir and leaves an absolute one alone", async () => {
    const rel = computeWithTraceFile("[]");
    await collectSelfReported(new CommandHarness(fileSpec("t.json")), rel.compute);
    expect(rel.reads[0]).toBe("work/t.json");
    const abs = computeWithTraceFile("[]");
    await collectSelfReported(new CommandHarness(fileSpec("/tmp/t.json")), abs.compute);
    expect(abs.reads[0]).toBe("/tmp/t.json");
  });

  it("never pulls from a platform — collectTrace stays empty because the sandbox is already gone", async () => {
    expect(await new CommandHarness(fileSpec()).collectTrace("run-1")).toEqual([]);
    expect(new CommandHarness(fileSpec()).traceSource()).toBeUndefined();
  });

  // The agent's own account passes through verbatim, TIME INCLUDED. An agent that numbers its steps has told
  // us their order and nothing about their duration; inventing an `at` for them would put fifteen steps inside
  // the first fifteen milliseconds of a twenty-three second run, which is a picture, not evidence. The events
  // the HARNESS itself mints alongside are stamped, because for those we do know when they happened.
  it("passes a self-reported step through with the time the agent gave it, inventing none", async () => {
    const clock = () => 1_700_000_000_000;
    const { compute } = computeWithTraceFile('[{"t":1,"kind":"tool_call","id":"c1","name":"a"}]', "printed");
    const out = await collectSelfReported(new CommandHarness(fileSpec(), { clock }), compute);

    const call = out.find((e) => e.kind === "tool_call");
    expect(call?.t).toBe(1);
    expect(call?.at).toBeUndefined(); // off the wall clock, and honestly so
    const answer = out.find((e) => e.kind === "message");
    expect(answer?.at).toBe(new Date(1_700_000_000_000).toISOString()); // ours, so stamped
  });
});
