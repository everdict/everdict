// 라이브 검증: K8sBackend(process) 가 실제 K8s(kind) 에 러너 에이전트를 Job 으로 띄우고
// 완료를 폴링한 뒤 파드 로그의 sentinel 에서 CaseResult 를 파싱한다(= NomadBackend 의 K8s 짝).
//
// 준비: kind 클러스터 `everdict` + everdict-agent:local 이미지를 kind 노드에 로드해야 한다.
//   docker build -f packages/agent/Dockerfile -t everdict-agent:local .
//   kind load docker-image everdict-agent:local --name everdict
// 사용: node scripts/live/k8s-backend.mjs   (CONTEXT=kind-everdict IMAGE=everdict-agent:local NS=everdict-ci)
import { K8sBackend } from "../../packages/backends/dist/index.js";

const CONTEXT = process.env.CONTEXT ?? "kind-everdict";
const IMAGE = process.env.IMAGE ?? "everdict-agent:local";
const NS = process.env.NS ?? "everdict-ci";
const STAMP = Date.now().toString(36);

function jobFor(i) {
  return {
    harness: { id: "scripted", version: "latest" },
    evalCase: {
      id: `k8sbe-${STAMP}-${i}`,
      env: { kind: "repo", source: { files: {} } },
      task: `k8s backend dispatch case ${i}`,
      graders: [{ id: "steps" }, { id: "latency" }],
      timeoutSec: 180,
      tags: ["live", "k8s-backend"],
    },
  };
}

async function main() {
  const backend = new K8sBackend({ image: IMAGE, context: CONTEXT, namespace: NS, imagePullPolicy: "IfNotPresent" });
  console.log(`K8sBackend → context=${CONTEXT} ns=${NS} image=${IMAGE}`);
  console.log("capacity:", await backend.capacity());

  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);
  const N = Number(process.env.N ?? "2");
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      backend
        .dispatch(jobFor(i))
        .then((r) => {
          console.log(
            `  ✓ case ${i} @ t+${el()}s  harness=${r.harness}  scores=${r.scores.map((s) => `${s.graderId}:${s.value}`).join(",")}  diffFiles=${r.snapshot.changedFiles?.length ?? 0}`,
          );
          return true;
        })
        .catch((e) => {
          console.log(`  ✗ case ${i} @ t+${el()}s  ${e.message}`);
          return false;
        }),
    ),
  );
  const ok = results.filter(Boolean).length;
  console.log(`\n=== RESULT === ${ok}/${N} dispatched via real K8s Job in ${el()}s`);
  console.log(ok === N ? "✅ K8sBackend dispatch works (Job → poll → logs → CaseResult → cleanup)" : "❌ some failed");
  if (ok !== N) process.exit(1);
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
