import type { EnvSnapshot } from "@everdict/core";
import { describe, expect, it } from "vitest";
import {
  egressObservationSource,
  observationSourceFor,
  referenceObservationSource,
  sentinelObservationSource,
} from "./observation-source.js";

const browserSnap: EnvSnapshot = { kind: "browser", url: "http://x", dom: "<html>", screenshotRef: "s", console: [] };

describe("observation-source (delivery seam)", () => {
  it("reference: 타깃이 있으면 그 스냅샷을 pull 한다(store-fetch)", async () => {
    const target = { snapshot: async () => browserSnap };
    const snap = await referenceObservationSource.observe({ target });
    expect(snap).toEqual(browserSnap);
  });

  it("reference: 타깃이 없으면 prompt 스냅샷(무대 없음 — 1차 신호는 trace)", async () => {
    const snap = await referenceObservationSource.observe({ target: undefined });
    expect(snap).toEqual({ kind: "prompt", output: "" });
  });

  it("sentinel: 결과 채널 본문에서 dot-path 로 관측물을 꺼낸다(인라인 반환)", async () => {
    const src = sentinelObservationSource("result.observation");
    const snap = await src.observe({ target: undefined, response: { result: { observation: browserSnap } } });
    expect(snap).toEqual(browserSnap);
  });

  it("sentinel: path 미지정이면 본문 전체가 곧 EnvSnapshot", async () => {
    const snap = await sentinelObservationSource(undefined).observe({ target: undefined, response: browserSnap });
    expect(snap).toEqual(browserSnap);
  });

  it("sentinel: 본문이 EnvSnapshot 형식이 아니면 명시적 throw(침묵 폴백 없음)", async () => {
    const src = sentinelObservationSource("obs");
    await expect(src.observe({ target: undefined, response: { obs: { kind: "nonsense" } } })).rejects.toThrow(
      /EnvSnapshot/,
    );
  });

  it("egress: sink({run_id} 보간)에서 GET 으로 관측물을 회수한다(에이전트가 push 한 위치)", async () => {
    let fetched = "";
    const getJson = async (url: string) => {
      fetched = url;
      return browserSnap;
    };
    const snap = await egressObservationSource("http://sink/runs/{run_id}/obs.json").observe({
      target: undefined,
      getJson,
      wiring: { run_id: "r1" },
    });
    expect(fetched).toBe("http://sink/runs/r1/obs.json");
    expect(snap).toEqual(browserSnap);
  });

  it("egress: fetch 프리미티브(getJson)가 없으면 명시적 throw", async () => {
    await expect(egressObservationSource("http://sink/x").observe({ target: undefined })).rejects.toThrow(
      /fetch 프리미티브/,
    );
  });

  it("egress: 회수 본문이 EnvSnapshot 형식이 아니면 throw", async () => {
    const getJson = async () => ({ kind: "nope" });
    await expect(
      egressObservationSource("http://sink/x").observe({ target: undefined, getJson, wiring: {} }),
    ).rejects.toThrow(/EnvSnapshot/);
  });

  it("observationSourceFor: 미설정/reference → reference, sentinel/egress → 각 소스(throw 없음)", () => {
    expect(observationSourceFor(undefined)).toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "reference" })).toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "sentinel" })).not.toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "egress", sink: "http://s/x" })).not.toBe(referenceObservationSource);
  });
});
