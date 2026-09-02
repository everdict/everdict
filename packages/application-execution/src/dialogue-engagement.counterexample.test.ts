import type { ComputeHandle, Driver, EvalCase, ExecResult, RunContext } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

// ── [COUNTEREXAMPLE] A CASE CAN BE A CONVERSATION (world-and-engagement-model.md, axis 2) ────────────
//
// Every case in this repository has been ONE-SHOT: hand the actor the task, read its trace. A whole class of
// benchmarks is not — the case IS a dialogue, and what is measured is where the agent ends up after several
// exchanges. Without an engagement declaration the only way to express one was N independent cases, which
// measures N first turns.
//
// Two things must hold, and neither is visible from a single-turn test:
//   ① each user line resumes the SAME session — the harness gets the token the previous turn reported, so
//      the agent continues rather than starting over. A loop that dropped the token would still produce a
//      trace, still score, and measure a stranger answering each line cold.
//   ② a harness that cannot hold a conversation is REFUSED, not driven turn by turn. Driving it would make
//      every "turn" an independent run and the conversation a fiction the number is computed over.
const dialogueCase = (over: Partial<EvalCase> = {}): EvalCase =>
  ({
    id: "c1",
    task: "book me a flight",
    env: { kind: "prompt" },
    graders: [],
    timeoutSec: 60,
    engagement: {
      kind: "dialogue",
      user: { kind: "scripted", turns: ["make it a window seat", "and add a bag"] },
    },
    ...over,
  }) as unknown as EvalCase;

function world() {
  const compute = {
    id: "c",
    async exec(): Promise<ExecResult> {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  } as unknown as ComputeHandle;
  return {
    driver: {
      id: "fake",
      async provision() {
        return compute;
      },
    } as unknown as Driver,
  };
}

// A harness that holds a conversation the way a real CLI does: it reports a token at the end of every turn,
// and a resumed turn is handed the previous one.
function conversationalHarness(opts: { conversational?: true } = { conversational: true }) {
  const turns: Array<{ text: string; resume?: string }> = [];
  let n = 0;
  const harness = {
    id: "cli",
    version: "1",
    ...(opts.conversational === true ? { conversational: true as const } : {}),
    async install() {},
    async *run(_compute: ComputeHandle, text: string, ctx: RunContext) {
      n += 1;
      turns.push({ text, ...(ctx.conversation?.resume !== undefined ? { resume: ctx.conversation.resume } : {}) });
      ctx.conversation?.onToken?.(`session-${n}`);
      yield { t: n, kind: "message", role: "assistant", text: `answered ${text}` };
    },
  } as never;
  return { harness, turns };
}

const deps = (harness: never) => ({
  driver: world().driver,
  environment: { seed: async () => {}, snapshot: async () => ({ kind: "prompt", output: "" }) } as never,
  harness,
  graders: [],
  runCtx: {} as never,
});

describe("[COUNTEREXAMPLE] a dialogue case is one exchange, not N first turns", () => {
  it("drives the task then every user line, each resuming the session the last turn reported", async () => {
    const { harness, turns } = conversationalHarness();
    const result = await runCase(dialogueCase(), deps(harness));
    expect(turns.map((t) => t.text)).toEqual(["book me a flight", "make it a window seat", "and add a bag"]);
    // ① the opening turn resumes nothing; every later turn carries the PREVIOUS turn's token.
    expect(turns.map((t) => t.resume)).toEqual([undefined, "session-1", "session-2"]);
    // …and the whole exchange is one trace, which is what a judge of a conversation reads.
    expect(result.trace.filter((e) => e.kind === "message")).toHaveLength(3);
  });

  it("honours maxTurns, counting the opening task as turn 1", async () => {
    const { harness, turns } = conversationalHarness();
    await runCase(
      dialogueCase({
        engagement: {
          kind: "dialogue",
          user: { kind: "scripted", turns: ["make it a window seat", "and add a bag"] },
          maxTurns: 2,
        },
      } as Partial<EvalCase>),
      deps(harness),
    );
    expect(turns.map((t) => t.text)).toEqual(["book me a flight", "make it a window seat"]);
  });

  it("refuses a harness that cannot hold a conversation — before it runs anything", async () => {
    const { harness, turns } = conversationalHarness({});
    await expect(runCase(dialogueCase(), deps(harness))).rejects.toThrow(/does not hold a conversation/);
    expect(turns, "the refusal must come before the first turn, not after a fictional exchange").toEqual([]);
  });

  it("a case with no engagement is one-shot, exactly as before", async () => {
    const { harness, turns } = conversationalHarness();
    await runCase(dialogueCase({ engagement: undefined }), deps(harness));
    expect(turns).toEqual([{ text: "book me a flight" }]);
  });
});
