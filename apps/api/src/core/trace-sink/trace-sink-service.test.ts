import { BadRequestError, type CaseResult } from "@everdict/core";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import type { TraceSinkConfig } from "@everdict/trace";
import { describe, expect, it } from "vitest";
import { TraceSinkService } from "./trace-sink-service.js";

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [{ t: 0, kind: "llm_call", model: "m" }],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "x" },
  scores: [
    { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true },
    { graderId: "judge", metric: "judge:q", value: 0.7, detail: "rationale" },
  ],
};
const CTX = { scorecardId: "sc-1", dataset: "d@1", harness: "h@1" };

describe("TraceSinkService — multiple-sink CRUD + per-harness selection", () => {
  it("upsert by name registers/updates multiple sinks and lists them", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000", project: "7" });
    await svc.upsert("acme", { name: "lf", kind: "langfuse", endpoint: "https://lf.corp.io" });
    // upsert with the same name = replace (declarative).
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow2:5000" });
    const { sinks } = await svc.list("acme");
    expect(sinks.map((s) => s.name).sort()).toEqual(["lf", "mlf"]);
    expect(sinks.find((s) => s.name === "mlf")?.endpoint).toBe("http://mlflow2:5000");
    expect(sinks.find((s) => s.name === "mlf")?.project).toBeUndefined(); // full replace — the previous project is not carried over
  });

  it("per-harness selection: can only point to a registered sink (400 if missing), null clears the selection", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await expect(svc.assign("acme", "h1", "no-such-sink")).rejects.toBeInstanceOf(BadRequestError);
    expect(await svc.assign("acme", "h1", "mlf")).toEqual({ h1: "mlf" });
    expect(await svc.assign("acme", "h2", "mlf")).toEqual({ h1: "mlf", h2: "mlf" });
    expect(await svc.assign("acme", "h1", null)).toEqual({ h2: "mlf" }); // cleared
  });

  it("removing a sink also clears harness selections that pointed to it (prevents dangling) + workspace isolation", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await svc.upsert("acme", { name: "lf", kind: "langfuse", endpoint: "https://lf" });
    await svc.assign("acme", "h1", "mlf");
    await svc.assign("acme", "h2", "lf");
    await svc.upsert("globex", { name: "mlf", kind: "mlflow", endpoint: "http://other:5000" });
    await svc.remove("acme", "mlf");
    const acme = await svc.list("acme");
    expect(acme.sinks.map((s) => s.name)).toEqual(["lf"]);
    expect(acme.assignments).toEqual({ h2: "lf" }); // only h1, which pointed to mlf, is cleared
    expect((await svc.list("globex")).sinks).toHaveLength(1); // tenant isolation
  });
});

// service with harness h having selected the mlf sink + a capturing fake buildSink.
async function exportHarness(over: {
  sinkResult?: { url?: string; cases: Array<{ caseId: string; externalId?: string; error?: string }> };
  throwOnExport?: boolean;
  secrets?: Record<string, string>;
  authSecretName?: string;
  assignTo?: string | null; // defaults to "h" (the id of CTX.harness). null = no selection
}) {
  const store = new InMemoryWorkspaceSettingsStore();
  const captured: { cfg?: TraceSinkConfig; cases?: Array<{ caseId: string; externalId?: string }> } = {};
  const svc = new TraceSinkService(store, {
    secretsFor: async () => over.secrets ?? {},
    buildSink: (cfg) => {
      captured.cfg = cfg;
      return {
        async export(_ctx, cases) {
          if (over.throwOnExport) throw new Error("upstream connection failed");
          captured.cases = cases.map((c) => ({
            caseId: c.caseId,
            ...(c.externalId ? { externalId: c.externalId } : {}),
          }));
          // the service calls per case (streaming) — the fixed sinkResult returns only this call's slice of cases.
          if (over.sinkResult)
            return {
              ...(over.sinkResult.url ? { url: over.sinkResult.url } : {}),
              cases: over.sinkResult.cases.filter((rc) => cases.some((c) => c.caseId === rc.caseId)),
            };
          return { cases: cases.map((c) => ({ caseId: c.caseId, externalId: `ext-${c.caseId}` })) };
        },
      };
    },
    now: () => "2026-07-06T00:00:00.000Z",
  });
  await svc.upsert("acme", {
    name: "mlf",
    kind: "mlflow",
    endpoint: "http://mlflow:5000",
    project: "7",
    ...(over.authSecretName ? { authSecretName: over.authSecretName } : {}),
  });
  if (over.assignTo !== null) await svc.assign("acme", over.assignTo ?? "h", "mlf");
  return { svc, captured };
}

