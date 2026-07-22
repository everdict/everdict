// live check: K8sBackend(process) launches the job-runner as a Job on a real K8s (kind),
// polls for completion, then parses CaseResult from the sentinel in the pod logs (= the K8s counterpart of NomadBackend).
//
// Prereq: a kind cluster `everdict` + load the everdict-job-runner:local image onto the kind node.
//   docker build -f packages/job-runner/Dockerfile -t everdict-job-runner:local .
//   kind load docker-image everdict-job-runner:local --name everdict
// Usage: node scripts/live/k8s-backend.mjs   (CONTEXT=kind-everdict IMAGE=everdict-job-runner:local NS=everdict-ci)
import { K8sBackend } from "../../packages/backends/dist/index.js";

const CONTEXT = process.env.CONTEXT ?? "kind-everdict";
const IMAGE = process.env.IMAGE ?? "everdict-job-runner:local";
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
