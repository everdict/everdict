import type { LlmTransport, StreamRequest, StreamResult } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildToolSearchTool } from "../tools/tool-search.js";
import { runAgentLoop } from "./loop.js";

// ── COMPACTION ERASED THE RECORD OF WHICH TOOLS THIS RUN HAD LOADED ──────────────────────────────────
//
// Deferred tools are held out of the outbound `tools[]` until the model finds them with ToolSearch. Which
// ones have been found was answered every turn by `extractDiscoveredToolNames(messages)` — a scan of the
// transcript for ToolSearch's own tool RESULT, parsed as JSON.
//
// The transcript is also what compaction edits. Rung 1 replaces any tool body over 400 characters past the
// recent window with `[tool result elided …]`; rung 2 summarises the old span; rung 3 drops it. After any of
// them the parse fails and the names are gone — so every tool the search had loaded left the outbound list
// mid-procedure, and the system prompt began advertising them again as undiscovered. Nothing errored. The
// model simply stopped being able to call a tool it had just been told to invoke directly by name.
//
// A `select:`-form search over MCP tool names crosses 400 characters easily, which is the ordinary case:
// MCP tools default to deferred, and their names are long.
//
// The carve-out one screen above this in `compaction.ts` is the same lesson already paid for once — loaded
// skill bodies are kept because "the agent may still be mid-procedure". Discovery is the stronger case: a
// skill body is guidance the model can work without, and this is the outbound tool list itself.
//
// The repair does not teach compaction about ToolSearch. Discovery is MONOTONIC — a tool loaded in turn 3
// stays loaded for the run — so the kernel HOLDS the set and the transcript scan becomes an ingest: it still
// recovers discovery from an inbound `history` on resume, and it can no longer un-discover anything. That
// answers all three rungs at once, where a rung-1 exemption would have left rungs 2 and 3 with the defect.
// Rule `protocol` L3 — provenance born at the source, never re-derived from rendered output. Found by
// `pnpm scan` over files nobody had touched.
//
// Seen RED against the pre-fix source, both halves, the admitted-class case staying green:
//   the run lost a tool it had already discovered: expected [ 'note_progress', 'ToolSearch', …(4) ] to
//   include 'mcp__acme_platform__publish_release_notes'
//   a tool whose schema is already loaded was advertised as still deferred: expected
//   's\n\n<available-deferred-tools>\nmcp_…' not to contain 'mcp__acme_platform__publish_release_notes'

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

// The run's own token usage, reported per turn. It stays small while the transcript is being built and
// crosses the 0.9 threshold against `MAX_TOKENS` on the sixth turn, so compaction happens partway through a
// long run rather than on the first one — which is what makes the search result an OLD message by then.
const MAX_TOKENS = 1_000;
const usage = (totalTokens: number) => ({ inputTokens: 1, outputTokens: 1, totalTokens });
const calls = (list: { id: string; name: string; args: string }[], totalTokens = 100): StreamResult => ({
  content: null,
  toolCalls: list.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  finishReason: "tool_calls",
  usage: usage(totalTokens),
});
const text = (content: string, totalTokens = 100): StreamResult => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage: usage(totalTokens),
});

// Long names on purpose: this is what an MCP server's tools look like, and it is why the search result
// crosses the clearing threshold in the first place.
const DEFERRED_NAMES = [
  "mcp__acme_platform__publish_release_notes",
  "mcp__acme_platform__publish_release_bundle",
  "mcp__acme_platform__publish_release_manifest",
  "mcp__acme_platform__publish_release_changelog",
  "mcp__acme_platform__publish_release_artifacts",
  "mcp__acme_platform__publish_release_signature",
  "mcp__acme_platform__publish_release_provenance",
  "mcp__acme_platform__publish_release_attestation",
];

const deferredTools: ToolDefinition[] = DEFERRED_NAMES.map((name) => ({
  name,
  description: "publish part of a release",
  parametersJsonSchema: { type: "object", properties: {} },
  isMcp: true,
  isReadOnly: true,
  call: async () => ({ content: "published", isError: false }),
}));

// Something for the turns after the search to do, with a body big enough that the transcript actually grows
// and rung 1 has ordinary results to clear beside the one under test. It echoes its input so each turn is
// distinguishable — the loop ends a run whose calls and results repeat, and identical notes would stop it
// four turns short of the compaction this is about.
const noteProgress: ToolDefinition = {
  name: "note_progress",
  description: "record a note",
  parametersJsonSchema: { type: "object", properties: { n: { type: "number" } } },
  isReadOnly: true,
  alwaysLoad: true,
  call: async (input) => ({ content: `noted ${JSON.stringify(input)}. ${"context ".repeat(120)}`, isError: false }),
};

