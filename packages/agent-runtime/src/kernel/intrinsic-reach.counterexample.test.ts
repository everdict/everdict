import type { LlmTransport, StreamRequest, StreamResult } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "./loop.js";

// ── INTRINSIC IS A CLAIM ABOUT REACH, AND IT WAS APPLIED BY ARRAY ────────────────────────────────────
//
// `intrinsic` exempts a tool from BOTH envelope guards: `authorizeToolInvocation` returns allowed without
// consulting the scope, and the object gate skips the tool entirely. The contract that defines it says what
// may wear it — "a KERNEL cognition tool (todo list, plan, sub-agent spawn, result paging, wait): part of how
// the agent thinks, not a workspace capability".
//
// The kernel wrapped the whole spawn array, `...spawnTools.map(intrinsic)`, and two of its members are not
// that. `spawn_teammate` creates another autonomous agent in the workspace's fleet, and its own declaration
// says so in as many words — "NOT read-only: spawning delegates standing WRITE authority … the spawn itself
// must pass the host's permission gate". It passed the host's gate and skipped the task's. `list_teammates`
// enumerates the same fleet.
//
// ⚠️ WHAT THIS WAS AND WAS NOT. No lane wires those host hooks together with an envelope today — the two
// sites that pass them are the member conversation, where an envelope is deliberately absent — so nothing
// escaped a live boundary. What existed was a capability that would have been ungoverned the moment one did,
// plus a comment at the composition point in `chat.ts` enumerating the kernel's additions as "todo,
// read_result, plan, wait … all read-only, so they ride the reads posture", which was not the set the kernel
// adds. That comment also said "the test says so", and there was no such test. This is it.
//
// Found by `pnpm scan` over files nobody had touched.
//
// Seen RED against the pre-fix source (three of the five, the two admitted-class cases staying green):
//   a teammate was spawned from a task whose envelope granted nothing: expected 1 to be +0
//   the workspace's agent fleet was enumerated from a sealed task: expected 1 to be +0
//   a sealed task messaged another session through the host mailbox: expected 1 to be +0

function fakeTransport(results: StreamResult[]): { transport: LlmTransport; requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];
  let call = 0;
  return {
    requests,
    transport: {
      provider: "fake",
      stream: async (req) => {
        requests.push(req);
        const r = results[call] ?? { content: null, toolCalls: [], finishReason: "stop" };
        call += 1;
        return r;
      },
    },
  };
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const calls = (list: { id: string; name: string; args: string }[]): StreamResult => ({
  content: null,
  toolCalls: list.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  finishReason: "tool_calls",
  usage,
});
const text = (content: string): StreamResult => ({ content, toolCalls: [], finishReason: "stop", usage });

const history: ChatMessage[] = [{ role: "user", content: "judge the claim" }];

// The verifier posture: nothing granted at all. Every capability this task may use would have to be named,
// and none is — so anything that runs here ran because it was exempt.
const SEALED_ENVELOPE = {
  id: "env-verify",
  goal: "decide whether the claim holds",
  budgets: { timeSec: 600 },
  stop: { onBudgetExhausted: "halt_checkpoint" as const },
  escalation: { onScopeExceeded: "refuse_and_replan" as const },
  rollbackRequired: false,
  scope: { reads: [], writes: [], forbidden: [] },
};

const toolResults = (requests: StreamRequest[], turn: number): string[] =>
  (requests[turn]?.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

describe("a host-seam tool is not kernel cognition", () => {
  it("refuses spawn_teammate under an envelope that granted nothing", async () => {
    let spawned = 0;
    const { transport, requests } = fakeTransport([
      calls([{ id: "c1", name: "spawn_teammate", args: '{"name":"helper","task":"go"}' }]),
      text("I cannot delegate from here."),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      envelope: SEALED_ENVELOPE,
      spawnTeammate: async () => {
        spawned += 1;
        return { id: "tm-1" };
      },
    });

    expect(spawned, "a teammate was spawned from a task whose envelope granted nothing").toBe(0);
    expect(toolResults(requests, 1).some((c) => c.includes("out_of_scope"))).toBe(true);
  });

  it("refuses list_teammates too — reading the fleet is still reading outside the task", async () => {
    let listed = 0;
    const { transport, requests } = fakeTransport([
      calls([{ id: "c1", name: "list_teammates", args: "{}" }]),
      text("done"),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      envelope: SEALED_ENVELOPE,
      listTeammates: async () => {
        listed += 1;
        return [];
      },
    });

    expect(listed, "the workspace's agent fleet was enumerated from a sealed task").toBe(0);
    expect(toolResults(requests, 1).some((c) => c.includes("out_of_scope"))).toBe(true);
  });

  it("still lets the sealed task keep a todo list and spawn its own sub-checks", async () => {
    // THE ADMITTED CLASS, and the reason this is a per-tool decision rather than a blanket rethink of
    // `intrinsic`. An evidence-only verifier that could not track its own steps or run a sub-check would be a
    // boundary that removed the thinking rather than the reach — and a nested sub-agent inherits this very
    // envelope, so the spawn grants nothing the parent did not already hold.
    const { transport, requests } = fakeTransport([
      calls([
        {
          id: "c1",
          name: "write_todos",
          args: '{"todos":[{"content":"read the evidence","status":"in_progress","activeForm":"Reading the evidence"}]}',
        },
      ]),
      text("noted"),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      envelope: SEALED_ENVELOPE,
    });

    const results = toolResults(requests, 1);
    expect(results, "the kernel's own cognition tool produced no result at all").toHaveLength(1);
    expect(
      results.some((c) => c.includes("out_of_scope")),
      "a sealed task lost its todo list",
    ).toBe(false);
  });

  it("keeps send_message intrinsic while it can only reach this run's own sub-agents", async () => {
    // One tool, two reaches. With no host seam wired it delivers only into this run's background mailboxes,
    // whose agents carry the same envelope — cognition, and exempt. The refusal above is what happens when a
    // host seam gives it somewhere else to go.
    const { transport, requests } = fakeTransport([
      calls([{ id: "c1", name: "send_message", args: '{"to":"nobody","message":"hi"}' }]),
      text("done"),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      envelope: SEALED_ENVELOPE,
    });

    // It runs and answers honestly that there is no such recipient. What it must NOT be is refused by the
    // envelope, which is a different sentence and would strand a verifier's own background sub-agents.
    expect(toolResults(requests, 1).some((c) => c.includes("out_of_scope"))).toBe(false);
  });

  it("refuses send_message once a host seam gives it somewhere outside to deliver", async () => {
    let delivered = 0;
    const { transport, requests } = fakeTransport([
      calls([{ id: "c1", name: "send_message", args: '{"to":"tm-1","message":"hi"}' }]),
      text("done"),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      envelope: SEALED_ENVELOPE,
      sendMessage: async () => {
        delivered += 1;
        return { ok: true };
      },
    });

    expect(delivered, "a sealed task messaged another session through the host mailbox").toBe(0);
    expect(toolResults(requests, 1).some((c) => c.includes("out_of_scope"))).toBe(true);
  });
});
