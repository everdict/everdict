import { ConflictError } from "@everdict/core";
import { RunRecordSchema } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { Run } from "./run.js";

const CASE = {
  id: "c1",
  env: { kind: "repo" as const, source: { files: {} } },
  task: "do it",
  graders: [{ id: "steps" }],
  timeoutSec: 60,
  tags: [],
};

const RESULT = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo" as const, diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};

function queued(overrides: Partial<Parameters<typeof Run.newQueued>[0]> = {}) {
  return Run.newQueued({
    id: "r1",
    tenant: "acme",
    harness: { id: "scripted", version: "0" },
    evalCase: CASE,
    now: "2026-07-10T00:00:00.000Z",
    ...overrides,
  });
}

describe("Run — the run lifecycle domain model", () => {
  it("newQueued assembles a schema-valid queued record and is the only construction path", () => {
    const record = queued({ runtime: "self:dev", trigger: "mcp", submittedBy: "alice" });
    expect(() => RunRecordSchema.parse(record)).not.toThrow();
    expect(record).toMatchObject({ status: "queued", runtime: "self:dev", trigger: "mcp", createdBy: "alice" });
    expect(record.caseSpec).toEqual(CASE); // boot recovery's re-dispatch basis
  });

  it("succeed and fail produce terminal store patches from a live run", () => {
    const run = Run.from(queued());
    expect(run.succeed(RESULT, "t1")).toEqual({ status: "succeeded", result: RESULT, updatedAt: "t1" });
    expect(run.fail({ code: "INTERNAL", message: "boom" }, "t1")).toMatchObject({ status: "failed" });
  });

  it("a terminal run rejects every re-write — succeed, fail, adopt, redispatch all throw ConflictError", () => {
    const settled = Run.from({ ...queued(), status: "succeeded", result: RESULT });
    expect(settled.isTerminal()).toBe(true);
    expect(() => settled.succeed(RESULT, "t")).toThrow(ConflictError);
    expect(() => settled.fail({ code: "INTERNAL", message: "late" }, "t")).toThrow(ConflictError);
    expect(() => settled.adopt(RESULT, "t")).toThrow(ConflictError);
    expect(() => settled.redispatch("t")).toThrow(ConflictError);
  });

  it("adoption is legal only while the run is unsettled", () => {
    const live = Run.from({ ...queued(), status: "running" });
    expect(live.canAdopt()).toBe(true);
    expect(live.adopt(RESULT, "t")).toMatchObject({ status: "succeeded", result: RESULT });
    expect(Run.from({ ...queued(), status: "failed" }).canAdopt()).toBe(false);
  });

  it("redispatch requires a persisted caseSpec (legacy records keep the tombstone path)", () => {
    const legacy = queued();
    const { caseSpec: _dropped, ...withoutSpec } = legacy;
    expect(Run.from(withoutSpec).canRedispatch()).toBe(false);
    expect(Run.from(legacy).canRedispatch()).toBe(true);
    expect(Run.from(legacy).redispatch("t")).toEqual({ status: "running", updatedAt: "t" });
  });
});
