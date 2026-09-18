import type { DelegateState, DelegationBrief, RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { OutboxEvent, RunStore } from "../ports/run-store.js";
import { SandboxSessionService } from "./sandbox-session-service.js";

// ── DEFAUL-52: A DELEGATE'S REPORT OUTLIVES THE PROCESS THAT READ IT ─────────────────────────────────
//
// `readDelegateReport` parses REPORT.json out of the container at settle and writes it into
// `PlaygroundState`, an in-process Map. The run ROW survived a restart and what the delegate SAID did not —
// the same asymmetry DEFAUL-37 closed for the steering channel, one lane over. The cost was measured by
// building on it: `logRound { delegationRunId }` reads through this port, so after a redeploy a delegated
// round was REFUSED, and the supervisor's review window was bounded by a restart they do not control.
//
// ⚠️ THE RESTART IS THE SUBJECT, so these tests drive `read` on a service that does NOT hold the session —
// which is exactly what a fresh process is. A test that kept the session live could not see this defect at
// all: the live path has always worked.
//
// Seen RED before the row carried anything, with `read` on a fresh service answering:
//   "expected 'unknown' to be 'read'"  → the report is gone, and the round that names it is refused.

const BRIEF: DelegationBrief = {
  goal: "make the photo open",
  references: [],
  constraints: [],
  doneWhen: [
    { id: "opens", statement: "the photo opens" },
    { id: "tests", statement: "the suite is no worse" },
  ],
};

const REPORT = {
  summary: "Fixed the decoder; the suite is green.",
  answers: [{ criterionId: "opens", answer: "met" as const, how: "asserted" as const, gateRunIds: [] }],
  changes: [{ repository: "acme/widget", commits: [{ sha: "abc1234" }] }],
  gateRuns: [],
  blockers: [],
  questions: [],
};

// A row as the sandbox lane writes one, with whatever delegation half the case under test needs. Built by
// hand because the subject is what a LATER process reads back, and that process has only the row.
function row(delegation?: { brief: DelegationBrief; state?: DelegateState }): RunRecord {
  return {
    id: "sbx-1",
    tenant: "acme",
    harness: { id: "playground", version: "1.0.0" },
    caseId: "session",
    status: "running",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    kind: "sandbox",
    session: {
      image: "python:3.12-slim",
      ttlSec: 900,
      expiresAt: "2026-09-18T00:15:00.000Z",
      ...(delegation !== undefined ? { delegation } : {}),
    },
  } as RunRecord;
}

// A control plane that has the LEDGER and none of the live sessions — a process that restarted.
function freshProcess(record: RunRecord | undefined): SandboxSessionService {
  const store: Pick<RunStore, "get" | "update" | "create"> = {
    async get(id: string) {
      return record !== undefined && record.id === id ? record : undefined;
    },
    async update(_id: string, _patch: Partial<RunRecord>, _evts?: OutboxEvent[]) {
      return record;
    },
    async create() {},
  };
  return new SandboxSessionService({ store: store as RunStore, driver: undefined as never });
}

describe("a delegation read after the process that ran it is gone (DEFAUL-52)", () => {
  it("answers from the row — the same brief and report a live read would have given", async () => {
    const svc = freshProcess(
      row({ brief: BRIEF, state: { status: "completed", at: "2026-09-18T00:10:00.000Z", report: REPORT } }),
    );

    const read = await svc.read("acme", "sbx-1");

    expect(read.kind).toBe("read");
    if (read.kind !== "read") throw new Error("the row's copy must be readable");
    expect(read.value.status).toBe("completed");
    expect(read.value.report).toEqual(REPORT);
    // The JOIN KEY, which is the whole reason the brief is stored structured rather than as rendered prose.
    expect(read.value.brief.doneWhen.map((c) => c.id)).toEqual(["opens", "tests"]);
  });

  it("carries an `awaiting` delegate's report too — stopped on a question is a settlement", async () => {
    const asking = {
      ...REPORT,
      questions: [{ id: "where", question: "which screen?", why: "two readings", options: [] }],
    };
    const svc = freshProcess(
      row({ brief: BRIEF, state: { status: "awaiting", at: "2026-09-18T00:10:00.000Z", report: asking } }),
    );

    const read = await svc.read("acme", "sbx-1");
    if (read.kind !== "read") throw new Error("expected the row's copy");
    expect(read.value.status).toBe("awaiting");
    expect(read.value.report?.questions.map((q) => q.id)).toEqual(["where"]);
  });

  // ⚠️ THE THREE-WAY DISTINCTION (§2). These three are different facts and the caller acts differently on
  // each, so collapsing any two is the defect — not a tidiness question.
  it("tells `booted but never settled` apart from `never a delegation`", async () => {
    // Booted, and this control plane never saw it settle: the container died with the process that held it.
    // NOT `absent` (it WAS a delegation) and NOT an empty report (that reads as a delegate which answered
    // nothing). The round stays refused, which is the outcome that is correct here.
    const neverSettled = await freshProcess(row({ brief: BRIEF })).read("acme", "sbx-1");
    expect(neverSettled.kind).toBe("unknown");
    if (neverSettled.kind === "unknown") expect(neverSettled.reason).toMatch(/never recorded a settlement/);

    // Never a delegation at all — a shell session somebody named by mistake.
    expect((await freshProcess(row()).read("acme", "sbx-1")).kind).toBe("absent");

    // And a run this workspace does not have.
    expect((await freshProcess(undefined).read("acme", "sbx-1")).kind).toBe("absent");
  });

  it("answers another workspace nothing, even holding the row", async () => {
    const svc = freshProcess(
      row({ brief: BRIEF, state: { status: "completed", at: "2026-09-18T00:10:00.000Z", report: REPORT } }),
    );
    expect((await svc.read("other", "sbx-1")).kind).toBe("absent");
  });

  // A ledger that could not be read is not a delegation that produced nothing (protocol L2) — the refusal
  // must name the blip rather than the delegation.
  it("answers `unknown` when the ledger itself cannot be read", async () => {
    const store: Pick<RunStore, "get" | "update" | "create"> = {
      async get() {
        throw new Error("connection terminated unexpectedly");
      },
      async update() {
        return undefined;
      },
      async create() {},
    };
    const svc = new SandboxSessionService({ store: store as RunStore, driver: undefined as never });

    const read = await svc.read("acme", "sbx-1");
    expect(read.kind).toBe("unknown");
    if (read.kind === "unknown") expect(read.reason).toMatch(/reading delegation session/);
  });
});
