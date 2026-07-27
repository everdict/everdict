import { ToolRegistry } from "@everdict/agent-runtime";
import { InMemoryAgentSessionStore, InMemoryAnalysisArtifactStore, InMemoryTenantKeyStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import { buildReportPrompt } from "./report-turn.js";
import { type AgentServerDeps, buildServer } from "./server.js";

// A transport whose first turn calls write_report, then ends with text — the shape of a well-behaved report run.
function reportingTransport(): LlmTransport {
  let n = 0;
  const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 };
  return {
    provider: "fake",
    stream: async () => {
      n += 1;
      if (n === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "r1",
              name: "write_report",
              arguments: JSON.stringify({ title: "Weekly pass-rate", markdown: "# All green\nNo regressions." }),
            },
          ],
          finishReason: "tool_calls",
          usage,
        };
      }
      return { content: "reported", toolCalls: [], finishReason: "stop", usage };
    },
  };
}

function reportDeps(): {
  deps: AgentServerDeps;
  artifacts: InMemoryAnalysisArtifactStore;
  sessions: InMemoryAgentSessionStore;
} {
  let n = 0;
  const artifacts = new InMemoryAnalysisArtifactStore();
  const sessions = new InMemoryAgentSessionStore();
  const deps: AgentServerDeps = {
    // The minted agt_ token resolves to the CREATOR the schedule acts as.
    authenticate: async () => ({ subject: "creator", workspace: "acme", roles: ["member"] }),
    sessions,
    artifacts,
    keyStore: new InMemoryTenantKeyStore(),
    internalToken: "shhh",
    resolveModel: async () => ({ transport: reportingTransport(), model: "test-model" }),
    toolProvider: async () => ({ registry: new ToolRegistry([]), call: null, close: async () => {} }),
    systemPrompt: "test",
    now: () => "2026-07-27T00:00:00.000Z",
    newId: () => `id-${n++}`,
  };
  return { deps, artifacts, sessions };
}

describe("buildReportPrompt", () => {
  it("names the view, requires write_report, and adds the comparison step only when compare is set", () => {
    const base = { workspace: "acme", createdBy: "creator", scheduleId: "s1", scheduleName: "Weekly", view: "v-1" };
    const plain = buildReportPrompt(base);
    expect(plain).toContain('get_view(id: "v-1")');
    expect(plain).toContain("write_report exactly once");
    expect(plain).not.toContain("preceding period");
    const compared = buildReportPrompt({ ...base, compare: "previous-period", instructions: "focus on judge" });
    expect(compared).toContain("preceding period");
    expect(compared).toContain("focus on judge");
  });
});

describe("POST /internal/report — scheduled report turn", () => {
  it("rejects a missing/wrong internal token", async () => {
    const { deps } = reportDeps();
    const app = buildServer(deps);
    const body = { workspace: "acme", createdBy: "creator", scheduleId: "s1", scheduleName: "Weekly", view: "v-1" };
    expect((await app.inject({ method: "POST", url: "/internal/report", payload: body })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/report",
          headers: { "x-internal-token": "wrong" },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it("runs a headless turn as the creator and pins the emitted report to the view", async () => {
    const { deps, artifacts, sessions } = reportDeps();
    const app = buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: "/internal/report",
      headers: { "x-internal-token": "shhh" },
      payload: { workspace: "acme", createdBy: "creator", scheduleId: "s1", scheduleName: "Weekly", view: "v-1" },
    });
    expect(res.statusCode).toBe(200);
    const { sessionId, artifactId } = res.json() as { sessionId: string; artifactId?: string };
    expect(artifactId).toBeDefined();

    // The report artifact is attached + pinned to the View (the report archive).
    if (!artifactId) throw new Error("artifactId missing");
    const artifact = await artifacts.get("acme", artifactId);
    expect(artifact).toMatchObject({ kind: "report", viewId: "v-1", pinned: true, createdBy: "creator" });

    // The transcript belongs to the creator and is titled after the schedule.
    const session = await sessions.getSession("acme", "creator", sessionId);
    expect(session?.title).toBe("Report: Weekly");
    await app.close();
  });
});
