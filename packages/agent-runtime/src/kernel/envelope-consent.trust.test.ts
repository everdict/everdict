import type { EffectContract } from "@everdict/contracts";
import type { LlmTransport, StreamRequest, StreamResult } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "./loop.js";

// Trust suite (docs/trust-certification.md) — TRUST-14 / TRUST-15.
//
// TRUST-14: AN EVIDENCE-ONLY READ SCOPE MEANS WHAT IT SAYS. An envelope whose reads list a specific tool
// set must have the KERNEL refuse a read outside it — the verifier/diagnostician posture is a runtime
// guarantee, not a type-level claim (the previous kernel discarded out_of_scope for reads entirely).
// TRUST-15: readOnly IS NOT safe-without-consent. A read tool whose declared dataAccess can reach an
// outside network consults the permission hook in EVERY mode — exfiltration-shaped reads never auto-allow.
// Why a fake cannot prove these: both invariants are about the REAL dispatch path (registry → envelope
// gate → consent gate → invoke) staying wired in order — a stubbed loop is the reinterpretation the
// invariants exist to forbid, so the real loop runs against a scripted transport.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const history: ChatMessage[] = [{ role: "user", content: "go" }];
function scriptedTransport(results: StreamResult[]): { transport: LlmTransport; requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];
  let call = 0;
  const transport: LlmTransport = {
    provider: "fake",
    stream: async (req) => {
      requests.push(req);
      const r = results[call] ?? { content: null, toolCalls: [], finishReason: "stop" };
      call += 1;
      return r;
    },
  };
  return { transport, requests };
}
const callTool = (name: string): StreamResult => ({
  content: null,
  toolCalls: [{ id: "c1", name, arguments: "{}" }],
  finishReason: "tool_calls",
});
const text = (content: string): StreamResult => ({ content, toolCalls: [], finishReason: "stop" });
const readTool = (name: string, effects?: EffectContract): ToolDefinition => ({
  name,
  description: name,
  parametersJsonSchema: { type: "object" },
  isReadOnly: true,
  ...(effects ? { effects } : {}),
  call: async () => ({ content: "read ok", isError: false }),
});
const envelope = (reads: "all" | string[]) => ({
  id: "env-t14",
  goal: "verify",
  scope: { reads, writes: [], forbidden: [] },
  budgets: { tokens: 1_000_000 },
  stop: { onBudgetExhausted: "halt_checkpoint" as const },
  escalation: { onScopeExceeded: "refuse_and_replan" as const },
  rollbackRequired: false,
});

describeTrust("TRUST-14 — an evidence-only read scope refuses reads outside it", () => {
  it("the kernel refuses a read tool the envelope's reads list does not grant", async () => {
    const { transport, requests } = scriptedTransport([callTool("read_secrets"), text("stopped")]);
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([readTool("read_secrets"), readTool("list_runs")]),
      envelope: envelope(["list_runs"]),
    });
    const toolMsg = requests[1]?.messages.find((m) => m.role === "tool");
    expect(typeof toolMsg?.content === "string" && toolMsg.content.includes("out_of_scope")).toBe(true);
    expect(typeof toolMsg?.content === "string" && toolMsg.content.includes("read ok")).toBe(false); // never ran
  });
});

describeTrust("TRUST-15 — an exfiltration-shaped read consults consent in every mode", () => {
  it("isReadOnly + dataAccess.egress external reaches the permission hook, and a deny stops it", async () => {
    const asked: string[] = [];
    const { transport, requests } = scriptedTransport([callTool("fetch_url"), text("stopped")]);
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([
        readTool("fetch_url", { sideEffect: "none", dataAccess: { reads: "workspace", egress: "external" } }),
      ]),
      permit: async (req) => {
        asked.push(req.name);
        return "deny" as const;
      },
    });
    expect(asked).toEqual(["fetch_url"]);
    const toolMsg = requests[1]?.messages.find((m) => m.role === "tool");
    expect(typeof toolMsg?.content === "string" && toolMsg.content.includes("Permission denied")).toBe(true);
  });
});
