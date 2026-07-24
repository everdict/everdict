import type { EnvSnapshot, TraceEvidence } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  egressObservationSource,
  observationSourceFor,
  referenceObservationSource,
  sentinelObservationSource,
  traceObservationSource,
} from "./observation-source.js";

const browserSnap: EnvSnapshot = { kind: "browser", url: "http://x", dom: "<html>", screenshotRef: "s", console: [] };

describe("observation-source (delivery seam)", () => {
  it("reference: pulls the target's snapshot when a target is present (store-fetch)", async () => {
    const target = { snapshot: async () => browserSnap };
    const snap = await referenceObservationSource.observe({ target });
    expect(snap).toEqual(browserSnap);
  });

  it("reference: a prompt snapshot when there's no target and no response (no stage — the primary signal is the trace)", async () => {
    const snap = await referenceObservationSource.observe({ target: undefined });
    expect(snap).toEqual({ kind: "prompt", output: "" });
  });

  it("reference: with no target, carries the result-channel response as the prompt output (regression: it was dropped, leaving the snapshot empty)", async () => {
    const snap = await referenceObservationSource.observe({ target: undefined, response: "final answer text" });
    expect(snap).toEqual({ kind: "prompt", output: "final answer text" });
  });

  it("reference: a non-string response body is carried as JSON text", async () => {
    const snap = await referenceObservationSource.observe({ target: undefined, response: { answer: 42 } });
    expect(snap).toEqual({ kind: "prompt", output: '{"answer":42}' });
  });

  it("sentinel: extracts the observation from the result-channel body by dot-path (inline return)", async () => {
    const src = sentinelObservationSource("result.observation");
    const snap = await src.observe({ target: undefined, response: { result: { observation: browserSnap } } });
    expect(snap).toEqual(browserSnap);
  });

  it("sentinel: with no path, the whole body is the EnvSnapshot", async () => {
    const snap = await sentinelObservationSource(undefined).observe({ target: undefined, response: browserSnap });
    expect(snap).toEqual(browserSnap);
  });

  it("sentinel: throws explicitly when the body is not EnvSnapshot-shaped (no silent fallback)", async () => {
    const src = sentinelObservationSource("obs");
    await expect(src.observe({ target: undefined, response: { obs: { kind: "nonsense" } } })).rejects.toThrow(
      /EnvSnapshot/,
    );
  });

  it("egress: retrieves the observation via GET from the sink ({run_id}-interpolated, where the agent pushed it)", async () => {
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

  it("egress: throws explicitly when the fetch primitive (getJson) is missing", async () => {
    await expect(egressObservationSource("http://sink/x").observe({ target: undefined })).rejects.toThrow(
      /fetch primitive/,
    );
  });

  it("egress: throws when the retrieved body is not EnvSnapshot-shaped", async () => {
    const getJson = async () => ({ kind: "nope" });
    await expect(
      egressObservationSource("http://sink/x").observe({ target: undefined, getJson, wiring: {} }),
    ).rejects.toThrow(/EnvSnapshot/);
  });

  // trace-delivery: a containerless service target's agent offloaded its observation to its own store and referenced it
  // from the trace; the trace source already resolved those refs into evidence — synthesize the browser snapshot from it.
  it("trace: synthesizes a browser snapshot from the trace's resolved evidence (the harness's offloaded artifacts)", async () => {
    const evidence: TraceEvidence = { dom: "<offloaded/>", screenshot: "aGVsbG8=", screenshotMediaType: "image/png" };
    const snap = await traceObservationSource.observe({ target: undefined, evidence });
    expect(snap).toEqual({
      kind: "browser",
      url: "",
      dom: "<offloaded/>",
      screenshot: "aGVsbG8=",
      console: [],
    });
  });

  it("trace: falls back to the result-channel body as prompt output when the trace carries no browser evidence (never fails the run)", async () => {
    const snap = await traceObservationSource.observe({
      target: undefined,
      response: "final answer",
      evidence: undefined,
    });
    expect(snap).toEqual({ kind: "prompt", output: "final answer" });
    // Evidence present but with no browser slot (only a final answer) → still no snapshot to synthesize → prompt fallback.
    const answerOnly = await traceObservationSource.observe({
      target: undefined,
      response: "x",
      evidence: { finalAnswer: "done" },
    });
    expect(answerOnly).toEqual({ kind: "prompt", output: "x" });
  });

  it("observationSourceFor: unset/reference → reference, sentinel/egress/trace → each source (no throw)", () => {
    expect(observationSourceFor(undefined)).toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "reference" })).toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "sentinel" })).not.toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "egress", sink: "http://s/x" })).not.toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "trace" })).toBe(traceObservationSource);
  });
});
