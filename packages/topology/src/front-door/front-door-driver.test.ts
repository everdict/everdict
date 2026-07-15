import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { FrontDoorCompletion } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  type CallbackRendezvous,
  type FrontDoorDriveRequest,
  type FrontDoorRequestOpts,
  HttpFrontDoorDriver,
  interpolateHeaders,
  interpolatePath,
  interpolateTemplate,
  methodPath,
} from "./front-door-driver.js";

// A fake clock that increments by step on each call — for deterministic timeout verification.
function steppingClock(step: number): () => number {
  let t = 0;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

const baseReq = (over: Partial<FrontDoorDriveRequest>): FrontDoorDriveRequest => ({
  base: "http://agent:8000",
  submit: "POST /runs",
  payload: { task: "do it" },
  completion: undefined,
  correlate: undefined,
  wiring: { run_id: "fixed", thread_id: "run-fixed" },
  traceRef: "fixed",
  ...over,
});

describe("methodPath / interpolatePath", () => {
  it("splits the method token, defaulting to POST when absent", () => {
    expect(methodPath("POST /runs")).toEqual({ method: "POST", path: "/runs" });
    expect(methodPath("/runs")).toEqual({ method: "POST", path: "/runs" });
  });

  it("replaces {var} tokens with wiring and keeps unmatched ones as the original", () => {
    expect(interpolatePath("/runs/{run_id}/status", { run_id: "abc" })).toBe("/runs/abc/status");
    expect(interpolatePath("/runs/{unknown}", {})).toBe("/runs/{unknown}");
  });
});

describe("interpolateTemplate", () => {
  it("replaces {{var}} in string values with wiring, recurses into nested objects/arrays, and leaves non-strings untouched", () => {
    const out = interpolateTemplate(
      { task: "{{task}}", nested: { thread: "{{thread_id}}" }, list: ["{{run_id}}", "lit"], n: 7, b: true },
      { task: "do it", thread_id: "run-1", run_id: "1" },
    );
    expect(out).toEqual({ task: "do it", nested: { thread: "run-1" }, list: ["1", "lit"], n: 7, b: true });
  });

  it("keeps unmatched tokens as the original", () => {
    expect(interpolateTemplate({ x: "{{unknown}}" }, {})).toEqual({ x: "{{unknown}}" });
  });
});

describe("interpolateHeaders", () => {
  it("interpolates {{var}} in header values with wiring and keeps keys as-is (unmatched stays original)", () => {
    expect(
      interpolateHeaders(
        { Authorization: "Bearer {{run_id}}", "X-Lit": "static", "X-Miss": "{{nope}}" },
        { run_id: "r1" },
      ),
    ).toEqual({ Authorization: "Bearer r1", "X-Lit": "static", "X-Miss": "{{nope}}" });
  });
});

describe("HttpFrontDoorDriver.drive", () => {
  it("with completion unset, submits once and is done — no status polling (current sync behavior)", async () => {
    const submitted: Array<{ url: string; payload: Record<string, unknown> }> = [];
    let polls = 0;
    const driver = new HttpFrontDoorDriver({
      submit: async (url, payload) => {
        submitted.push({ url, payload });
      },
      getJson: async () => {
        polls += 1;
        return {};
      },
    });

    const outcome = await driver.drive(baseReq({ completion: undefined }));

    expect(outcome).toEqual({ traceRef: "fixed", status: "done" });
    expect(submitted).toEqual([{ url: "http://agent:8000/runs", payload: { task: "do it" } }]);
    expect(polls).toBe(0);
  });

  it("passes method (submit verb) + headers to submit (request.headers/method knob)", async () => {
    let opts: FrontDoorRequestOpts | undefined;
    const driver = new HttpFrontDoorDriver({
      submit: async (_url, _payload, o) => {
        opts = o;
        return {};
      },
    });
    await driver.drive(baseReq({ submit: "PUT /things", headers: { Authorization: "Bearer x" } }));
    expect(opts?.method).toBe("PUT");
    expect(opts?.headers).toEqual({ Authorization: "Bearer x" });
  });

  it("poll: polls until the status hits the terminal condition (done) and returns done", async () => {
    const responses = [{ status: "running" }, { status: "running" }, { status: "done" }];
    let i = 0;
    const polledUrls: string[] = [];
    const completion: FrontDoorCompletion = {
      mode: "poll",
      statusPath: "GET /runs/{run_id}/status",
      done: { field: "status", equals: "done" },
      intervalMs: 5,
      timeoutMs: 1_000_000,
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => {},
      getJson: async (url) => {
        polledUrls.push(url);
        return responses[i++] ?? { status: "done" };
      },
      sleep: async () => {},
      now: steppingClock(10),
    });

    const outcome = await driver.drive(baseReq({ completion }));

    expect(outcome.status).toBe("done");
    expect(polledUrls).toHaveLength(3);
    // {run_id} is replaced with wiring for the poll.
    expect(polledUrls[0]).toBe("http://agent:8000/runs/fixed/status");
  });

  it("poll: returns failed when the failed terminal condition matches (for grading to proceed)", async () => {
    const completion: FrontDoorCompletion = {
      mode: "poll",
      statusPath: "GET /runs/{run_id}/status",
      done: { field: "state", equals: "succeeded" },
      failed: { field: "state", oneOf: ["failed", "error"] },
      intervalMs: 5,
      timeoutMs: 1_000_000,
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => {},
      getJson: async () => ({ state: "error" }),
      sleep: async () => {},
      now: steppingClock(10),
    });

    const outcome = await driver.drive(baseReq({ completion }));

    expect(outcome.status).toBe("failed");
  });

  it("poll: returns timeout when the terminal condition isn't met within the timeout", async () => {
    const completion: FrontDoorCompletion = {
      mode: "poll",
      statusPath: "GET /runs/{run_id}/status",
      done: { field: "status", equals: "done" },
      intervalMs: 5,
      timeoutMs: 1500,
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => {},
      getJson: async () => ({ status: "running" }), // running forever
      sleep: async () => {},
      now: steppingClock(1000), // start=0, next condition check=1000 (<1500 passes), then=2000 (>=1500 ends)
    });

    const outcome = await driver.drive(baseReq({ completion }));

    expect(outcome.status).toBe("timeout");
  });
});

