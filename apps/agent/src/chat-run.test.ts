import { InMemoryAgentSessionStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { withChatTurnRun, withTurnRun } from "./chat-run.js";
import type { ChatResult } from "./chat.js";
import type { AgentRunEventReport } from "./usage.js";

const PRINCIPAL = { subject: "u-1", workspace: "acme", roles: ["member"] };
const NOW = "2026-07-31T00:00:00.000Z";

async function harness(): Promise<{
  deps: Parameters<typeof withChatTurnRun>[0];
  sessions: InMemoryAgentSessionStore;
  reports: AgentRunEventReport[];
}> {
  const sessions = new InMemoryAgentSessionStore();
  await sessions.createSession({
    id: "s-1",
    tenant: "acme",
    owner: "u-1",
    title: "New conversation",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const reports: AgentRunEventReport[] = [];
  let n = 0;
  return {
    sessions,
    reports,
    deps: {
      sessions,
      now: () => NOW,
      newId: () => `run-${n++}`,
      reportRunEvent: async (input) => {
        reports.push(input);
      },
    },
  };
}

const result = (): ChatResult => ({
  messages: [
    {
      id: "m-0",
      tenant: "acme",
      sessionId: "s-1",
      seq: 0,
      role: "user",
      content: "what changed?",
      createdAt: NOW,
    },
    {
      id: "m-1",
      tenant: "acme",
      sessionId: "s-1",
      seq: 1,
      role: "assistant",
      content: "two runs regressed.",
      createdAt: NOW,
    },
  ],
});

describe("withChatTurnRun — a chat turn is a run (O1)", () => {
  it("opens the run before the turn, stamps it on the session, and settles it with the transcript as a trace", async () => {
    const { deps, sessions, reports } = await harness();

    const out = await withChatTurnRun(deps, PRINCIPAL, "s-1", async () => {
      // The run id must already be on the session when the turn starts — that is what stamps the work the
      // agent submits mid-turn as caused by this run.
      expect((await sessions.getSession("acme", "u-1", "s-1"))?.runId).toBe("run-0");
      return result();
    });

    expect(out.messages).toHaveLength(2);
    expect(reports.map((r) => r.kind)).toEqual(["agent.run.started", "agent.run.completed"]);
    expect(reports[0]).toMatchObject({
      workspace: "acme",
      sessionId: "s-1",
      agentId: "default",
      eventKind: "chat",
      runId: "run-0",
      creator: "u-1",
      cause: "chat",
    });
    // The transcript's own clock: both rows share a timestamp in this fixture, so both sit at t=0 with the
    // absolute instant beside them (the projection stopped inventing a step index — see run-trace.ts).
    expect(reports[1]?.trace).toEqual([
      { t: 0, at: "2026-07-31T00:00:00.000Z", kind: "message", role: "user", text: "what changed?" },
      {
        t: 0,
        at: "2026-07-31T00:00:00.000Z",
        kind: "message",
        role: "assistant",
        text: "two runs regressed.",
      },
    ]);
  });

  it("settles a failed turn as failed, and a STOPPED turn as cancelled — a member's own stop is not a failure", async () => {
    const failing = await harness();
    await expect(
      withChatTurnRun(failing.deps, PRINCIPAL, "s-1", async () => {
        throw new Error("model exploded");
      }),
    ).rejects.toThrow("model exploded");
    expect(failing.reports.at(-1)?.kind).toBe("agent.run.failed");

    const stopped = await harness();
    const controller = new AbortController();
    await expect(
      withChatTurnRun(
        stopped.deps,
        PRINCIPAL,
        "s-1",
        async () => {
          controller.abort();
          throw new Error("aborted");
        },
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
    expect(stopped.reports.at(-1)?.kind).toBe("agent.run.cancelled");
  });

  it("settles a DIED turn with the record it kept — the spans it collected before throwing", async () => {
    const { deps, reports } = await harness();
    const span = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      name: "invoke_agent default",
      kind: "internal" as const,
      startedAt: NOW,
      endedAt: NOW,
      attributes: {},
      status: { code: "error" as const, message: "The model provider call failed." },
    };

    await expect(
      withChatTurnRun(deps, PRINCIPAL, "s-1", async (collectFailure) => {
        collectFailure({ reason: "The model provider call failed.", spans: [span] });
        throw new Error("The model provider call failed.");
      }),
    ).rejects.toThrow("The model provider call failed.");

    // The evidence rides the SAME terminal report a succeeded turn uses — so the control plane seals a
    // trajectory for the dead turn too, and it is readable in the ledger like any other.
    expect(reports.at(-1)).toMatchObject({ kind: "agent.run.failed", spans: [span] });
  });

  it("settles a turn that died with NO record at all carrying the reason itself — never an empty run", async () => {
    const { deps, reports } = await harness();

    await expect(
      withChatTurnRun(deps, PRINCIPAL, "s-1", async () => {
        throw new Error("no model is configured for this workspace");
      }),
    ).rejects.toThrow("no model is configured");

    const settled = reports.at(-1);
    expect(settled?.kind).toBe("agent.run.failed");
    expect(settled?.trace).toMatchObject([{ kind: "error", message: "no model is configured for this workspace" }]);
  });

  it("falls back to the transcript when the turn recorded an EMPTY span list — a settle never goes out evidence-less", async () => {
    const { deps, reports } = await harness();

    // A runner that records no spans hands back `[]`, not `undefined`. Reading that as "the turn kept its own
    // record" suppressed the transcript projection while attaching nothing, and the run settled with neither.
    await withChatTurnRun(deps, PRINCIPAL, "s-1", async () => ({ ...result(), spans: [] }));

    const settled = reports.at(-1);
    expect(settled?.kind).toBe("agent.run.completed");
    expect(settled?.spans).toBeUndefined();
    expect(settled?.trace).toHaveLength(2);
  });

  it("carries a headless turn's own identity — a wake-up is event-caused work, not something a member typed", async () => {
    const { deps, reports } = await harness();

    await withTurnRun(deps, PRINCIPAL, "s-1", { cause: "event", eventKind: "wake", label: "Wake-up turn" }, async () =>
      result(),
    );

    // `cause` decides which record the control plane mints (headless work belongs on the event log; a typed
    // turn deliberately stays off it), and the label is how a reader tells the run apart from a chat turn.
    expect(reports[0]).toMatchObject({ cause: "event", eventKind: "wake" });
    expect(reports[0]?.message).toContain("Wake-up turn");
    expect(reports[1]).toMatchObject({ kind: "agent.run.completed", cause: "event", eventKind: "wake" });
  });

  it("runs the turn untouched when there is no ledger bridge, or when the conversation is not visible", async () => {
    const { deps, sessions } = await harness();
    const { reportRunEvent: _bridge, ...noBridge } = deps;
    expect((await withChatTurnRun(noBridge, PRINCIPAL, "s-1", async () => result())).messages).toHaveLength(2);

    // Someone else's private conversation: no run is opened here — the turn itself answers with NotFound.
    const stranger = { subject: "u-2", workspace: "acme", roles: ["member"] };
    expect((await withChatTurnRun(deps, stranger, "s-1", async () => result())).messages).toHaveLength(2);
    expect((await sessions.getSession("acme", "u-1", "s-1"))?.runId).toBeUndefined();
  });

  it("reports the CRAFTED agent's id and version when the conversation belongs to one", async () => {
    const { deps, sessions, reports } = await harness();
    await sessions.createSession({
      id: "s-2",
      tenant: "acme",
      owner: "u-1",
      title: "Crafted",
      origin: { type: "chat", agentId: "sentinel", agentVersion: "1.2.0" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    await withChatTurnRun(deps, PRINCIPAL, "s-2", async () => result());
    expect(reports[0]).toMatchObject({ agentId: "sentinel", agentVersion: "1.2.0" });
  });
});
