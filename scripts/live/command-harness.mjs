// Live verification (no key needed): the declarative command harness works end-to-end with no code adapter.
// Embed a user-registered HarnessSpec(kind:"command") in the job → the agent interprets it as a CommandHarness →
// runs the command in a real LocalDriver sandbox → repo diff snapshot. (aider takes the same path; it just needs an LLM key.)
// Usage: node scripts/live/command-harness.mjs
import { LocalBackend } from "../../packages/backends/dist/index.js";

const harnessSpec = {
  kind: "command",
  id: "echo-agent",
  version: "1.0.0",
  setup: [],
  command: "echo solved-{{run_id}} > result.txt",
  env: {},
  trace: { kind: "none" },
};

const job = {
  harness: { id: "echo-agent", version: "1.0.0" },
  harnessSpec, // mimics what the control plane pulls from the registry and embeds
  evalCase: {
    id: "cmd-live-1",
    env: { kind: "repo", source: { files: {} } },
    task: "write result.txt",
    graders: [{ id: "steps" }, { id: "latency" }],
    timeoutSec: 120,
    tags: ["live", "command"],
  },
};

const r = await new LocalBackend().dispatch(job);
console.log("harness   :", r.harness);
console.log("changed   :", r.snapshot.changedFiles);
console.log("diff      :", JSON.stringify(r.snapshot.diff).slice(0, 80));
console.log("scores    :", r.scores.map((s) => `${s.graderId}:${s.value}`).join(", "));
const ok = (r.snapshot.changedFiles ?? []).includes("result.txt");
console.log(
  ok ? "\n✅ declarative command harness works end-to-end (0 code, 0 LLM key)" : "\n❌ result.txt not in the diff",
);
process.exit(ok ? 0 : 1);