describe("HttpFrontDoorDriver.drive — stream", () => {
  // A fake SSE stream that yields events in order (deterministic, no socket).
  const streamOf = (events: unknown[]) =>
    async function* () {
      for (const e of events) yield e;
    };

  it("stream: consumes up to the terminal event (done match) and returns done + that event as the result channel", async () => {
    const completion: FrontDoorCompletion = {
      mode: "stream",
      done: { field: "status.state", equals: "completed" },
      timeoutMs: 10000,
    };
    const driver = new HttpFrontDoorDriver({
      openStream: streamOf([
        { id: "task-1", status: { state: "working" } },
        { id: "task-1", status: { state: "completed" }, final: true },
      ]),
      now: () => 0, // no timeout
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("done");
    expect(outcome.response).toEqual({ id: "task-1", status: { state: "completed" }, final: true });
  });

  it("stream: returns failed when the failed terminal condition matches", async () => {
    const completion: FrontDoorCompletion = {
      mode: "stream",
      done: { field: "status.state", equals: "completed" },
      failed: { field: "status.state", oneOf: ["failed", "canceled"] },
      timeoutMs: 10000,
    };
    const driver = new HttpFrontDoorDriver({
      openStream: streamOf([{ status: { state: "working" } }, { status: { state: "canceled" } }]),
      now: () => 0,
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("failed");
    expect(outcome.response).toEqual({ status: { state: "canceled" } });
  });

  it("stream: timeout when the stream ends with no terminal match (completion unconfirmed)", async () => {
    const completion: FrontDoorCompletion = {
      mode: "stream",
      done: { field: "status.state", equals: "completed" },
      timeoutMs: 10000,
    };
    const driver = new HttpFrontDoorDriver({
      openStream: streamOf([{ status: { state: "working" } }]),
      now: () => 0,
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("timeout");
  });

  it("stream: times out before the terminal event once the wall-clock timeout passes", async () => {
    const completion: FrontDoorCompletion = {
      mode: "stream",
      done: { field: "status.state", equals: "completed" },
      timeoutMs: 5,
    };
    const driver = new HttpFrontDoorDriver({
      openStream: streamOf([{ status: { state: "working" } }, { status: { state: "completed" } }]),
      now: steppingClock(10), // start=0, after the first event now()=10 ≥ 5 → timeout before reaching the completed event
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("timeout");
  });

  it("stream + correlate returned: extracts the agent id from the first event and uses it as traceRef", async () => {
    const completion: FrontDoorCompletion = {
      mode: "stream",
      done: { field: "status.state", equals: "completed" },
      timeoutMs: 10000,
    };
    const driver = new HttpFrontDoorDriver({
      openStream: streamOf([
        { id: "agent-7", status: { state: "working" } },
        { id: "agent-7", status: { state: "completed" } },
      ]),
      now: () => 0,
    });
    const outcome = await driver.drive(baseReq({ completion, correlate: { mode: "returned", path: "id" } }));
    expect(outcome.traceRef).toBe("agent-7");
    expect(outcome.status).toBe("done");
  });
});

describe("HttpFrontDoorDriver.drive — callback", () => {
  // A fake rendezvous that returns scripted results in order (undefined=timeout afterward). Records wait-call keys.
  const scriptedRendezvous = (
    results: Array<{ body: unknown } | undefined>,
  ): CallbackRendezvous & { keys: string[] } => {
    let i = 0;
    const keys: string[] = [];
    return {
      keys,
      url: (runId) => `http://cb/${runId}`,
      async wait(runId) {
        keys.push(runId);
        return i < results.length ? results[i++] : undefined;
      },
    };
  };

  it("callback: after fire-and-forget, done from the inbound POST body (done unset = any POST completes)", async () => {
    const completion: FrontDoorCompletion = { mode: "callback", timeoutMs: 10000 };
    const driver = new HttpFrontDoorDriver({
      submit: async () => ({}),
      callbackRendezvous: scriptedRendezvous([{ body: { observation: 1 } }]),
      now: () => 0,
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("done");
    expect(outcome.response).toEqual({ observation: 1 });
  });

  it("callback: with done specified, lets interim callbacks through and waits for a matching POST", async () => {
    const completion: FrontDoorCompletion = {
      mode: "callback",
      done: { field: "state", equals: "completed" },
      timeoutMs: 10000,
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => ({}),
      callbackRendezvous: scriptedRendezvous([{ body: { state: "working" } }, { body: { state: "completed" } }]),
      now: () => 0,
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("done");
    expect(outcome.response).toEqual({ state: "completed" });
  });

  it("callback: failed when the failed terminal condition matches", async () => {
    const completion: FrontDoorCompletion = {
      mode: "callback",
      done: { field: "state", equals: "ok" },
      failed: { field: "state", equals: "error" },
      timeoutMs: 10000,
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => ({}),
      callbackRendezvous: scriptedRendezvous([{ body: { state: "error" } }]),
      now: () => 0,
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("failed");
  });

  it("callback: timeout when no inbound arrives (rendezvous undefined)", async () => {
    const completion: FrontDoorCompletion = { mode: "callback", timeoutMs: 10000 };
    const driver = new HttpFrontDoorDriver({
      submit: async () => ({}),
      callbackRendezvous: scriptedRendezvous([]), // undefined from the first wait
      now: () => 0,
    });
    const outcome = await driver.drive(baseReq({ completion }));
    expect(outcome.status).toBe("timeout");
  });

  it("callback: the rendezvous key is runId (the value embedded in callback_url), traceRef is the correlate result (agent id)", async () => {
    const completion: FrontDoorCompletion = { mode: "callback", timeoutMs: 10000 };
    const r = scriptedRendezvous([{ body: {} }]);
    const driver = new HttpFrontDoorDriver({
      submit: async () => ({ id: "agent-9" }),
      callbackRendezvous: r,
      now: () => 0,
    });
    const outcome = await driver.drive(
      baseReq({ completion, correlate: { mode: "returned", path: "id" }, traceRef: "run-1" }),
    );
    expect(outcome.traceRef).toBe("agent-9"); // the trace fetch key
    expect(r.keys).toEqual(["run-1"]); // rendezvous key = runId
  });

  it("callback: fails explicitly when there's no rendezvous", async () => {
    const driver = new HttpFrontDoorDriver({ submit: async () => ({}) });
    await expect(driver.drive(baseReq({ completion: { mode: "callback", timeoutMs: 1000 } }))).rejects.toThrow();
  });
});

describe("HttpFrontDoorDriver.drive — correlate", () => {
  it("with correlate unset, injected: traceRef = the given runId (current)", async () => {
    const driver = new HttpFrontDoorDriver({ submit: async () => ({ run_id: "agent-xyz" }) });
    const outcome = await driver.drive(baseReq({ correlate: undefined, traceRef: "fixed" }));
    expect(outcome.traceRef).toBe("fixed"); // the injected runId, not agent-xyz from the response
  });

  it("correlate returned: extracts the agent id from the submit response by dot-path and uses it as traceRef", async () => {
    const driver = new HttpFrontDoorDriver({ submit: async () => ({ data: { id: "agent-9" } }) });
    const outcome = await driver.drive(baseReq({ correlate: { mode: "returned", path: "data.id" } }));
    // sync → result-channel body = submit response (sentinel retrieval reads this).
    expect(outcome).toEqual({ traceRef: "agent-9", status: "done", response: { data: { id: "agent-9" } } });
  });

  it("result-channel body (response): the submit response for sync, the completed status body for poll", async () => {
    // sync: the submit response is the result channel.
    const syncDriver = new HttpFrontDoorDriver({ submit: async () => ({ observation: { kind: "browser" } }) });
    const sync = await syncDriver.drive(baseReq({ completion: undefined }));
    expect(sync.response).toEqual({ observation: { kind: "browser" } });

    // poll: the completed (done) status body is the result channel (not the submit response).
    const bodies = [{ status: "running" }, { status: "done", observation: { kind: "prompt" } }];
    let i = 0;
    const pollDriver = new HttpFrontDoorDriver({
      submit: async () => ({ ignored: true }),
      getJson: async () => bodies[i++] ?? { status: "done" },
      sleep: async () => {},
      now: steppingClock(10),
    });
    const poll = await pollDriver.drive(
      baseReq({
        completion: {
          mode: "poll",
          statusPath: "GET /runs/{run_id}/status",
          done: { field: "status", equals: "done" },
          intervalMs: 5,
          timeoutMs: 1_000_000,
        },
      }),
    );
    expect(poll.response).toEqual({ status: "done", observation: { kind: "prompt" } });
  });

  it("correlate returned + poll: polls with the statusPath interpolated by the extracted agent id", async () => {
    const polledUrls: string[] = [];
    const driver = new HttpFrontDoorDriver({
      submit: async () => ({ run_id: "agent-9" }),
      getJson: async (url) => {
        polledUrls.push(url);
        return { status: "done" };
      },
      sleep: async () => {},
      now: steppingClock(10),
    });

    const outcome = await driver.drive(
      baseReq({
        correlate: { mode: "returned", path: "run_id" },
        completion: {
          mode: "poll",
          statusPath: "GET /runs/{run_id}/status",
          done: { field: "status", equals: "done" },
          intervalMs: 5,
          timeoutMs: 1_000_000,
        },
      }),
    );

    expect(outcome.traceRef).toBe("agent-9");
    // polls with agent-9 returned by the agent, not the injected runId (fixed).
    expect(polledUrls[0]).toBe("http://agent:8000/runs/agent-9/status");
  });

  it("correlate returned: fails explicitly with UpstreamError when the correlation field is absent from the response", async () => {
    const driver = new HttpFrontDoorDriver({ submit: async () => ({}) });
    const err = await driver
      .drive(baseReq({ correlate: { mode: "returned", path: "run_id" } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("UPSTREAM_ERROR");
  });
});

// The default submit is a direct node:http request — the point is to avoid undici's (global fetch) headersTimeout (default 300s).
// Verifies a round trip against a real http server + the socket idle timeout (cutting on no-flow) (no submit io injected = the default path).
describe("HttpFrontDoorDriver default submit (node http)", () => {
  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
    port: number;
    close: () => Promise<void>;
    held: ServerResponse[];
  }> {
    const held: ServerResponse[] = [];
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : 0;
    return {
      port,
      held,
      close: () =>
        new Promise<void>((resolve) => {
          for (const r of held) r.destroy();
          server.close(() => resolve());
        }),
    };
  }

  it("reads the response JSON body and uses it for correlation (returned) — node http round trip", async () => {
    const srv = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ run_id: "srv-1", echo: JSON.parse(body || "{}") }));
      });
    });
    try {
      const outcome = await new HttpFrontDoorDriver().drive(
        baseReq({ base: `http://127.0.0.1:${srv.port}`, correlate: { mode: "returned", path: "run_id" } }),
      );
      expect(outcome.status).toBe("done");
      expect(outcome.traceRef).toBe("srv-1"); // extracted the correlation id from the server response body → round trip succeeded
    } finally {
      await srv.close();
    }
  });

  it("when the server holds the response with no flow, cuts on timeoutMs (socket idle) and UpstreamError", async () => {
    const srv = await listen((_req, res) => {
      srv.held.push(res); // never responds — socket no-flow
    });
    try {
      // poll completion model → drive passes completion.timeoutMs to submit as the socket idle timeout.
      const err = await new HttpFrontDoorDriver({ getJson: async () => ({ status: "done" }) })
        .drive(
          baseReq({
            base: `http://127.0.0.1:${srv.port}`,
            completion: {
              mode: "poll",
              statusPath: "GET /s",
              done: { field: "status", equals: "done" },
              intervalMs: 10,
              timeoutMs: 80,
            },
          }),
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("UPSTREAM_ERROR");
    } finally {
      await srv.close();
    }
  });
});

// Cancellation — a user stops the scorecard mid-run; the drive aborts promptly (CANCELLED) instead of draining the
// topology run to completion. dispatch's finally then tears down the per-case browser (freeing the runtime).
describe("HttpFrontDoorDriver.drive — cancellation (user stop)", () => {
  it("sync: an already-aborted signal throws CANCELLED right after submit (no trace/observe work)", async () => {
    const controller = new AbortController();
    controller.abort();
    const driver = new HttpFrontDoorDriver({ submit: async () => ({ ok: true }), getJson: async () => ({}) });
    await expect(driver.drive(baseReq({ completion: undefined, signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("poll: aborting stops the poll loop and throws CANCELLED (doesn't keep polling to the deadline)", async () => {
    const controller = new AbortController();
    let polls = 0;
    const completion: FrontDoorCompletion = {
      mode: "poll",
      statusPath: "GET /runs/{run_id}",
      done: { field: "status", equals: "done" },
      intervalMs: 10,
      timeoutMs: 10_000,
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => {},
      getJson: async () => {
        polls++;
        controller.abort(); // control plane cancels after the first status check
        return { status: "running" };
      },
      sleep: async () => {},
      now: steppingClock(10),
    });
    await expect(driver.drive(baseReq({ completion, signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(polls).toBe(1); // stopped on the next iteration's abort check, not run to timeout
  });

  it("stream: aborting mid-stream throws CANCELLED (stops consuming events)", async () => {
    const controller = new AbortController();
    const completion: FrontDoorCompletion = {
      mode: "stream",
      done: { field: "status", equals: "done" },
      timeoutMs: 10_000,
    };
    async function* stream(): AsyncIterable<unknown> {
      yield { status: "working" };
      controller.abort(); // cancel arrives between events
      yield { status: "still-working" };
    }
    const driver = new HttpFrontDoorDriver({ openStream: () => stream(), now: steppingClock(10) });
    await expect(driver.drive(baseReq({ completion, signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("callback: aborting rejects promptly with CANCELLED instead of waiting out the deadline", async () => {
    const controller = new AbortController();
    const completion: FrontDoorCompletion = {
      mode: "callback",
      done: { field: "status", equals: "done" },
      timeoutMs: 10_000,
    };
    const rendezvous: CallbackRendezvous = {
      url: (id) => `http://cp/callback/${id}`,
      wait: () => new Promise(() => {}), // never resolves — only the cancel can end the wait
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => ({}),
      callbackRendezvous: rendezvous,
      now: steppingClock(10),
    });
    const p = driver.drive(baseReq({ completion, signal: controller.signal }));
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
