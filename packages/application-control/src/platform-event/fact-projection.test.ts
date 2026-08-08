import type { DomainFact } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { projectRecipient, renderFactMessage } from "./fact-projection.js";
import { stampFacts } from "./outbox.js";

// C13 (review §25): the domain states WHAT happened; this projector decides how a person reads it. The
// renderings must reproduce the previously domain-authored templates byte-for-byte — the persisted log's
// wording is consumed (Mattermost pass-through, activity-feed fallbacks), so the move must not rewrite
// history's voice.

const fact = (kind: DomainFact["kind"], id: string, payload: Record<string, unknown>, actor?: string): DomainFact => ({
  kind,
  subject: { type: kind.split(".")[0] ?? "x", id },
  ...(actor !== undefined ? { actor } : {}),
  payload,
});

describe("renderFactMessage — the one place a fact becomes a sentence", () => {
  it("reproduces the run/scorecard templates byte-for-byte", () => {
    expect(renderFactMessage(fact("run.submitted", "r1", { harness: "cc@1.0.0", caseId: "case-1" }))).toBe(
      "Run r1 submitted — cc@1.0.0 (case case-1)",
    );
    expect(
      renderFactMessage(fact("run.completed", "r1", { status: "succeeded", harness: "cc@1.0.0", caseId: "case-1" })),
    ).toBe("Run r1 succeeded — cc@1.0.0 (case case-1)");
    expect(
      renderFactMessage(
        fact("scorecard.completed", "sc1", { status: "succeeded", dataset: "d@1.0.0", harness: "h@1", passRate: 0.5 }),
      ),
    ).toBe("Scorecard sc1 succeeded — d@1.0.0 × h@1 (pass rate 50%)");
    expect(
      renderFactMessage(fact("scorecard.submitted", "sc1", { dataset: "d@1.0.0", harness: "h@1", cases: 3 })),
    ).toBe("Scorecard sc1 submitted — d@1.0.0 × h@1 (3 cases)");
    expect(renderFactMessage(fact("scorecard.cancelled", "sc1", { dataset: "d@1.0.0", harness: "h@1" }))).toBe(
      "Scorecard sc1 cancelled — d@1.0.0 × h@1",
    );
    expect(
      renderFactMessage(
        fact("scorecard.scored", "sc1", { dataset: "d@1.0.0", harness: "h@1", passRate: 1, promoted: true }),
      ),
    ).toBe("Scorecard sc1 scored — d@1.0.0 × h@1 (pass rate 100%) (promoted from experiment)");
  });

  it("reproduces the tracker templates byte-for-byte", () => {
    expect(
      renderFactMessage(
        fact("issue.status_changed", "i1", { identifier: "ENG-1", from: "backlog", to: "in_progress", title: "T" }),
      ),
    ).toBe("ENG-1 backlog → in_progress — T");
    expect(renderFactMessage(fact("issue.status_changed", "i1", { identifier: "ENG-1", triage: "accepted" }))).toBe(
      "ENG-1 accepted from triage",
    );
    expect(renderFactMessage(fact("issue.created", "i1", { identifier: "ENG-1", title: "T" }))).toBe("ENG-1 filed — T");
    expect(renderFactMessage(fact("team.member_added", "t1", { member: "alice", name: "Engineering" }))).toBe(
      "alice joined Engineering",
    );
    expect(renderFactMessage(fact("cycle.completed", "c1", { number: 3, carriedOver: 2 }))).toBe(
      "Cycle 3 closed — 2 carried over",
    );
    expect(renderFactMessage(fact("project.update_posted", "p1", { name: "P", health: "at_risk" }))).toBe(
      "P — at risk",
    );
    expect(
      renderFactMessage(fact("approval.decided", "a1", { decision: "expired", tool: "write_file", sessionId: "s1" })),
    ).toBe("Agent approval expired — write_file (session s1)");
  });

  it("a kind with no template still reads as SOMETHING — a fact must never be unreadable", () => {
    expect(renderFactMessage(fact("agent.run.started", "s1", {}))).toBe("agent.run.started — agent s1");
  });
});

describe("projectRecipient — whose bell rings is the projector's decision", () => {
  it("targets the actor for the personal run/scorecard kinds, nobody otherwise", () => {
    expect(projectRecipient(fact("run.completed", "r1", {}, "alice"))).toBe("alice");
    expect(projectRecipient(fact("scorecard.submitted", "sc1", {}, "alice"))).toBe("alice");
    expect(projectRecipient(fact("run.completed", "r1", {}))).toBeUndefined(); // machine-fired — nobody to bell
    expect(projectRecipient(fact("issue.created", "i1", {}, "alice"))).toBeUndefined(); // workspace news
  });
});

describe("stampFacts — projection happens at the one stamping choke point", () => {
  const ids = { newId: () => "ev-1", now: () => "t1" };

  it("renders the message and derives the recipient for a domain fact", () => {
    const [stamped] = stampFacts(
      "acme",
      [fact("run.completed", "r1", { status: "succeeded", harness: "cc@1", caseId: "c" }, "alice")],
      ids,
    );
    expect(stamped?.record.message).toBe("Run r1 succeeded — cc@1 (case c)");
    expect(stamped?.recipient).toBe("alice");
  });

  it("an application-authored fact keeps its own message/recipient — the application IS the projection layer", () => {
    const [stamped] = stampFacts(
      "acme",
      [{ ...fact("checkpoint.created", "cp1", {}), message: "Handoff checkpoint published: fix it", recipient: "bob" }],
      ids,
    );
    expect(stamped?.record.message).toBe("Handoff checkpoint published: fix it");
    expect(stamped?.recipient).toBe("bob");
  });
});
