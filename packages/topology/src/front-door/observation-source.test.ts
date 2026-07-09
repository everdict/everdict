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
  it("reference: pulls the target's snapshot when a target is present (store-fetch)", async () => {
    const target = { snapshot: async () => browserSnap };
    const snap = await referenceObservationSource.observe({ target });
    expect(snap).toEqual(browserSnap);
  });

  it("reference: a prompt snapshot when there's no target (no stage — the primary signal is the trace)", async () => {
    const snap = await referenceObservationSource.observe({ target: undefined });
    expect(snap).toEqual({ kind: "prompt", output: "" });
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

  it("observationSourceFor: unset/reference → reference, sentinel/egress → each source (no throw)", () => {
    expect(observationSourceFor(undefined)).toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "reference" })).toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "sentinel" })).not.toBe(referenceObservationSource);
    expect(observationSourceFor({ mode: "egress", sink: "http://s/x" })).not.toBe(referenceObservationSource);
  });
});