describe("TraceSinkService.exportScorecard — resolving the per-harness selection", () => {
  it("resolves the sink selected by ctx.harness's id, exports, and records the sink name in the outcome", async () => {
    const { svc, captured } = await exportHarness({
      authSecretName: "MLFLOW_AUTH",
      secrets: { MLFLOW_AUTH: "Basic x" },
    });
    const out = await svc.exportScorecard("acme", CTX, [RESULT]);
    expect(captured.cfg).toMatchObject({
      kind: "mlflow",
      endpoint: "http://mlflow:5000",
      auth: "Basic x",
      project: "7",
    });
    expect(out?.status).toBe("succeeded");
    expect(out?.name).toBe("mlf"); // records which sink it was
    expect(out?.cases?.[0]?.externalId).toBe("ext-c1");
  });

  it("if the harness has selected no sink, it is a no-op (undefined) — export is opt-in", async () => {
    const { svc } = await exportHarness({ assignTo: null });
    expect(await svc.exportScorecard("acme", CTX, [RESULT])).toBeUndefined();
  });

  it("a per-batch sinkOverride selects the named sink even when the harness selected nothing", async () => {
    const { svc, captured } = await exportHarness({ assignTo: null }); // no harness selection at all
    const out = await svc.exportScorecard("acme", { ...CTX, sinkOverride: "mlf" }, [RESULT]);
    expect(out?.status).toBe("succeeded");
    expect(out?.name).toBe("mlf");
    expect(captured.cases?.[0]?.caseId).toBe("c1");
  });

  it('a per-batch sinkOverride of "none" suppresses export even when the harness selected a sink', async () => {
    const { svc } = await exportHarness({}); // harness h HAS mlf selected
    expect(await svc.exportScorecard("acme", { ...CTX, sinkOverride: "none" }, [RESULT])).toBeUndefined();
  });

  it("an unknown sinkOverride name is a no-op stream (submit-time validation is the real gate)", async () => {
    const { svc } = await exportHarness({});
    expect(await svc.exportScorecard("acme", { ...CTX, sinkOverride: "ghost" }, [RESULT])).toBeUndefined();
  });

  it("another harness's selection does not apply to this harness (per-harness isolation)", async () => {
    const { svc } = await exportHarness({ assignTo: "other-harness" });
    expect(await svc.exportScorecard("acme", CTX, [RESULT])).toBeUndefined();
  });

  it("a missing secret value for authSecretName yields a failed outcome (honest failure — no silent unauthenticated call)", async () => {
    const { svc } = await exportHarness({ authSecretName: "MISSING", secrets: {} });
    const out = await svc.exportScorecard("acme", CTX, [RESULT]);
    expect(out?.status).toBe("failed");
    expect(out?.message).toContain("MISSING");
  });

  it("attach passes externalId only when the source and sink platforms match; otherwise it falls back to create mode", async () => {
    const { svc, captured } = await exportHarness({});
    await svc.exportScorecard("acme", CTX, [RESULT], { sourceKind: "mlflow", externalIdByCase: { c1: "tr-orig" } });
    expect(captured.cases?.[0]?.externalId).toBe("tr-orig"); // mlflow=mlflow → attach

    const { svc: svc2, captured: cap2 } = await exportHarness({});
    await svc2.exportScorecard("acme", CTX, [RESULT], { sourceKind: "otel", externalIdByCase: { c1: "tr-orig" } });
    expect(cap2.cases?.[0]?.externalId).toBeUndefined(); // otel≠mlflow → create
  });

  it("some case failures → partial, an adapter throw → failed — it never throws (isolation contract)", async () => {
    const { svc } = await exportHarness({
      sinkResult: {
        cases: [
          { caseId: "c1", externalId: "e1" },
          { caseId: "c2", error: "500" },
        ],
      },
    });
    const partial = await svc.exportScorecard("acme", CTX, [RESULT, { ...RESULT, caseId: "c2" }]);
    expect(partial?.status).toBe("partial");
    expect(partial?.message).toContain("1/2");

    const { svc: svc2 } = await exportHarness({ throwOnExport: true });
    const failed = await svc2.exportScorecard("acme", CTX, [RESULT]);
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toContain("upstream connection failed");
  });
});

describe("TraceSinkService.exportStream — case streaming (D5)", () => {
  it("push fires per case immediately without waiting for settle, and settle aggregates into the existing outcome shape", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    const calls: string[][] = []; // case composition per call — must be an individual call per case
    const svc = new TraceSinkService(store, {
      buildSink: () => ({
        async export(_ctx, cases) {
          calls.push(cases.map((c) => c.caseId));
          return {
            url: "http://mlflow/#/experiments/7",
            cases: cases.map((c) => ({ caseId: c.caseId, externalId: `ext-${c.caseId}` })),
          };
        },
      }),
      now: () => "2026-07-07T00:00:00.000Z",
    });
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await svc.assign("acme", "h", "mlf");

    const stream = await svc.exportStream("acme", CTX);
    if (!stream) throw new Error("a sink is selected, so a stream must exist");
    stream.push(RESULT);
    await new Promise((r) => setTimeout(r, 0)); // task-fire tick
    expect(calls).toEqual([["c1"]]); // already sent before settle — the essence of streaming
    stream.push({ ...RESULT, caseId: "c2" });

    const out = await stream.settle();

    expect(calls).toEqual([["c1"], ["c2"]]); // an individual call per case
    expect(out.status).toBe("succeeded");
    expect(out.url).toBe("http://mlflow/#/experiments/7");
    expect(out.cases?.map((c) => c.caseId)).toEqual(["c1", "c2"]);
  });

  it("per-case failures are isolated — one case's upstream error does not block others and aggregates to partial", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    const svc = new TraceSinkService(store, {
      buildSink: () => ({
        async export(_ctx, cases) {
          const id = cases[0]?.caseId ?? "?";
          if (id === "c1") throw new Error("c1 only: upstream 500");
          return { cases: cases.map((c) => ({ caseId: c.caseId, externalId: `ext-${c.caseId}` })) };
        },
      }),
      now: () => "2026-07-07T00:00:00.000Z",
    });
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await svc.assign("acme", "h", "mlf");

    const stream = await svc.exportStream("acme", CTX);
    if (!stream) throw new Error("expected a stream");
    stream.push(RESULT); // c1 — fails
    stream.push({ ...RESULT, caseId: "c2" }); // c2 — succeeds
    const out = await stream.settle();

    expect(out.status).toBe("partial");
    expect(out.message).toContain("1/2");
    expect(out.cases?.find((c) => c.caseId === "c1")?.error).toContain("upstream 500");
    expect(out.cases?.find((c) => c.caseId === "c2")?.externalId).toBe("ext-c2");
  });
});
