import type { ServiceHarnessSpec, TraceEvent, TraceSource } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { TargetEnvHandle, TopologyRuntime } from "../deploy/topology-runtime.js";
import { FrontDoorSession, type FrontDoorSessionOptions } from "./front-door-session.js";

// The conversation drive against fakes: what stays session-stable vs per-turn is the whole contract.

function spec(over: Partial<ServiceHarnessSpec> = {}): ServiceHarnessSpec {
  return {
    kind: "service",
    id: "aegra",
    version: "1.0.0",
    services: [{ name: "agent", image: "reg/aegra:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies: [{ store: "postgres", role: "checkpoints", purpose: "plumbing", isolateBy: "thread_id" }],
    frontDoor: { service: "agent", submit: "POST /runs" },
    traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
    ...over,
  };
}

function fakeRuntime(opts: { withBrowser?: boolean } = {}) {
  const ensures: string[] = [];
  const teardowns: string[] = [];
  const provisioned: string[] = [];
  const disposed: string[] = [];
  const runtime: TopologyRuntime = {
    id: "fake",
    async ensureTopology(s) {
      ensures.push(s.id);
      return { endpoints: { agent: "http://front-door:8000" } };
    },
    async provisionBrowserEnv(_s, runId) {
      provisioned.push(runId);
      const handle: TargetEnvHandle = {
        wiring: { target_cdp_url: "ws://browser:9222" },
        cdpBase: "http://127.0.0.1:9222",
        async snapshot() {
          return { kind: "browser", dom: "", url: "", console: [] };
        },
        async dispose() {
          disposed.push(runId);
        },
      };
      return handle;
    },
    async teardown(s) {
      teardowns.push(s.id);
    },
    async diagnose() {
      return opts.withBrowser ? undefined : "agent: OOM-killed (exit 137), restarts=3";
    },
  };
  return { runtime, ensures, teardowns, provisioned, disposed };
}

function fakeTraceSource(pages: TraceEvent[][]): { source: TraceSource; keys: string[] } {
  const keys: string[] = [];
  let call = 0;
  const source: TraceSource = {
    async fetch(key) {
      keys.push(key);
      const page = pages[Math.min(call, pages.length - 1)] ?? [];
      call += 1;
      return page;
    },
  };
  return { source, keys };
}

function build(over: Partial<FrontDoorSessionOptions> = {}, specOver: Partial<ServiceHarnessSpec> = {}) {
  const rt = fakeRuntime();
  const submits: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const trace = fakeTraceSource([[]]);
  const session = new FrontDoorSession({
    spec: spec(specOver),
    sessionRunId: "sess-1",
    runtime: rt.runtime,
    traceSource: trace.source,
    submit: async (url, payload) => {
      submits.push({ url, payload });
      return { output: "hello from the agent" };
    },
    ...over,
  });
  return { session, rt, submits, trace };
}

describe("FrontDoorSession — a multi-turn conversation through the front-door", () => {
  it("keeps the conversation coordinates session-stable while run_id stays per-turn", async () => {
    const { session, submits } = build();
    await session.boot();
    await session.turn({ task: "remember the number 7", turnRunId: "turn-a", timeoutSec: 60 });
    await session.turn({ task: "what number did I say?", turnRunId: "turn-b", timeoutSec: 60 });

    // The default body carries the SESSION thread — the checkpoint key that makes the agent resume.
    expect(submits.map((s) => s.payload.thread_id)).toEqual(["run-sess-1", "run-sess-1"]);
    expect(submits[0]?.payload.task).toBe("remember the number 7");
    expect(submits[1]?.payload.task).toBe("what number did I say?");
    expect(submits[0]?.url).toBe("http://front-door:8000/runs");
  });

  it("interpolates a bodyTemplate with session-stable {{thread_id}} and per-turn {{run_id}}", async () => {
    const { session, submits } = build(
      {},
      {
        frontDoor: {
          service: "agent",
          submit: "POST /runs",
          request: { bodyTemplate: { thread_id: "{{thread_id}}", run_id: "{{run_id}}", input: "{{task}}" } },
        },
      },
    );
    await session.boot();
    await session.turn({ task: "hi", turnRunId: "turn-a", timeoutSec: 60 });
    await session.turn({ task: "again", turnRunId: "turn-b", timeoutSec: 60 });
    expect(submits.map((s) => s.payload.thread_id)).toEqual(["run-sess-1", "run-sess-1"]);
    expect(submits.map((s) => s.payload.run_id)).toEqual(["turn-a", "turn-b"]);
  });

  it("returns the front-door reply as the assistant text", async () => {
    const { session } = build();
    await session.boot();
    const outcome = await session.turn({ task: "hi", turnRunId: "turn-a", timeoutSec: 60 });
    expect(outcome.status).toBe("done");
    expect(outcome.responseText).toContain("hello from the agent");
    expect(outcome.infraMarks.map((e) => (e.kind === "infra" ? e.event : ""))).toEqual([
      "drive_submitted",
      "drive_completed",
      "trace_collected",
    ]);
  });

  it("re-touches the warm topology on every turn and NEVER tears it down", async () => {
    const { session, rt } = build();
    await session.boot();
    await session.turn({ task: "one", turnRunId: "t1", timeoutSec: 60 });
    await session.turn({ task: "two", turnRunId: "t2", timeoutSec: 60 });
    await session.close();
    expect(rt.ensures.length).toBe(3); // boot + one touch per turn (touch-on-use keeps warm alive)
    expect(rt.teardowns).toEqual([]); // the warm topology is the cluster idle TTL's lifecycle, not ours
  });

  it("acquires the target ONCE at boot (held for the whole conversation) and disposes it once at close", async () => {
    const rt = fakeRuntime({ withBrowser: true });
    const submits: Array<Record<string, unknown>> = [];
    const session = new FrontDoorSession({
      spec: spec({
        target: {
          kind: "browser",
          engine: "chromium",
          lifecycle: "per-case-instance",
          observe: ["dom"],
        },
      }),
      sessionRunId: "sess-1",
      runtime: rt.runtime,
      traceSource: fakeTraceSource([[]]).source,
      submit: async (_url, payload) => {
        submits.push(payload);
        return {};
      },
    });
    const booted = await session.boot();
    expect(booted.cdpBase).toBe("http://127.0.0.1:9222");
    await session.turn({ task: "one", turnRunId: "t1", timeoutSec: 60 });
    await session.turn({ task: "two", turnRunId: "t2", timeoutSec: 60 });
    // One browser for the whole conversation, keyed by the SESSION id — page state survives across turns.
    expect(rt.provisioned).toEqual(["sess-1"]);
    expect(submits.every((p) => p.browser_cdp_url === "ws://browser:9222")).toBe(true);
    await session.close();
    await session.close(); // idempotent
    expect(rt.disposed).toEqual(["sess-1"]);
  });

  it("slices a session-stable contextId's cumulative trace into per-turn deltas", async () => {
    const e1: TraceEvent = { t: 1, kind: "message", role: "assistant", text: "turn one" };
    const e2: TraceEvent = { t: 2, kind: "message", role: "assistant", text: "turn two" };
    const trace = fakeTraceSource([[e1], [e1, e2]]);
    const { session } = build(
      { traceSource: trace.source },
      { frontDoor: { service: "agent", submit: "POST /runs", contextId: "{{thread_id}}" } },
    );
    await session.boot();
    const first = await session.turn({ task: "one", turnRunId: "t1", timeoutSec: 60 });
    const second = await session.turn({ task: "two", turnRunId: "t2", timeoutSec: 60 });
    expect(trace.keys).toEqual(["run-sess-1", "run-sess-1"]); // the stable coordinate keys the pull
    expect(first.trace).toEqual([e1]);
    expect(second.trace).toEqual([e2]); // only the delta past what turn 1 already returned
  });

  it("pulls by the per-turn run id when no contextId is declared (no delta bookkeeping needed)", async () => {
    const trace = fakeTraceSource([[]]);
    const { session } = build({ traceSource: trace.source });
    await session.boot();
    await session.turn({ task: "one", turnRunId: "t1", timeoutSec: 60 });
    await session.turn({ task: "two", turnRunId: "t2", timeoutSec: 60 });
    expect(trace.keys).toEqual(["t1", "t2"]);
  });

  it("degrades a trace-pull failure to one error event — the reply is the primary signal, the turn survives", async () => {
    const failing: TraceSource = {
      async fetch() {
        throw new Error("mlflow is down");
      },
    };
    const { session } = build({ traceSource: failing });
    await session.boot();
    const outcome = await session.turn({ task: "hi", turnRunId: "t1", timeoutSec: 60 });
    expect(outcome.status).toBe("done");
    expect(outcome.trace.length).toBe(1);
    expect(outcome.trace[0]?.kind === "error" && outcome.trace[0].message).toContain("mlflow is down");
  });

  it("fails a turn past its budget with completion-timeout naming the topology's sickness — the session stays usable", async () => {
    const rt = fakeRuntime(); // diagnose reports an OOM loop
    const session = new FrontDoorSession({
      spec: spec(),
      sessionRunId: "sess-1",
      runtime: rt.runtime,
      traceSource: fakeTraceSource([[]]).source,
      // The submit never resolves until aborted — a front-door holding the socket with no result.
      submit: (_url, _payload, opts) =>
        new Promise((_resolve, reject) => {
          if (opts?.signal?.aborted) return reject(new Error("aborted"));
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      startDriveDeadline: (_ms, onFire) => {
        onFire(); // fire immediately — deterministic timeout
        return () => undefined;
      },
    });
    await session.boot();
    await expect(session.turn({ task: "hi", turnRunId: "t1", timeoutSec: 5 })).rejects.toMatchObject({
      code: "HARNESS_RUN_FAILED",
      extra: { reason: "completion-timeout", topologyHealth: "agent: OOM-killed (exit 137), restarts=3" },
    });
  });

  it("refuses a trace-completion front-door at construction — it returns no reply to converse with", () => {
    expect(
      () =>
        new FrontDoorSession({
          spec: spec({
            frontDoor: {
              service: "agent",
              submit: "POST /runs",
              completion: { mode: "trace", intervalMs: 2000, timeoutMs: 120_000 },
            },
          }),
          sessionRunId: "sess-1",
          runtime: fakeRuntime().runtime,
          traceSource: fakeTraceSource([[]]).source,
        }),
    ).toThrowError(/cannot hold a conversation/);
  });

  it("mints a per-turn callback_url — the rendezvous holds one waiter per key, so turns must never share one", async () => {
    const urls: string[] = [];
    const { session, submits } = build(
      {
        callbackRendezvous: {
          url(runId) {
            urls.push(runId);
            return `http://cp/frontdoor-callback/${runId}`;
          },
          async wait() {
            return { body: { status: "done", output: "cb reply" } };
          },
        },
      },
      {
        frontDoor: {
          service: "agent",
          submit: "POST /runs",
          request: { bodyTemplate: { cb: "{{callback_url}}", input: "{{task}}" } },
          completion: { mode: "callback", done: { field: "status", equals: "done" }, timeoutMs: 120_000 },
        },
      },
    );
    await session.boot();
    await session.turn({ task: "one", turnRunId: "t1", timeoutSec: 60 });
    await session.turn({ task: "two", turnRunId: "t2", timeoutSec: 60 });
    expect(submits.map((s) => s.payload.cb)).toEqual([
      "http://cp/frontdoor-callback/t1",
      "http://cp/frontdoor-callback/t2",
    ]);
  });
});
