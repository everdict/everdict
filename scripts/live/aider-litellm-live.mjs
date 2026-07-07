// Live: the real OSS coding agent aider fixes a seeded bug with gpt-5.4-mini (workclaw LiteLLM), and
// Everdict grades it objectively with tests-pass. Declarative command harness (zero code): setup installs aider (/tmp venv) →
// command runs aider → RepoEnvironment git-diff snapshot + tests-pass grader. (LocalBackend, host execution)
//
// Usage: OPENAI_API_KEY=<litellm key> OPENAI_API_BASE=http://localhost:4000 \
//       EVERDICT_MODEL=chatgpt/gpt-5.4-mini node scripts/live/aider-litellm-live.mjs
import process from "node:process";
import { LocalBackend } from "../../packages/backends/dist/index.js";

const BASE = process.env.OPENAI_API_BASE ?? "http://localhost:4000";
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.EVERDICT_MODEL ?? "chatgpt/gpt-5.4-mini";
const VENV = "/tmp/everdict-aider";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) is required.");
  process.exit(1);
}

// Seed repo: a bug where add() returns the difference instead of the sum. aider must fix it.
const buggy = "def add(a, b):\n    return a - b\n";

const job = {
  harness: { id: "aider", version: "0.74.0" },
  harnessSpec: {
    kind: "command",
    id: "aider",
    version: "0.74.0",
    setup: [`python3 -m venv ${VENV}`, `${VENV}/bin/pip install -q --disable-pip-version-check aider-chat`],
    command: `${VENV}/bin/aider --yes --no-git --no-auto-commits --no-show-model-warnings --no-check-update --no-stream --edit-format whole --model openai/{{model}} --message {{task}} mathutils.py`,
    model: MODEL,
    env: { OPENAI_API_BASE: BASE, OPENAI_API_KEY: KEY }, // for the live run (properly, inject via the secret store)
    trace: { kind: "none" },
  },
  evalCase: {
    id: "aider-fix-add",
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
    tags: ["live", "aider", "litellm"],
  },
};

console.log(`aider(${MODEL} via ${BASE}) fixing a seeded bug … (pip install + LLM, may take a few min)`);
const t0 = Date.now();
const r = await new LocalBackend().dispatch(job);
console.log(`\nharness   : ${r.harness}   (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
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
    ? "\n✅ aider (gpt-5.4-mini) fixed the bug and passed tests-pass — real OSS harness live eval OK"
    : "\n⚠️ tests-pass did not pass (agent couldn't fix it — infra/connection works; see detail above)",
);
process.exit(0);
