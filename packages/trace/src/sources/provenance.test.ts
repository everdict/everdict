import { describe, expect, it } from "vitest";

import { mlflowTracesToSummaries } from "./mlflow.js";
import { type Span, extractProvenance, provenanceByLookup, provenanceFromSpans } from "./trace-source.js";

// Everdict provenance recovery — the origin (run/scorecard/dataset/harness/case) a pulled trace carries, across the
// per-platform key-naming variants. This is DATA (surfaced on the summary + inspect result) so an agent can resolve
// the context of a trace it's analyzing before acting.
describe("extractProvenance", () => {
  it("reads MLflow trace_metadata camelCase keys + the run_id tag", () => {
    expect(
      extractProvenance({
        "everdict.scorecardId": "sc1",
        "everdict.dataset": "ds1",
        "everdict.harness": "hn1",
        "everdict.caseId": "c1",
        "everdict.run_id": "run1",
      }),
    ).toEqual({ runId: "run1", scorecardId: "sc1", dataset: "ds1", harness: "hn1", caseId: "c1" });
  });

  it("reads the OTLP/Phoenix snake-case everdict.scorecard_id variant", () => {
    expect(extractProvenance({ "everdict.scorecard_id": "sc9", "everdict.harness": "hn9" })).toEqual({
      scorecardId: "sc9",
      harness: "hn9",
    });
  });

  it("reads Langfuse/LangSmith unprefixed keys (scorecardId/dataset/harness/caseId)", () => {
    expect(extractProvenance({ scorecardId: "sc2", dataset: "ds2", harness: "hn2", caseId: "c2" })).toEqual({
      scorecardId: "sc2",
      dataset: "ds2",
      harness: "hn2",
      caseId: "c2",
    });
  });

  it("returns undefined when the trace carries no everdict origin (an unrelated external trace)", () => {
    expect(extractProvenance({ "user.tag": "prod", "mlflow.traceName": "chat" })).toBeUndefined();
  });

  it("ignores empty-string values instead of emitting empty fields", () => {
    expect(extractProvenance({ "everdict.scorecardId": "", "everdict.harness": "hn" })).toEqual({ harness: "hn" });
  });
});

describe("provenanceFromSpans", () => {
  const span = (attrs: Record<string, unknown>): Span => ({ name: "s", startMs: 0, endMs: 1, attrs });

  it("merges the origin keys across spans (first defined wins) — the sink writes them on the root span", () => {
    const spans = [
      span({ "everdict.scorecard_id": "sc", "gen_ai.request.model": "gpt" }),
      span({ "everdict.harness": "hn" }),
    ];
    expect(provenanceFromSpans(spans)).toEqual({ scorecardId: "sc", harness: "hn" });
  });

  it("is undefined for spans with no everdict attributes", () => {
    expect(provenanceFromSpans([span({ "gen_ai.request.model": "gpt" })])).toBeUndefined();
  });
});

describe("provenanceByLookup", () => {
  it("resolves each variant via the accessor (nested attrs, split inputs/metadata)", () => {
    const bag: Record<string, string> = { scorecardId: "sc", dataset: "ds" };
    expect(provenanceByLookup((k) => bag[k])).toEqual({ scorecardId: "sc", dataset: "ds" });
  });
});

describe("mlflowTracesToSummaries provenance", () => {
  it("surfaces provenance from trace_metadata + the run_id tag on the list row", () => {
    const [summary] = mlflowTracesToSummaries([
      {
        trace_id: "tr1",
        trace_metadata: { "everdict.scorecardId": "sc1", "everdict.harness": "hn1", "everdict.dataset": "ds1" },
        tags: { "everdict.run_id": "run1" },
      },
    ]);
    expect(summary?.provenance).toEqual({ runId: "run1", scorecardId: "sc1", dataset: "ds1", harness: "hn1" });
  });

  it("omits provenance for an unrelated MLflow trace", () => {
    const [summary] = mlflowTracesToSummaries([{ trace_id: "tr2", tags: { "mlflow.traceName": "chat" } }]);
    expect(summary?.provenance).toBeUndefined();
  });
});