// The same wiring production uses: the host registers ToolSearch over the bridged (deferred) set and puts
// both into the kernel's registry — `buildToolSearchTool(new ToolRegistry(bridged)), ...bridged`.
const registry = (): ToolRegistry =>
  new ToolRegistry([noteProgress, buildToolSearchTool(new ToolRegistry(deferredTools)), ...deferredTools]);

const history: ChatMessage[] = [{ role: "user", content: "publish the release" }];

const toolNamesOf = (req: StreamRequest | undefined): string[] => (req?.tools ?? []).map((t) => t.name);

describe("a run does not lose a deferred tool it has already discovered", () => {
  it("keeps the discovered tool in tools[] after compaction has cleared the search result", async () => {
    const { transport, requests } = fakeTransport([
      // Turn 1 — find them. The result body is names + a note, comfortably over the 400-char clear threshold.
      calls([{ id: "s1", name: "ToolSearch", args: '{"query":"publish release","max_results":8}' }]),
      // Turns 2-6 — ordinary work, which pushes the search result out of the recent window and drives the
      // budget past its threshold so the loop compacts between turns.
      calls([{ id: "n1", name: "note_progress", args: '{"n":1}' }]),
      calls([{ id: "n2", name: "note_progress", args: '{"n":2}' }]),
      calls([{ id: "n3", name: "note_progress", args: '{"n":3}' }]),
      calls([{ id: "n4", name: "note_progress", args: '{"n":4}' }]),
      calls([{ id: "n5", name: "note_progress", args: '{"n":5}' }], 950),
      // Turn 7 — the model goes to use what it loaded five turns ago.
      text("publishing now", 950),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: registry(),
      maxTokens: MAX_TOKENS,
      summarize: async () => "the run has been publishing a release",
    });

    // The premise, asserted rather than assumed: by the last turn the transcript no longer carries a readable
    // ToolSearch result. Stated as "the record is gone" instead of "rung 1 fired", because every rung of the
    // ladder destroys it and which one runs is not what this is about.
    const stillReadable = (requests.at(-1)?.messages ?? []).some(
      (m) => typeof m.content === "string" && m.content.includes(`"tool_name":"ToolSearch"`),
    );
    expect(stillReadable, "the search result survived, so this proves nothing about surviving its loss").toBe(false);

    expect(toolNamesOf(requests.at(-1)), "the run lost a tool it had already discovered").toContain(
      "mcp__acme_platform__publish_release_notes",
    );
  });

  it("does not offer a discovered tool back as undiscovered in the system prompt", async () => {
    // The other half of the same fact, and the one a model actually reads: the deferred listing is built from
    // the same set, so an erased record re-advertises a tool whose schema is already loaded — and the model
    // spends a turn searching for what it has.
    const { transport, requests } = fakeTransport([
      calls([{ id: "s1", name: "ToolSearch", args: '{"query":"publish release","max_results":8}' }]),
      calls([{ id: "n1", name: "note_progress", args: '{"n":1}' }]),
      calls([{ id: "n2", name: "note_progress", args: '{"n":2}' }]),
      calls([{ id: "n3", name: "note_progress", args: '{"n":3}' }]),
      calls([{ id: "n4", name: "note_progress", args: '{"n":4}' }]),
      calls([{ id: "n5", name: "note_progress", args: '{"n":5}' }], 950),
      text("done", 950),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: registry(),
      maxTokens: MAX_TOKENS,
      summarize: async () => "the run has been publishing a release",
    });

    const system = requests.at(-1)?.system ?? "";
    expect(system, "a tool whose schema is already loaded was advertised as still deferred").not.toContain(
      "mcp__acme_platform__publish_release_notes",
    );
  });

  it("still holds back a deferred tool nobody searched for", async () => {
    // The admitted class. Holding the set must not turn progressive disclosure off: a tool no search ever
    // matched stays out of `tools[]`, which is the whole reason the mechanism exists.
    const { transport, requests } = fakeTransport([
      calls([{ id: "n1", name: "note_progress", args: '{"n":1}' }]),
      text("done"),
    ]);

    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: registry(),
      summarize: async () => "",
    });

    const names = toolNamesOf(requests.at(-1));
    expect(names, "an undiscovered deferred tool was sent anyway").not.toContain(
      "mcp__acme_platform__publish_release_notes",
    );
    expect(names, "the always-loaded tool stopped being sent").toContain("note_progress");
  });
});
