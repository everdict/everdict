import { ConflictError } from "@everdict/contracts";
import { RunRecordSchema } from "@everdict/contracts";
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

  it("newQueued stamps the universal-run shape — kind/class/lifetime, origin, and runtime placement (P0)", () => {
    const record = queued({
      runtime: "self:dev",
      origin: { cause: "member", actor: "alice" },
    });
    // The ledger can now SAY what this activation is; nothing is enforced yet (that is the P4 gate).
    expect(record).toMatchObject({
      kind: "eval",
      class: "interactive", // a standalone submit is a person waiting
      lifetime: "task",
      origin: { cause: "member", actor: "alice" },
      placement: { where: "runtime", target: "self:dev" },
    });
    // No runtime → no placement claim (default backend stays unstated rather than guessed).
    expect(queued().placement).toBeUndefined();
    expect(RunRecordSchema.parse(record).kind).toBe("eval");
  });

  it("succeed and fail produce terminal store patches — and the facts describing them, born in the domain (E0)", () => {
    const run = Run.from(queued({ submittedBy: "alice" }));
    const done = run.succeed(RESULT, "t1");
    expect(done.patch).toEqual({ status: "succeeded", result: RESULT, updatedAt: "t1" });
    expect(done.facts).toMatchObject([
      { kind: "run.completed", subject: { type: "run", id: "r1" }, actor: "alice", recipient: "alice" },
    ]);
    const failed = run.fail({ code: "INTERNAL", message: "boom" }, "t1");
    expect(failed.patch).toMatchObject({ status: "failed" });
    expect(failed.facts[0]?.kind).toBe("run.failed");
  });

  it("keeps the inherited emission gates as domain law: children and initiator-less runs stay silent", () => {
    // A scorecard child is represented by the batch's own facts (flood prevention).
    const child = Run.from({ ...queued({ submittedBy: "alice" }), parentScorecardId: "sc-1" });
    expect(child.succeed(RESULT, "t1").facts).toEqual([]);
    // No known initiator → no terminal fact (today's notification-path behavior, preserved; widening = E2).
    expect(Run.from(queued()).succeed(RESULT, "t1").facts).toEqual([]);
    // Creation: standalone announces run.submitted; a child does not.
    expect(Run.creationFacts(queued({ submittedBy: "alice" }))[0]?.kind).toBe("run.submitted");
    expect(Run.creationFacts({ ...queued(), parentScorecardId: "sc-1" })).toEqual([]);
    // Adoption settles without a fact (the old path bypassed onComplete — preserved).
    expect(Run.from(queued({ submittedBy: "alice" })).adopt(RESULT, "t1").facts).toEqual([]);
  });

  it("start flips a queued run to running (compute began) and is refused once terminal", () => {
    // The onStarted hook (managed dispatch / self-hosted lease) drives this — it makes "waiting for a runner" (queued)
    // distinct from "executing" (running) so a fan-out parked behind one runner doesn't read as all-running.
    expect(Run.from(queued()).start("t1").patch).toEqual({ status: "running", updatedAt: "t1" });
    // Idempotent over an already-running record (a re-fire from spillover/speculation is a harmless no-op).
    expect(Run.from({ ...queued(), status: "running" }).start("t2").patch).toEqual({
      status: "running",
      updatedAt: "t2",
    });
    // A late lease flip must never resurrect a settled run.
    expect(() => Run.from({ ...queued(), status: "succeeded", result: RESULT }).start("t3")).toThrow(ConflictError);
  });

  it("a terminal run rejects every re-write — succeed, fail, adopt, redispatch, start all throw ConflictError", () => {
    const settled = Run.from({ ...queued(), status: "succeeded", result: RESULT });
    expect(settled.isTerminal()).toBe(true);
    expect(() => settled.succeed(RESULT, "t")).toThrow(ConflictError);
    expect(() => settled.fail({ code: "INTERNAL", message: "late" }, "t")).toThrow(ConflictError);
    expect(() => settled.adopt(RESULT, "t")).toThrow(ConflictError);
    expect(() => settled.redispatch("t")).toThrow(ConflictError);
    expect(() => settled.start("t")).toThrow(ConflictError);
  });

  it("adoption is legal only while the run is unsettled", () => {
    const live = Run.from({ ...queued(), status: "running" });
    expect(live.canAdopt()).toBe(true);
    expect(live.adopt(RESULT, "t").patch).toMatchObject({ status: "succeeded", result: RESULT });
    expect(Run.from({ ...queued(), status: "failed" }).canAdopt()).toBe(false);
  });

  it("redispatch requires a persisted caseSpec (legacy records keep the tombstone path)", () => {
    const legacy = queued();
    const { caseSpec: _dropped, ...withoutSpec } = legacy;
    expect(Run.from(withoutSpec).canRedispatch()).toBe(false);
    expect(Run.from(legacy).canRedispatch()).toBe(true);
    expect(Run.from(legacy).redispatch("t").patch).toEqual({ status: "running", updatedAt: "t" });
  });
});
