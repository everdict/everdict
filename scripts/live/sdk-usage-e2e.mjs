import { RunService } from "../../apps/api/dist/run-service.js";
import { ScorecardService } from "../../apps/api/dist/scorecard-service.js";
import { buildServer } from "../../apps/api/dist/server.js";
// Self-contained e2e: boot the REAL control-plane (buildServer, in-memory deps + a cost-producing mock dispatcher)
// on a real HTTP port, then drive it with the published @everdict/sdk over real fetch. Proves the SDK → HTTP → service
// → usage-meter seam end to end (register dataset → evaluate with trials → verdict → GET /usage). No external infra.
// Run: node scripts/live/sdk-usage-e2e.mjs   (build first: pnpm -r build)
// Import via relative dist paths — pnpm doesn't hoist @everdict/* to the repo root, and node dedupes by real path so
// these are the same module instances the built server uses (transitive @everdict/* imports resolve inside each dist).
import { inMemoryUsageMeter } from "../../packages/backends/dist/index.js";
import { InMemoryRunStore, InMemoryScorecardStore } from "../../packages/db/dist/index.js";
import { InMemoryDatasetRegistry } from "../../packages/registry/dist/index.js";
import { EverdictClient } from "../../packages/sdk/dist/index.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

// A dispatch that reports an LLM cost and is flaky by trial (trial 1 fails) → exercises pass@k + usage metering.
const dispatcher = {
  async dispatch(job) {
    const pass = job.trial !== 1;
    return {
      caseId: job.evalCase.id,
      harness: `${job.harness.id}@${job.harness.version}`,
      trace: [{ t: 0, kind: "llm_call", model: "m", cost: { usd: 0.01, inputTokens: 100, outputTokens: 0 } }],
      snapshot: { kind: "prompt", output: "" },
      scores: [{ graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass }],
    };
  },
};

// Stub authenticator — any bearer resolves to member@acme (auth-core itself is unit-tested elsewhere).
const authenticator = {
  async authenticate(bearer) {
    return bearer ? { subject: "u", workspace: "acme", roles: ["member"], via: "oidc" } : undefined;
  },
};

const usageMeter = inMemoryUsageMeter();
const datasets = new InMemoryDatasetRegistry();
const scorecardService = new ScorecardService({
  dispatcher,
  store: new InMemoryScorecardStore(),
  datasets,
  usage: usageMeter,
});
const app = buildServer({
  service: new RunService({ dispatcher, store: new InMemoryRunStore() }),
  scorecardService,
  usageMeter,
  datasetRegistry: datasets,
  authenticator,
  requireAuth: true,
});

await app.listen({ port: 0, host: "127.0.0.1" });
const { port } = app.server.address();
const baseUrl = `http://127.0.0.1:${port}`;
console.error(`▶ control plane up on ${baseUrl}`);

try {
  const client = new EverdictClient({ baseUrl, apiKey: "ak_e2e", workspace: "acme" });

  // One call: register an inline dataset + run 3 trials + score → verdict.
  const verdict = await client.evaluate({
    harness: "scripted@0",
    dataset: {
      id: "e2e-smoke",
      version: "1.0.0",
      cases: [
        {
          id: "writes-file",
          env: { kind: "prompt" },
          task: "do the thing",
          graders: [{ id: "tests-pass", config: { cmd: "true" } }],
        },
      ],
    },
    trials: 3,
    poll: { intervalMs: 20 },
  });

  console.error(
    "verdict:",
    JSON.stringify({
      status: verdict.status,
      passRate: verdict.passRate,
      passAtK: verdict.passAtK,
      flakeRate: verdict.flakeRate,
    }),
  );
  assert(verdict.status === "succeeded", `status succeeded (got ${verdict.status})`);
  assert(Math.abs(verdict.passRate - 2 / 3) < 1e-9, `passRate 2/3 (got ${verdict.passRate})`);
  assert(verdict.passAtK === 1, `pass@3 = 1 (got ${verdict.passAtK})`);
  assert(verdict.flakeRate === 1, `flakeRate 1 (one flaky case) (got ${verdict.flakeRate})`);

  // Usage metered end to end: 3 trials × $0.01 = $0.03, 3 evaluations.
  const usageRes = await fetch(`${baseUrl}/usage`, {
    headers: { authorization: "Bearer ak_e2e", "x-everdict-workspace": "acme" },
  });
  const usage = await usageRes.json();
  console.error("usage:", JSON.stringify(usage));
  assert(usageRes.status === 200, `GET /usage 200 (got ${usageRes.status})`);
  assert(Math.abs(usage.usd - 0.03) < 1e-9, `usage.usd 0.03 (got ${usage.usd})`);
  assert(usage.tokens === 300, `usage.tokens 300 (got ${usage.tokens})`);
  assert(usage.evaluations === 3, `usage.evaluations 3 (got ${usage.evaluations})`);
  assert(usage.bySource.harness.usd > 0, "harness source metered");

  console.error(
    "\n✅ SDK ↔ control-plane e2e PASS — evaluate(trials) + pass@k verdict + metered usage all round-tripped",
  );
} finally {
  await app.close();
}
