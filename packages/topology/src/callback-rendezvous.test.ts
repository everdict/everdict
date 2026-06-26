import { describe, expect, it } from "vitest";
import { InProcessCallbackRendezvous } from "./callback-rendezvous.js";

describe("InProcessCallbackRendezvous", () => {
  it("url(runId) = baseUrl/runId (run 별 콜백 주소)", () => {
    expect(new InProcessCallbackRendezvous("http://cb/frontdoor/").url("run-4")).toBe("http://cb/frontdoor/run-4");
    expect(new InProcessCallbackRendezvous("http://cb/frontdoor").url("run-4")).toBe("http://cb/frontdoor/run-4");
  });

  it("deliver 가 wait 보다 먼저면 큐잉됐다가 즉시 반환된다", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    r.deliver("run-1", { a: 1 });
    expect(await r.wait("run-1", 1000)).toEqual({ body: { a: 1 } });
  });

  it("wait 가 먼저면 deliver 가 대기자를 깨운다", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    const pending = r.wait("run-2", 1000);
    r.deliver("run-2", { b: 2 });
    expect(await pending).toEqual({ body: { b: 2 } });
  });

  it("여러 deliver 는 FIFO 로 소비된다", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    r.deliver("r", { n: 1 });
    r.deliver("r", { n: 2 });
    expect(await r.wait("r", 1000)).toEqual({ body: { n: 1 } });
    expect(await r.wait("r", 1000)).toEqual({ body: { n: 2 } });
  });

  it("timeoutMs 안에 deliver 가 없으면 undefined(=timeout)", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    expect(await r.wait("run-3", 5)).toBeUndefined();
  });

  it("run 별로 격리된다 — 다른 runId 의 deliver 는 깨우지 않는다", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    r.deliver("other", { x: 1 });
    expect(await r.wait("mine", 5)).toBeUndefined(); // mine 은 못 받음
    expect(await r.wait("other", 1000)).toEqual({ body: { x: 1 } }); // other 큐는 남아있다
  });
});
