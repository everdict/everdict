import { ConflictError, type DelegateDeliveryMode, type DelegateState } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { interruptedFrom, planDelivery } from "./delivery.js";

const AT = "2026-09-17T12:00:00.000Z";
const running: DelegateState = { status: "running", turnRunId: "r1", startedAt: AT };
const idle: DelegateState = { status: "pending_init" };
const done: DelegateState = { status: "completed", at: AT };
const stopped: DelegateState = { status: "interrupted", at: AT, by: "dana", previous: "running" };

// ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────────────────────────────
//
// One door (`submit_sandbox_task`) answered one question — "is it busy?" — for three different intentions,
// and answered all of them with `409`. A supervisor with something to say to a working delegate had exactly
// two moves: wait for the turn to end, or close the session and lose the container. Neither is supervision.
describe("reaching a busy delegate is a question of timing, not a refusal", () => {
  it("delivers a plain message without starting or stopping anything", () => {
    expect(planDelivery(running, "message")).toEqual({ kind: "queue", startsTurn: false });
    expect(planDelivery(idle, "message")).toEqual({ kind: "queue", startsTurn: false });
  });

  // The arm the old 409 made unreachable: work handed to a delegate that is already working.
  it("queues a task for a running delegate instead of refusing it", () => {
    expect(planDelivery(running, "task")).toEqual({ kind: "queue", startsTurn: true });
  });

  it("starts a turn when the delegate is idle", () => {
    expect(planDelivery(idle, "task")).toEqual({ kind: "start" });
  });

  it("aborts the turn first only when asked to interrupt", () => {
    expect(planDelivery(running, "interrupt")).toEqual({ kind: "abortThenStart" });
  });

  // A finished delegate is IDLE, not gone. "That is nearly right, now do this" must not cost a new container
  // and a fresh clone — which is the whole reason `completed` is kept apart from `closed`.
  it("lets a completed delegate take a follow-up without reopening anything", () => {
    expect(planDelivery(done, "task")).toEqual({ kind: "start" });
    expect(planDelivery(stopped, "task")).toEqual({ kind: "start" });
  });
});

// A refusal that does not say WHICH ending happened leaves three completely different next moves looking
// alike: retry, open a new session, or go read the trajectory.
describe("an unreachable delegate is refused by name", () => {
  const cases: { state: DelegateState; matches: RegExp }[] = [
    { state: { status: "errored", at: AT, message: "container died" }, matches: /stopped with an error/ },
    { state: { status: "closed", at: AT }, matches: /was closed/ },
    {
      state: { status: "orphaned", since: AT, cause: "control plane restarted" },
      matches: /no longer held by this control plane \(control plane restarted\)/,
    },
  ];

  for (const { state, matches } of cases)
    it(`refuses every mode when ${state.status}, and the message names it`, () => {
      for (const mode of ["message", "task", "interrupt"] satisfies DelegateDeliveryMode[]) {
        expect(() => planDelivery(state, mode)).toThrow(ConflictError);
        expect(() => planDelivery(state, mode)).toThrow(matches);
      }
    });
});

describe("an interrupt records what it stopped", () => {
  it("names what the delegate was doing", () => {
    expect(interruptedFrom(running)).toBe("running");
    expect(interruptedFrom(done)).toBe("completed");
    expect(interruptedFrom(idle)).toBe("pending_init");
  });

  // Stopping something already stopped must not overwrite the account of what was ever running — that first
  // record is the one that explains the state the container was left in.
  it("keeps the original account when interrupted twice", () => {
    expect(interruptedFrom(stopped)).toBe("running");
  });

  it("refuses when there is no turn to stop, rather than inventing a previous state", () => {
    expect(() => interruptedFrom({ status: "closed", at: AT })).toThrow(/no turn to interrupt/);
  });
});
