// 라이브 검증: 테넌트 예산(admission) + 시크릿 스코핑이 실제 Nomad 위에서 작동한다.
//
// (1) 시크릿 스코핑: tenant 마다 자기 모델 키만 alloc env 에 주입됨을 buildNomadJob 으로 확인(누출 없음).
// (2) 예산: tenant "free" 를 runs=3 으로 제한하고 5건을 한꺼번에 제출 → 3건만 실행되고 2건은
//     402(BUDGET_EXCEEDED)로 즉시 거절된다(버스트여도 admit 가 즉시 예약하므로 상한 보호).
//     (scripted 하니스는 cost=0 이라 usd/토큰 예산은 트리거 안 됨 → runs 예산으로 시연; usd/토큰은 단위테스트로 검증)
//
// 사용: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-agent:local node scripts/live/budget-nomad.mjs

import {
  BackendRegistry,
  NomadBackend,
  Scheduler,
  buildNomadJob,
  inMemoryBudget,
  staticSecrets,
} from "../../packages/backends/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-agent:local";
const STAMP = Date.now().toString(36);
const RUNS_LIMIT = 3;
const N = 5;

const secrets = staticSecrets({
  acme: { ANTHROPIC_API_KEY: "sk-acme-XXXX" },
  globex: { ANTHROPIC_API_KEY: "sk-globex-YYYY" },
});

function jobFor(tenant, i) {
  return {
    harness: { id: "scripted", version: "latest" },
    tenant,
    evalCase: {
      id: `bud-${STAMP}-${i}`,
      env: { kind: "repo", source: { files: {} } },
      task: `budget case ${i}`,
      graders: [{ id: "steps" }],
      timeoutSec: 120,
      tags: ["live", "budget"],
    },
  };
}

function envKey(tenant) {
  const spec = buildNomadJob(jobFor(tenant, 0), {
    addr: NOMAD_ADDR,
    image: IMAGE,
    secretEnv: secrets.secretsFor(tenant),
  });
  return spec.Job.TaskGroups[0]?.Tasks[0]?.Env.ANTHROPIC_API_KEY;
}

async function main() {
  console.log("=== (1) secret scoping — each tenant's job carries only its own key ===");
  console.log("  acme   →", envKey("acme"));
  console.log("  globex →", envKey("globex"));
  console.log("  isolated:", envKey("acme") !== envKey("globex"), "\n");

  console.log(`=== (2) budget — tenant 'free' limited to runs=${RUNS_LIMIT}, submitting ${N} ===`);
  const backend = new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: 2, secrets });
  const budget = inMemoryBudget({ limitFor: (t) => (t === "free" ? { runs: RUNS_LIMIT } : undefined) });
  const sched = new Scheduler(new BackendRegistry().register("nomad", backend), { budget });

  const outcomes = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      sched
        .dispatch(jobFor("free", i))
        .then(() => ({ i, ok: true }))
        .catch((e) => ({ i, ok: false, code: e.code ?? e.name })),
    ),
  );

  const ok = outcomes.filter((o) => o.ok);
  const rejected = outcomes.filter((o) => !o.ok);
  for (const o of outcomes) console.log(`  case ${o.i}: ${o.ok ? "✓ ran" : `✗ rejected (${o.code})`}`);

  console.log("\n=== RESULT ===");
  console.log(`admitted+ran : ${ok.length}  rejected: ${rejected.length}`);
  console.log("budget usage :", JSON.stringify(budget.usage("free")));
  console.log(
    ok.length === RUNS_LIMIT && rejected.every((r) => r.code === "BUDGET_EXCEEDED")
      ? `✅ exactly ${RUNS_LIMIT} ran; the rest got 402 BUDGET_EXCEEDED — and keys never crossed tenants`
      : "ℹ unexpected outcome",
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
