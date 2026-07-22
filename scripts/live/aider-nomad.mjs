// Live (Nomad): real aider fixes a seeded bug with gpt-5.4-mini (workclaw LiteLLM) and Everdict grades it with
// tests-pass — but the run happens inside a **real Nomad alloc (docker container)**. NomadBackend launches the
// everdict-job-runner image as a job, and the agent interprets the declarative command harness (zero code): (aider preinstalled) → run aider → tests-pass.
//
// Setup: run a nomad agent + build the everdict-job-runner:local image (with python + aider preinstalled).
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-job-runner:local \
//       OPENAI_API_KEY=<litellm key> EVERDICT_MODEL=chatgpt/gpt-5.4-mini node scripts/live/aider-nomad.mjs
//   (LiteLLM is on the host :4000 — container→host is reached via the default 172.17.0.1 gateway. Override with LITELLM_HOST.)
import process from "node:process";
import { NomadBackend } from "../../packages/backends/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-job-runner:local";
const KEY = process.env.OPENAI_API_KEY;
// Sandbox (container)→host is most reliable via the docker bridge gateway (172.17.0.1). A LAN IP connects over tcp,
// but model completion responses sometimes don't come back cleanly over that path, so the default is the gateway (override with LITELLM_HOST).
const HOST = process.env.LITELLM_HOST ?? "172.17.0.1";
const BASE = process.env.OPENAI_API_BASE ?? `http://${HOST}:4000`;
const MODEL = process.env.EVERDICT_MODEL ?? "chatgpt/gpt-5.4-mini";
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
    // aider is preinstalled on the everdict-job-runner image (PATH) → setup empty. (For a specific version, pip-install it via setup.)
    setup: [],
    command:
      "aider --yes-always --no-git --no-auto-commits --no-show-model-warnings --no-check-update --no-show-release-notes --analytics-disable --no-stream --edit-format whole --model openai/{{model}} --message {{task}} mathutils.py",
    model: MODEL,
    // OPENAI_API_BASE is not secret → spec.env. OPENAI_API_KEY is secret → injected into the alloc via secretEnv (below).
    env: { OPENAI_API_BASE: BASE },
    trace: { kind: "none" },
  },
  evalCase: {
    // Unique id — the Nomad job ID (everdict-<id>) must differ each run so it doesn't collide with a dead prior alloc.
    id: `aider-fix-add-nomad-${Date.now().toString(36)}`,
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
    tags: ["live", "aider", "nomad", "litellm"],
  },
};

// Inject OPENAI_API_KEY into the alloc env → agent process.env → LocalDriver inherits it to the child (aider).
// (Properly, the workspace secret store; the live script does the equivalent via direct secretEnv injection.)
const backend = new NomadBackend({ addr: ADDR, image: IMAGE, secretEnv: { OPENAI_API_KEY: KEY } });

console.log(
  `Nomad(${ADDR}) → aider(${MODEL} via ${BASE}) in a real alloc … (no image pull=local; pip+LLM may take a few min)`,
);
const t0 = Date.now();
const r = await backend.dispatch(job);
console.log(`\nharness   : ${r.harness}   (${((Date.now() - t0) / 1000).toFixed(0)}s, in Nomad alloc)`);
console.log("changed   :", r.snapshot.changedFiles);
console.log(
  "scores    :",
  r.scores.map((s) => `${s.graderId}:${s.value}${s.pass != null ? `(${s.pass ? "pass" : "fail"})` : ""}`).join(", "),
);
const tp = r.scores.find((s) => s.graderId === "tests-pass");
if (tp?.detail) console.log("tests-pass detail:", tp.detail.slice(0, 200));
const ok = tp?.pass === true;
if (!ok) {
  // Failure diagnosis: the aider history (the model's actual response) is in the snapshot diff.
  const hist = r.snapshot.diff
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .join("\n");
  console.log(`\n--- snapshot diff (aider history; model response) tail ---\n${hist.slice(-1500)}`);
}
console.log(
  ok
    ? "\n✅ Inside a Nomad alloc, aider (gpt-5.4-mini) fixed the bug + passed tests-pass — real OSS harness Nomad live eval OK"
    : "\n⚠️ tests-pass did not pass (see detail above / Nomad alloc logs)",
);
process.exit(ok ? 0 : 1);
