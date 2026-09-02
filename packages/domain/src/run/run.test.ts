import { ConflictError, type EvalCase } from "@everdict/contracts";
import { RunRecordSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Run, attachChannelsFor, canReadRun, runAudience } from "./run.js";
import { newScorecardChildRun } from "./scorecard-child.js";

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
    expect(done.facts).toMatchObject([{ kind: "run.completed", subject: { type: "run", id: "r1" }, actor: "alice" }]);
    const failed = run.fail({ code: "INTERNAL", message: "boom" }, "t1");
    expect(failed.patch).toMatchObject({ status: "failed" });
    expect(failed.facts[0]?.kind).toBe("run.failed");
  });

  it("keeps the child gate as domain law, and announces initiator-less completions without personal targeting (E2 widening)", () => {
    // A scorecard child is represented by the batch's own facts (flood prevention).
    const child = Run.from({ ...queued({ submittedBy: "alice" }), parentScorecardId: "sc-1" });
    expect(child.succeed(RESULT, "t1").facts).toEqual([]);
    // A machine-fired completion is workspace news (the Mattermost consumer posts it) — but with no known
    // initiator there is nobody to bell: the fact carries no actor, and the projector (fact-projection.ts)
    // derives no recipient from an actor-less fact — recipient left the DOMAIN fact entirely (review §25).
    const machineFact = Run.from(queued()).succeed(RESULT, "t1").facts[0];
    expect(machineFact?.kind).toBe("run.completed");
    expect(machineFact?.actor).toBeUndefined();
    // Creation: standalone announces run.submitted; a child does not.
    expect(Run.creationFacts(queued({ submittedBy: "alice" }))[0]?.kind).toBe("run.submitted");
    expect(Run.creationFacts({ ...queued(), parentScorecardId: "sc-1" })).toEqual([]);
    // Adoption announces the SAME terminal fact a normal settle does (arch-review 34 P1). It used to emit
    // none — behaviour-preserving until the run's completion callback started hanging off that fact, and then
    // it meant a run adopted by a REPLACEMENT control plane ended without telling anybody: silence for
    // exactly the runs the durable callback was built for.
    const adoptFact = Run.from(queued({ submittedBy: "alice" })).adopt(RESULT, "t1").facts[0];
    expect(adoptFact?.kind).toBe("run.completed");
    expect(adoptFact?.actor).toBe("alice");
    // …and a CHILD still announces nothing: a scorecard's case is the scorecard's news, not its own.
    expect(Run.from({ ...queued(), parentScorecardId: "sc-1" }).adopt(RESULT, "t1").facts).toEqual([]);
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
    // The push target is the PROJECTOR's derivation now (recipient = actor for run.* kinds) — the domain
    // fact carries only the semantic actor.
    expect(facts[0]?.actor).toBe("user-1");
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

  it("a conversation turn groups with role 'turn' and can carry the session's runtime placement", () => {
    const turn = Run.newSessionCase({
      id: "run-t1",
      tenant: "acme",
      harness: { id: "aegra", version: "1.0.0" },
      sessionRunId: "sess-run-9",
      caseId: "turn-2",
      task: "and what did I ask before?",
      timeoutSec: 120,
      createdBy: "user-1",
      role: "turn",
      placement: { where: "runtime", target: "nomad-seoul", isolation: "container" },
      now: "2026-08-06T00:00:00.000Z",
    });
    expect(turn.group).toEqual({ id: "sess-run-9", role: "turn" });
    expect(turn.placement).toEqual({ where: "runtime", target: "nomad-seoul", isolation: "container" });
    expect(() => RunRecordSchema.parse(turn)).not.toThrow();
  });

  it("a runtime-placed conversation turn is NEVER re-dispatched by boot recovery", () => {
    // Regression guard: turns escaped the driver-placement exclusion once they carried the session's runtime
    // placement — but a turn's continuity (resume token / session wiring) lives in the session process, so
    // recovery re-driving it standalone would replay one turn against a dead conversation. Orphan-settle instead.
    const turn = Run.newSessionCase({
      id: "run-t2",
      tenant: "acme",
      harness: { id: "aegra", version: "1.0.0" },
      sessionRunId: "sess-run-9",
      caseId: "turn-3",
      task: "continue",
      timeoutSec: 120,
      createdBy: "user-1",
      role: "turn",
      placement: { where: "runtime", target: "nomad-seoul", isolation: "container" },
      now: "2026-08-06T00:00:00.000Z",
    });
    expect(Run.from(turn).canRedispatch()).toBe(false);
    expect(() => Run.from(turn).redispatch("t")).toThrow(ConflictError);
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

  it("records the EXECUTOR as a creation-time fact — createdBy stays the principal, never re-derived", () => {
    // Regression (O1): the actor was inferred from createdBy (the member the run acts AS), so checkpoint
    // independence compared member:kim against agent:fixer — namespaces that never collide — and the very
    // agent that produced a run could verify it. The executor is recorded where the run is born.
    expect(agentRun().origin?.executor).toBe("agent:sentinel");
    const turn = Run.newChatTurn({
      id: "r1",
      tenant: "acme",
      agentId: "helper",
      sessionId: "s1",
      actor: "alice",
      now: "2026-08-03T00:00:00.000Z",
    });
    expect(turn.origin?.executor).toBe("agent:helper");
    expect(turn.createdBy).toBe("alice");
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

describe("runAudience — one rule for who may read an execution", () => {
  it("keeps a chat turn for the member who typed it", () => {
    const record = Run.newChatTurn({
      id: "r1",
      tenant: "acme",
      agentId: "default",
      sessionId: "s1",
      actor: "alice",
      now: "2026-08-03T00:00:00.000Z",
    });
    expect(runAudience(record)).toEqual({ scope: "member", subject: "alice" });
    expect(canReadRun(record, "alice")).toBe(true);
    expect(canReadRun(record, "bob")).toBe(false);
  });

  it("opens a headless activation to the workspace — the run row answers like its session door", () => {
    // Regression (O2): the activation's session is created visibility:"workspace" by design (fleet
    // observability), but the run row inferred "personal" from the agent kind — one activation, two
    // audiences. The class the factory stamps (background) is the recorded fact the decision reads.
    const record = Run.newAgentRun({
      id: "r2",
      tenant: "acme",
      agentId: "watcher",
      sessionId: "s2",
      eventKind: "issue.created",
      createdBy: "alice",
      now: "2026-08-03T00:00:00.000Z",
    });
    expect(record.class).toBe("background");
    expect(runAudience(record)).toEqual({ scope: "workspace" });
    expect(canReadRun(record, "bob")).toBe(true);
  });

  it("the DECLARED visibility outranks the class — privacy is not a scheduling knob", () => {
    // A future background personal assistant stays its member's; a hypothetical workspace-declared sandbox
    // opens. The factories stamp the fact; the class inference survives only for unstamped legacy rows.
    expect(
      runAudience({
        kind: "agent",
        class: "background",
        visibility: "member",
        createdBy: "alice",
        origin: { cause: "event", actor: "alice" },
      }),
    ).toEqual({ scope: "member", subject: "alice" });
    expect(runAudience({ kind: "sandbox", visibility: "workspace", createdBy: "alice" })).toEqual({
      scope: "workspace",
    });
    // The factories declare: activation=workspace, chat turn=member.
    expect(
      Run.newAgentRun({
        id: "r",
        tenant: "t",
        agentId: "watcher",
        sessionId: "s",
        eventKind: "issue.created",
        createdBy: "alice",
        now: "t0",
      }).visibility,
    ).toBe("workspace");
    expect(
      Run.newChatTurn({ id: "r", tenant: "t", agentId: "a", sessionId: "s", actor: "alice", now: "t0" }).visibility,
    ).toBe("member");
  });

  it("keeps a LEGACY classless agent row personal — rows that never declared themselves read conservatively", () => {
    const legacy = { kind: "agent" as const, createdBy: "alice", origin: { cause: "member" as const, actor: "alice" } };
    expect(runAudience(legacy)).toEqual({ scope: "member", subject: "alice" });
  });

  it("keeps a sandbox session for whoever is at the shell", () => {
    const record = Run.newSandboxSession({
      id: "r3",
      tenant: "acme",
      harness: { id: "ubuntu", version: "adhoc" },
      image: "ubuntu:24.04",
      ttlSec: 600,
      createdBy: "alice",
      now: "2026-08-03T00:00:00.000Z",
    });
    expect(runAudience(record)).toEqual({ scope: "member", subject: "alice" });
    expect(canReadRun(record, "bob")).toBe(false);
  });

  it("leaves eval work to the workspace — an eval is what the team is here to read", () => {
    expect(runAudience(queued({ submittedBy: "alice" }))).toEqual({ scope: "workspace" });
    expect(canReadRun(queued({ submittedBy: "alice" }), "bob")).toBe(true);
  });

  it("leaves an OWNERLESS personal run to the workspace — hiding it from everyone is loss, not privacy", () => {
    expect(runAudience({ kind: "agent" })).toEqual({ scope: "workspace" });
    expect(canReadRun({ kind: "agent" }, "bob")).toBe(true);
  });

  it("treats an unstamped legacy row as an eval, which is what those rows were", () => {
    expect(runAudience({ createdBy: "alice" })).toEqual({ scope: "workspace" });
  });
});

describe("Run — agent worlds (W1): session snapshots and touch", () => {
  const world = () =>
    Run.newSandboxSession({
      id: "w1",
      tenant: "acme",
      harness: { id: "proj", version: "genesis" },
      image: "debian:stable",
      ttlSec: 900,
      createdBy: "alice",
      world: "proj",
      hibernate: true,
      now: "2026-08-03T00:00:00.000Z",
    });

  it("a world session carries world + hibernate on its session half (the crash-path reaper reads the row alone)", () => {
    const record = world();
    expect(record.session).toMatchObject({ world: "proj", hibernate: true });
    expect(RunRecordSchema.parse(record)).toBeTruthy(); // the wire schema knows the new fields
  });

  it("a session can join a different pool (trigger) and declare conversation mode on its session half", () => {
    const record = Run.newSandboxSession({
      id: "fd1",
      tenant: "acme",
      harness: { id: "aegra", version: "1.0.0" },
      image: "aegra@1.0.0",
      ttlSec: 900,
      createdBy: "alice",
      trigger: "frontdoor",
      conversation: true,
      runtime: "nomad-seoul",
      attach: ["tasks"],
      now: "2026-08-06T00:00:00.000Z",
    });
    expect(record.trigger).toBe("frontdoor"); // its own capacity pool — never counted against shell sandboxes
    expect(record.session).toMatchObject({ conversation: true });
    expect(record.session?.computeId).toBeUndefined(); // nothing for Driver.reap — the reaper settles row-only
    expect(record.placement).toEqual({ where: "runtime", target: "nomad-seoul", isolation: "container" });
    expect(RunRecordSchema.parse(record)).toBeTruthy();
  });

  it("recordSnapshot appends to session.snapshots and announces run.snapshotted (subject run, actor = creator)", () => {
    const record = world();
    const transition = Run.from(record).recordSnapshot({
      world: "proj",
      version: "1.0.0",
      image: "reg.local/acme-ns/proj:v1@sha256:abc",
      now: "2026-08-03T01:00:00.000Z",
    });
    expect(transition.patch.session?.snapshots).toEqual([
      { version: "1.0.0", image: "reg.local/acme-ns/proj:v1@sha256:abc", at: "2026-08-03T01:00:00.000Z" },
    ]);
    expect(transition.facts).toHaveLength(1);
    expect(transition.facts[0]).toMatchObject({
      kind: "run.snapshotted",
      subject: { type: "run", id: "w1" },
      actor: "alice",
      payload: { world: "proj", version: "1.0.0" },
    });
    // A second snapshot appends — the session half is the session's own snapshot history.
    const twice = Run.from({ ...record, ...transition.patch }).recordSnapshot({
      world: "proj",
      version: "1.0.1",
      image: "reg.local/acme-ns/proj:v2@sha256:def",
      now: "2026-08-03T02:00:00.000Z",
    });
    expect(twice.patch.session?.snapshots).toHaveLength(2);
  });

  it("extendSession pushes the deadline OUT and never pulls it in; both refuse a non-session or terminal run", () => {
    const record = world(); // expires 00:15
    const extended = Run.from(record).extendSession(1800, "2026-08-03T00:05:00.000Z");
    expect(extended.patch.session?.expiresAt).toBe("2026-08-03T00:35:00.000Z");
    expect(extended.facts).toEqual([]); // upkeep is not news

    const shorter = Run.from(record).extendSession(60, "2026-08-03T00:05:00.000Z"); // proposed 00:06 < 00:15
    expect(shorter.patch.session?.expiresAt).toBe("2026-08-03T00:15:00.000Z");

    expect(() => Run.from(queued()).recordSnapshot({ world: "w", version: "1", image: "i", now: "t" })).toThrow(
      ConflictError,
    );
    expect(() => Run.from(queued()).extendSession(60, "t")).toThrow(ConflictError);
    const closed = { ...record, ...Run.from(record).closeSession("closed", "2026-08-03T00:10:00.000Z").patch };
    expect(() => Run.from(closed).extendSession(60, "t")).toThrow(ConflictError);
  });
});

// ── A PRODUCER MAY NOT NAME ITS OWN AUTHORITY (counterexample) ───────────────────────────────────────
//
// `evaluateVerdict` ranks scores by metric NAME against the stamped policy, whose default ladder gives
// `state` / `tests_pass` ground truth. `safeGrade` refuses a grader that names a reserved metric its spec
// never declared — inside the job, which on the self-hosted lane is the producer's own machine. Nothing asked
// again at the control plane, so a runner could submit `state: 1` and outrank every judge on the case, and
// that verdict flowed into the trials, the round and the adoption proof.
//
// The seam is the domain transition every settlement lane ends in. Three writers (`succeed`, `fail`,
// boot-recovery `adopt`) and the recovery one is asserted explicitly: its bytes come from a process this one
// never watched, and a check that covered `succeed` alone would have left it as the residue.
//
// Seen RED with `settled()` neutralized to return its input, observed:
//   expected 'invalid' — a forged ground-truth score stayed measured and decided the case.
describe("[COUNTEREXAMPLE] a score claims only the authority its declared grader owns", () => {
  const forged = { graderId: "runner", metric: "state", value: 1, pass: true };
  const builtIn = { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true };
  const withGraders = (graders: EvalCase["graders"]) => Run.from(queued({ evalCase: { ...CASE, graders } }));
  // A batch child persists no case of its own (scorecard-child.ts): its declaration arrives with the settle.
  const child = () =>
    Run.from(
      newScorecardChildRun({
        id: "child",
        tenant: "acme",
        harness: { id: "h", version: "1" },
        caseId: "c1",
        parentScorecardId: "sc",
        now: "t0",
      }),
    );

  it("succeed: a reserved metric no grader declared becomes a visible invalid row", () => {
    const done = withGraders([]).succeed({ ...RESULT, scores: [forged] }, "t1");
    const score = done.patch.result?.scores[0];
    expect(score?.status, "a forged ground-truth score stayed measured and decided the case").toBe("invalid");
  });

  it("succeed: the built-in that owns the name, declared on the case, stays measured", () => {
    const done = withGraders([{ id: "tests-pass" }]).succeed({ ...RESULT, scores: [builtIn] }, "t1");
    expect(done.patch.result?.scores[0], "the built-in's own name was refused as a forgery").toMatchObject({
      metric: "tests_pass",
      value: 1,
    });
  });

  it("succeed: DECLARING a reserved name does not acquire it — the wildcard arch-review 20 closed stays closed", () => {
    const done = withGraders([{ id: "runner", metrics: [{ id: "state" }] }]).succeed(
      { ...RESULT, scores: [forged] },
      "t1",
    );
    expect(done.patch.result?.scores[0]?.status, "a declaration granted a constitutional name at the settle").toBe(
      "invalid",
    );
  });

  it("a batch child is settled against the sealed plan's declaration its committer hands over", () => {
    const done = child().succeed({ ...RESULT, scores: [builtIn] }, "t1", [{ id: "tests-pass" }]);
    expect(done.patch.result?.scores[0]).toMatchObject({ metric: "tests_pass", value: 1 });
  });

  it("…and with no declaration at all it reads fail-closed: the reserved name is a forgery", () => {
    const done = child().succeed({ ...RESULT, scores: [builtIn] }, "t1");
    expect(done.patch.result?.scores[0]?.status, "an undeclared reserved name passed on a child").toBe("invalid");
  });

  it("a run that persists its case refuses a caller-supplied declaration — two readers of one fact", () => {
    expect(() => withGraders([]).succeed({ ...RESULT, scores: [builtIn] }, "t1", [{ id: "tests-pass" }])).toThrow(
      /settled against that declaration alone/,
    );
  });

  it("adopt (boot recovery) asks the same question — the lane whose bytes nobody watched", () => {
    const adopted = withGraders([]).adopt({ ...RESULT, scores: [forged] }, "t1");
    expect(adopted.patch.result?.scores[0]?.status, "the recovery lane skipped the authority check").toBe("invalid");
    const recovered = child().adopt({ ...RESULT, scores: [builtIn] }, "t1", [{ id: "tests-pass" }]);
    expect(recovered.patch.result?.scores[0]?.status).toBeUndefined();
  });

  it("fail carries its result through the same seam", () => {
    const failed = withGraders([]).fail({ code: "X", message: "boom" }, "t1", { ...RESULT, scores: [forged] });
    expect(failed.patch.result?.scores[0]?.status).toBe("invalid");
  });
});
