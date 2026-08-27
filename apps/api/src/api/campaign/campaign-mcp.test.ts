import { CampaignService, type CampaignSnapshot, RunService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import type { CampaignFrame } from "@everdict/contracts";
import { InMemoryEvolutionCampaignStore, InMemoryRunStore } from "@everdict/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

// BFF↔MCP parity for the campaign settlement: the agent-evolve loop drives the SAME service over MCP that
// the HTTP routes serve — open, derived round, gate decision, settle. Role gating rides `scorecards:*`.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in campaign MCP tests");
  },
};

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  observationPolicy: { allowDivergent: false },
};

const winning: CampaignSnapshot = {
  diff: {
    comparability: "full",
    trials: {
      baseline: "b",
      candidate: "c",
      zThreshold: 1.96,
      minDelta: 0,
      cases: [
        {
          caseId: "c1",
          baselineRate: 0,
          baselineTrials: 5,
          candidateRate: 1,
          candidateTrials: 5,
          delta: 1,
          z: 3,
          method: "fisher",
          p: 0.0079,
          significant: true,
        },
        {
          caseId: "c2",
          baselineRate: 0.2,
          baselineTrials: 5,
          candidateRate: 0.2,
          candidateTrials: 5,
          delta: 0,
          z: 0,
          method: "fisher",
          p: 1,
          significant: false,
        },
      ],
    } as NonNullable<CampaignSnapshot["diff"]["trials"]>,
    experiment: { held: ["execution_world"], confounds: [], unverified: [] },
  },
  baseline: { record: { harness: { id: "agent:everdict", version: "1.0.0" } } },
  // …with the manifest a real batch seals: without it the gate refuses (arch-review 73).
  candidate: {
    record: {
      harness: { id: "agent:everdict", version: "1.0.1" },
      manifest: { harness: { specDigest: "sha256:cand-1.0.1" } },
    },
  },
};

function makeDeps(): McpDeps {
  const store = new InMemoryEvolutionCampaignStore();
  const campaignService = new CampaignService({
    store,
    operations: store,
    issues: { get: async () => ({ id: "iss_1" }) },
    diffs: { diffSnapshot: async () => winning },
    newId: () => "evc_mcp",
    now: () => "2026-08-26T04:00:00.000Z",
  });
  return {
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    campaignService,
  };
}

async function connect(deps: McpDeps, roles: string[]): Promise<Client> {
  const principal: Principal = { subject: "user-a", workspace: "acme", roles, via: "oidc" };
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
};

describe("campaign MCP tools — the loop's settlement surface", () => {
  it("open → log_campaign_round (derived verdict) → campaign_decision → settle_campaign", async () => {
    const client = await connect(makeDeps(), ["member"]);
    const opened = await client.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    expect(opened.isError).toBeFalsy();
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    const logged = await client.callTool({
      name: "log_campaign_round",
      arguments: {
        id,
        hypothesis: "structure over phrasing",
        candidate_version: "1.0.1",
        baseline_scorecard_id: "sc-b",
        candidate_scorecard_id: "sc-c",
      },
    });
    expect(logged.isError).toBeFalsy();
    expect(JSON.parse(textOf(logged)).round.verdict.significantImprovements).toBe(1);

    const decision = await client.callTool({ name: "campaign_decision", arguments: { id } });
    expect(JSON.parse(textOf(decision)).kind).toBe("adopt");

    const settled = await client.callTool({ name: "settle_campaign", arguments: { id } });
    expect(settled.isError).toBeFalsy();
    expect(JSON.parse(textOf(settled)).record.state).toBe("adopted");
  });

  it("a premature settle is a CONFLICT the agent can read, and the campaign stays open", async () => {
    const client = await connect(makeDeps(), ["member"]);
    const opened = await client.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    const { id } = JSON.parse(textOf(opened)) as { id: string };
    const settled = await client.callTool({ name: "settle_campaign", arguments: { id } });
    expect(settled.isError).toBe(true);
    expect(textOf(settled)).toContain("CONFLICT");
    const read = await client.callTool({ name: "get_campaign", arguments: { id } });
    expect(JSON.parse(textOf(read)).state).toBe("open");
  });

  it("a viewer can read but not open — the write gate is scorecards:run", async () => {
    const deps = makeDeps();
    const member = await connect(deps, ["member"]);
    const opened = await member.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    expect(opened.isError).toBeFalsy();
    const viewer = await connect(deps, ["viewer"]);
    const list = await viewer.callTool({ name: "list_campaigns", arguments: {} });
    expect(list.isError).toBeFalsy();
    const denied = await viewer.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    expect(denied.isError).toBe(true);
  });
});
