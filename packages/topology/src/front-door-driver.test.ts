import type { FrontDoorCompletion } from "@assay/core";
import { describe, expect, it } from "vitest";
import {
  type FrontDoorDriveRequest,
  HttpFrontDoorDriver,
  interpolatePath,
  interpolateTemplate,
  methodPath,
} from "./front-door-driver.js";

// 호출마다 step 만큼 증가하는 가짜 시계 — 타임아웃을 결정적으로 검증.
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
  it("method 토큰을 분리하고, 없으면 POST 로 본다", () => {
    expect(methodPath("POST /runs")).toEqual({ method: "POST", path: "/runs" });
    expect(methodPath("/runs")).toEqual({ method: "POST", path: "/runs" });
  });

  it("{var} 토큰을 wiring 으로 치환하고 미매칭은 원문을 유지한다", () => {
    expect(interpolatePath("/runs/{run_id}/status", { run_id: "abc" })).toBe("/runs/abc/status");
    expect(interpolatePath("/runs/{unknown}", {})).toBe("/runs/{unknown}");
  });
});

describe("interpolateTemplate", () => {
  it("문자열 값의 {{var}} 를 wiring 으로 치환하고 중첩 객체/배열도 재귀 처리, 비문자열은 그대로 둔다", () => {
    const out = interpolateTemplate(
      { task: "{{task}}", nested: { thread: "{{thread_id}}" }, list: ["{{run_id}}", "lit"], n: 7, b: true },
      { task: "do it", thread_id: "run-1", run_id: "1" },
    );
    expect(out).toEqual({ task: "do it", nested: { thread: "run-1" }, list: ["1", "lit"], n: 7, b: true });
  });

  it("미매칭 토큰은 원문을 유지한다", () => {
    expect(interpolateTemplate({ x: "{{unknown}}" }, {})).toEqual({ x: "{{unknown}}" });
  });
});

describe("HttpFrontDoorDriver.drive", () => {
  it("completion 미지정이면 submit 한 번만 하고 done — 상태 폴링은 하지 않는다(현행 sync 동작)", async () => {
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

  it("poll: 상태가 종료조건(done)이 될 때까지 폴링하고 done 을 돌려준다", async () => {
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
    // {run_id} 가 wiring 으로 치환되어 폴링된다.
    expect(polledUrls[0]).toBe("http://agent:8000/runs/fixed/status");
  });

  it("poll: failed 종료조건에 매칭되면 failed 를 돌려준다(채점 진행용)", async () => {
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

  it("poll: 타임아웃 안에 종료조건을 못 만나면 timeout 을 돌려준다", async () => {
    const completion: FrontDoorCompletion = {
      mode: "poll",
      statusPath: "GET /runs/{run_id}/status",
      done: { field: "status", equals: "done" },
      intervalMs: 5,
      timeoutMs: 1500,
    };
    const driver = new HttpFrontDoorDriver({
      submit: async () => {},
      getJson: async () => ({ status: "running" }), // 영원히 running
      sleep: async () => {},
      now: steppingClock(1000), // start=0, 다음 조건체크=1000(<1500 통과), 그 다음=2000(>=1500 종료)
    });

    const outcome = await driver.drive(baseReq({ completion }));

    expect(outcome.status).toBe("timeout");
  });
});

describe("HttpFrontDoorDriver.drive — 상관(correlate)", () => {
  it("correlate 미지정이면 injected: traceRef = 주어진 runId(현행)", async () => {
    const driver = new HttpFrontDoorDriver({ submit: async () => ({ run_id: "agent-xyz" }) });
    const outcome = await driver.drive(baseReq({ correlate: undefined, traceRef: "fixed" }));
    expect(outcome.traceRef).toBe("fixed"); // 응답의 agent-xyz 가 아니라 주입한 runId
  });

  it("correlate returned: submit 응답에서 dot-path 로 에이전트 id 를 추출해 traceRef 로 쓴다", async () => {
    const driver = new HttpFrontDoorDriver({ submit: async () => ({ data: { id: "agent-9" } }) });
    const outcome = await driver.drive(baseReq({ correlate: { mode: "returned", path: "data.id" } }));
    expect(outcome).toEqual({ traceRef: "agent-9", status: "done" });
  });

  it("correlate returned + poll: 추출한 에이전트 id 로 statusPath 를 보간해 폴링한다", async () => {
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
    // 주입 runId(fixed)가 아니라 에이전트가 돌려준 agent-9 로 폴링한다.
    expect(polledUrls[0]).toBe("http://agent:8000/runs/agent-9/status");
  });

  it("correlate returned: 응답에 상관 필드가 없으면 UpstreamError 로 명확히 실패한다", async () => {
    const driver = new HttpFrontDoorDriver({ submit: async () => ({}) });
    const err = await driver
      .drive(baseReq({ correlate: { mode: "returned", path: "run_id" } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("UPSTREAM_ERROR");
  });
});
