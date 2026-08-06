import type { Dispatcher } from "@everdict/backends";
import { type CaseJob, type CaseResult, UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { TraceRecordingDispatcher } from "./trace-recording-dispatcher.js";

function job(target?: string): CaseJob {
  return {
    evalCase: {
      id: "c1",
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 1,
      tags: [],
      ...(target !== undefined ? { placement: { target } } : {}),
    },
    harness: { id: "h", version: "1.0.0" },
    tenant: "acme",
  };
}

const okResult: CaseResult = {
  caseId: "c1",
  harness: "h@1.0.0",
  trace: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
};

describe("TraceRecordingDispatcher", () => {
  it("prepends the control-plane account (accepted → waiting → started) to the result trace", async () => {
    const inner: Dispatcher = {
      dispatch: async (_job, opts) => {
        opts?.onWaiting?.("runner offline — waiting for reconnect");
        opts?.onStarted?.();
        return okResult;
      },
    };
    const result = await new TraceRecordingDispatcher(inner).dispatch(job("nomad-prod"));
    const infra = result.trace.filter((e) => e.kind === "infra");
    expect(infra.map((e) => (e.kind === "infra" ? e.event : undefined))).toEqual(["accepted", "waiting", "started"]);
    expect(infra[0]?.kind === "infra" && infra[0].message).toContain("nomad-prod");
    expect(infra.every((e) => e.kind === "infra" && e.scope === "placement" && e.at !== undefined)).toBe(true);
    // The control-plane segment precedes the backend's own trace.
    expect(result.trace[result.trace.length - 1]?.kind).toBe("message");
  });

  it("forwards the caller's own onWaiting/onStarted callbacks", async () => {
    const seen: string[] = [];
    const inner: Dispatcher = {
      dispatch: async (_job, opts) => {
        opts?.onWaiting?.("blocked");
        opts?.onStarted?.();
        return okResult;
      },
    };
    await new TraceRecordingDispatcher(inner).dispatch(job(), {
      onWaiting: (reason) => seen.push(`waiting:${reason}`),
      onStarted: () => seen.push("started"),
    });
    expect(seen).toEqual(["waiting:blocked", "started"]);
  });

  it("does not record the same consecutive waiting reason twice", async () => {
    const inner: Dispatcher = {
      dispatch: async (_job, opts) => {
        opts?.onWaiting?.("no capacity");
        opts?.onWaiting?.("no capacity");
        return okResult;
      },
    };
    const result = await new TraceRecordingDispatcher(inner).dispatch(job());
    const waits = result.trace.filter((e) => e.kind === "infra" && e.event === "waiting");
    expect(waits).toHaveLength(1);
  });

  it("tees each mark into the live-trace buffer keyed by the CP-minted job.runId (observability ⑦)", async () => {
    const live = new Map<string, unknown[]>();
    const inner: Dispatcher = {
      dispatch: async (_job, opts) => {
        opts?.onWaiting?.("no capacity");
        opts?.onStarted?.();
        return okResult;
      },
    };
    const dispatcher = new TraceRecordingDispatcher(inner, {
      append: (runId, events) => live.set(runId, [...(live.get(runId) ?? []), ...events]),
    });
    await dispatcher.dispatch({ ...job("nomad-prod"), runId: "evd-run-r1" });
    expect(live.get("evd-run-r1")).toHaveLength(3); // accepted → waiting → started, live as they happen
    // A job without a runId (no correlation key) never touches the buffer.
    await dispatcher.dispatch(job());
    expect(live.size).toBe(1);
  });

  it("attaches the control-plane account to a thrown AppError's placement evidence", async () => {
    const inner: Dispatcher = {
      dispatch: async (_job, opts) => {
        opts?.onWaiting?.("runner offline");
        throw new UpstreamError("UPSTREAM_ERROR", { placement: { events: ["backend line"] } }, "dispatch died");
      },
    };
    const err = await new TraceRecordingDispatcher(inner)
      .dispatch(job("self:runner-1"))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const events = (err as UpstreamError).extra?.placement as { events: string[] };
    // Control-plane marks first (they happened first), then the backend's own captured lines.
    expect(events.events.at(0)).toContain("self:runner-1");
    expect(events.events).toContain("runner offline");
    expect(events.events.at(-1)).toBe("backend line");
  });
});
