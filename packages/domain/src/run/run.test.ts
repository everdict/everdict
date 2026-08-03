import { ConflictError } from "@everdict/contracts";
import { RunRecordSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Run, attachChannelsFor } from "./run.js";

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

  it("keeps the child gate as domain law, and announces initiator-less completions without personal targeting (E2 widening)", () => {
    // A scorecard child is represented by the batch's own facts (flood prevention).
    const child = Run.from({ ...queued({ submittedBy: "alice" }), parentScorecardId: "sc-1" });
    expect(child.succeed(RESULT, "t1").facts).toEqual([]);
    // A machine-fired completion is workspace news (the Mattermost consumer posts it) — but with no known
    // initiator there is nobody to bell: the fact carries no actor/recipient, so the feed consumer skips it.
    const machineFact = Run.from(queued()).succeed(RESULT, "t1").facts[0];
    expect(machineFact?.kind).toBe("run.completed");
    expect(machineFact?.actor).toBeUndefined();
    expect(machineFact?.recipient).toBeUndefined();
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

describe("Run — playground session cases (a test case inside a live harness session)", () => {
  const sessionCase = () =>
    Run.newSessionCase({
      id: "run-c1",
      tenant: "acme",
      harness: { id: "claude-code", version: "2.1.0" },
      sessionRunId: "sess-run-9",
      caseId: "task-1",
      task: "add a README",
      timeoutSec: 600,
      createdBy: "user-1",
      now: "2026-07-31T00:00:00.000Z",
    });

  it("stamps the universal-run shape: eval/interactive/task, grouped to the session, driver-placed, born running", () => {
    const record = sessionCase();
    expect(record).toMatchObject({
      status: "running",
      kind: "eval",
      class: "interactive",
      lifetime: "task",
      trigger: "playground",
      harness: { id: "claude-code", version: "2.1.0" },
      caseId: "task-1",
      group: { id: "sess-run-9", role: "case" },
      placement: { where: "driver", isolation: "container" },
      origin: { cause: "member", actor: "user-1" },
    });
    // The persisted case is the prompt shape — what was asked, never any secret value.
    expect(record.caseSpec).toEqual({
      id: "task-1",
      env: { kind: "prompt" },
      task: "add a README",
      graders: [],
      timeoutSec: 600,
      tags: [],
    });
  });

  it("announces run.submitted at creation (no parent scorecard — the standalone fact gate)", () => {
    const facts = Run.creationFacts(sessionCase());
    expect(facts.map((f) => f.kind)).toEqual(["run.submitted"]);
    expect(facts[0]?.recipient).toBe("user-1");
  });

  it("a driver-placed run is NEVER re-dispatched by boot recovery, even with a persisted caseSpec", () => {
    // Regression guard: recovery ② re-drives every active standalone run with a caseSpec through the
    // BACKEND lane — a playground case's compute was this process's own container, so re-dispatching its
    // prompt case to a backend would be wrong twice (no such job, and a duplicate run). Tombstone instead.
    expect(Run.from(sessionCase()).canRedispatch()).toBe(false);
    expect(() => Run.from(sessionCase()).redispatch("t")).toThrow(ConflictError);
  });

  it("settles through the standard terminal transitions with facts (succeed/fail)", () => {
    const done = Run.from(sessionCase()).succeed(RESULT, "t1");
    expect(done.patch.status).toBe("succeeded");
    expect(done.facts.map((f) => f.kind)).toEqual(["run.completed"]);
    const failed = Run.from(sessionCase()).fail({ code: "CANCELLED", message: "session closed" }, "t2");
    expect(failed.patch.status).toBe("failed");
    expect(failed.facts.map((f) => f.kind)).toEqual(["run.failed"]);
  });
});

describe("Run — agent activations on the ledger (P3)", () => {
  const agentRun = () =>
    Run.newAgentRun({
      id: "run-a1",
      tenant: "acme",
      agentId: "sentinel",
      agentVersion: "1.0.0",
      sessionId: "sess-1",
      eventKind: "scorecard.completed",
      eventId: "ev-7",
      createdBy: "alice",
      now: "2026-07-30T00:00:00.000Z",
    });

  it("newAgentRun is born RUNNING with the agent as the executable and the session as the group", () => {
    const record = agentRun();
    expect(record).toMatchObject({
      kind: "agent",
      class: "background",
      lifetime: "task",
      status: "running",
      harness: { id: "sentinel", version: "1.0.0" },
      caseId: "ev-7",
      trigger: "agent",
      origin: { cause: "event", eventKind: "scorecard.completed", eventId: "ev-7", actor: "alice" },
      group: { id: "sess-1", role: "turn" },
    });
    expect(() => RunRecordSchema.parse(record)).not.toThrow();
  });

  it("settleAgent maps completed/failed/cancelled onto the 4-status lifecycle with NO facts (the agent.run.* family still announces)", () => {
    expect(Run.from(agentRun()).settleAgent("completed", "done", "t1")).toEqual({
      patch: { status: "succeeded", updatedAt: "t1" },
      facts: [],
    });
    expect(Run.from(agentRun()).settleAgent("failed", "boom", "t1")).toEqual({
      patch: { status: "failed", error: { code: "AGENT_RUN_FAILED", message: "boom" }, updatedAt: "t1" },
      facts: [],
    });
    expect(Run.from(agentRun()).settleAgent("cancelled", "stopped", "t1")).toEqual({
      patch: { status: "failed", error: { code: "CANCELLED", message: "stopped" }, updatedAt: "t1" },
      facts: [],
    });
    expect(() => Run.from({ ...agentRun(), status: "succeeded" }).settleAgent("failed", "late", "t2")).toThrow();
  });
});

describe("attachChannelsFor — one rule for what an execution exposes", () => {
  it("gives a cluster-placed case logs AND a shell — the control plane can reach its container", () => {
    expect(attachChannelsFor({ kind: "eval", target: "nomad-seoul" })).toEqual(["logs", "terminal"]);
    expect(attachChannelsFor({ kind: "eval" })).toEqual(["logs", "terminal"]);
  });

  it("gives a self-hosted case logs ONLY — the runner pushes lines, nothing can shell back in", () => {
    expect(attachChannelsFor({ kind: "eval", target: "self:runner-1" })).toEqual(["logs"]);
  });

  it("gives an agent turn or an analysis nothing — there is no container to attach to", () => {
    expect(attachChannelsFor({ kind: "agent" })).toEqual([]);
    expect(attachChannelsFor({ kind: "analysis" })).toEqual([]);
  });

  it("treats an unstamped legacy run as an eval, which is what those rows were", () => {
    expect(attachChannelsFor({})).toEqual(["logs", "terminal"]);
  });
});
