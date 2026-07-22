import { LocalBackend } from "@everdict/backends";
import type { GradeContext, JudgeSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { defaultJudgeRunner } from "./judge-runner.js";

// REAL end-to-end, no infra: LocalBackend dispatches the code judge's wrapper job in-process →
// @everdict/job-runner runCase materializes the context/code env files, runs the no-op command harness, and the
// script grader executes the user's Node code as a real subprocess on this host. Proves the WHOLE chain
// (context serialization → dispatch → sandbox contract → score rewrite) with a genuine `node` execution.
describe("code judge — real dispatch end-to-end (in-process LocalBackend)", () => {
  const judgeCtx: GradeContext = {
    case: {
      id: "c1",
      env: { kind: "prompt" },
      task: "book the flight",
      graders: [],
      timeoutSec: 60,
      tags: [],
      milestones: [{ id: "login", description: "logged in as the test user" }],
    },
    trace: [{ t: 0, kind: "message", role: "assistant", text: "booked" }],
    snapshot: { kind: "prompt", output: "booked" },
    evidence: { finalAnswer: "booked", custom: { confirmation_id: "R-42" } },
  };

  function runner() {
    const backend = new LocalBackend(1);
    return defaultJudgeRunner({ secretsFor: async () => ({}), dispatch: (job) => backend.dispatch(job) });
  }

  it("executes user Node code against the ORIGINAL case's context and returns rewritten judge scores", async () => {
    const code = [
      "import { readFileSync } from 'node:fs'",
      "const ctx = JSON.parse(readFileSync(process.argv[2], 'utf8'))",
      "const answer = ctx.evidence?.finalAnswer ?? ''",
      "const ok = answer === 'booked' && ctx.evidence?.custom?.confirmation_id === 'R-42'",
      "console.log('log line before the verdict is allowed')",
      "const scores = [{ graderId: 'judge', metric: 'judge', value: ok ? 1 : 0, pass: ok }]",
      "for (const m of ctx.case.milestones ?? []) scores.push({ graderId: 'judge', metric: `judge:milestone:${m.id}`, value: 1, pass: true })",
      "console.log(JSON.stringify(scores))",
    ].join("\n");
    const spec: JudgeSpec = {
      kind: "code",
      id: "e2e",
      version: "1.0.0",
      language: "node",
      code,
      timeoutSec: 120,
      tags: [],
    };

    const scores = await runner().run(spec, "acme", judgeCtx);

    expect(scores.map((s) => s.metric)).toEqual(["judge:e2e", "judge:e2e:milestone:login"]);
    expect(scores[0]).toMatchObject({ graderId: "e2e", value: 1, pass: true });
    expect(scores[1]).toMatchObject({ graderId: "e2e", value: 1, pass: true });
  }, 60_000);

  it("a crashing judge surfaces its stderr in a visible zero score (Run-once debuggability), never a silent drop", async () => {
    const spec: JudgeSpec = {
      kind: "code",
      id: "e2e",
      version: "1.0.0",
      language: "node",
      code: "console.error('BOOM: evidence.finalAnswer missing'); process.exit(3)",
      timeoutSec: 120,
      tags: [],
    };

    const scores = await runner().run(spec, "acme", judgeCtx);

    // the wrapper's safeGrade turns the grader error into ONE visible error score whose detail carries the output
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ graderId: "e2e", metric: "judge:e2e", value: 0 });
    expect(String(scores[0]?.detail)).toContain("[grader-error]");
    expect(String(scores[0]?.detail)).toContain("BOOM: evidence.finalAnswer missing");
  }, 60_000);
});
