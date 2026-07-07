// Live (K8s/kind): real aider fixes a seeded bug with gpt-5.4-mini (workclaw LiteLLM) and Everdict grades it with
// tests-pass — but the run happens inside a **real K8s Job (pod)**. K8sBackend launches the everdict-agent image as a Job,
// and the agent interprets the declarative command harness (zero code): (aider preinstalled) → run aider → tests-pass.
//
// ✅ Verified (PASS): inside a real K8s Job, aider (gpt-5.4-mini) fixes the seeded bug + passes tests-pass. Nomad↔K8s real-agent parity.
//
// Setup:
//   1) kind cluster `everdict` + load everdict-agent:local (python+aider) onto the node:
//      docker build -f packages/agent/Dockerfile -t everdict-agent:local . && kind load docker-image everdict-agent:local --name everdict
//   2) Connect the node to the default docker bridge so hostNetwork pods can reach the host LiteLLM (:4000):
//      docker network connect bridge everdict-control-plane   (→ reachable via the 172.17.0.1 gateway)
//   3) **Clean model alias**: register a name without the `chatgpt/` prefix (gpt-5.4-mini) in LiteLLM.
//      (Why: if the model name contains `chatgpt/`, this litellm version hijacks it into its own ChatGPT-OAuth device-code
//       login and hangs forever in a non-interactive pod → the real cause of the "hang". The alias avoids it. SLICE 25's
//       "httpx hang" diagnosis was wrong — raw httpx was fine; litellm was falling into OAuth.)
// Usage: CONTEXT=kind-everdict OPENAI_API_KEY=<litellm key> EVERDICT_MODEL=gpt-5.4-mini node scripts/live/aider-k8s.mjs
import process from "node:process";
import { K8sBackend } from "../../packages/backends/dist/index.js";

const CONTEXT = process.env.CONTEXT ?? "kind-everdict";
const IMAGE = process.env.IMAGE ?? "everdict-agent:local";
const NS = process.env.NS ?? "everdict-ci";
const KEY = process.env.OPENAI_API_KEY;
const HOST = process.env.LITELLM_HOST ?? "172.17.0.1"; // hostNetwork pod → default bridge gateway = host
const BASE = process.env.OPENAI_API_BASE ?? `http://${HOST}:4000`;
// Clean alias (no prefix) — avoids litellm's chatgpt-OAuth hijack.
const MODEL = process.env.EVERDICT_MODEL ?? "gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) is required.");
  process.exit(1);
}

const buggy = "def add(a, b):\n    return a - b\n";

const job = {
  harness: { id: "aider", version: "0.74.0" },
  harnessSpec: {
    kind: "command",
    id: "aider",
    version: "0.74.0",
    setup: [], // aider preinstalled (on the image PATH)
    command:
      "aider --yes-always --no-git --no-auto-commits --no-show-model-warnings --no-check-update --no-show-release-notes --analytics-disable --no-stream --edit-format whole --model openai/{{model}} --message {{task}} mathutils.py",
    model: MODEL,
    env: { OPENAI_API_BASE: BASE }, // not secret → spec.env. The key goes in secretEnv (below).
    trace: { kind: "none" },
  },
  evalCase: {
    id: `aider-fix-add-k8s-${Date.now().toString(36)}`,
    env: { kind: "repo", source: { files: { "mathutils.py": buggy } } },
    task: "There is a bug in mathutils.py: add(a, b) should return the sum a + b but it returns the difference. Fix it.",
    graders: [
      {
        id: "tests-pass",
        config: { cmd: "python3 -c \"from mathutils import add; assert add(2,3)==5; print('PASS')\"" },
      },
      { id: "latency" },
    ],
    timeoutSec: 600,
    tags: ["live", "aider", "k8s", "litellm"],
  },
};

// Inject OPENAI_API_KEY into the Job pod env (secretEnv); hostNetwork to reach the host LiteLLM (dev).
const backend = new K8sBackend({
  image: IMAGE,
  context: CONTEXT,
  namespace: NS,
  secretEnv: { OPENAI_API_KEY: KEY },
  hostNetwork: true,
});

console.log(`K8s(${CONTEXT}) → aider(${MODEL} via ${BASE}) in a real Job pod (ns=${NS}, hostNetwork) …`);
const t0 = Date.now();
const r = await backend.dispatch(job);
console.log(`\nharness   : ${r.harness}   (${((Date.now() - t0) / 1000).toFixed(0)}s, in K8s Job)`);
console.log("changed   :", r.snapshot.changedFiles);
console.log(
  "scores    :",
  r.scores.map((s) => `${s.graderId}:${s.value}${s.pass != null ? `(${s.pass ? "pass" : "fail"})` : ""}`).join(", "),
);
const tp = r.scores.find((s) => s.graderId === "tests-pass");
if (tp?.detail) console.log("tests-pass detail:", tp.detail.slice(0, 200));
const ok = tp?.pass === true;
console.log(
  ok
    ? "\n✅ Inside a K8s Job, aider (gpt-5.4-mini) fixed the bug + passed tests-pass — Nomad↔K8s real-agent parity complete"
    : "\n⚠️ tests-pass did not pass (see detail above)",
);
process.exit(ok ? 0 : 1);
