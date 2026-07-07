// live e2e (SLICE 57): workspace default judge model → the control plane (RunService) fills in job.judge automatically.
// The user only puts a judge grader on the case (no model specified) and registers a default judge model in the workspace settings, then
// every run is inline-judge scored with that model. A per-request override beats the workspace default.
// process.env.EVERDICT_JUDGE_MODEL is left empty on purpose → the model must come only from the workspace settings → job.judge.
import process from "node:process";
import { RunService } from "../../apps/api/dist/run-service.js";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { InMemoryRunStore, InMemoryWorkspaceSettingsStore } from "../../packages/db/dist/index.js";

// biome-ignore lint/performance/noDelete: removing the process.env key is intentional (verifies only the workspace default applies)
delete process.env.EVERDICT_JUDGE_MODEL;
// biome-ignore lint/performance/noDelete: removing the process.env key is intentional (test isolation)
delete process.env.EVERDICT_JUDGE_PROVIDER;

const settings = new InMemoryWorkspaceSettingsStore();
// register the workspace default judge model (the key comes from secrets/env; here just model/provider).
await settings.set("acme", { judge: { provider: "openai", model: process.env.LLM_MODEL ?? "gpt-5.4-mini" } });

// dispatcher that runs the case in-process on the control plane (LocalBackend equivalent). runAgentJob builds the judge from job.judge.
const dispatcher = { dispatch: (job) => runAgentJob(job) };
const svc = new RunService({
  dispatcher,
  store: new InMemoryRunStore(),
  judgeFor: async (t) => (await settings.get(t))?.judge, // same wiring as main.ts
});

const judgeCase = {
  id: "create-file",
  env: { kind: "repo", source: { files: {} } },
  task: "Create a file out.txt containing hello.",
  graders: [
    { id: "steps" },
    {
      id: "judge",
      config: {
        id: "task-judge",
        rubric: "Did the agent run a command that creates out.txt? Pass only if a tool call did so.",
      },
    },
  ],
  timeoutSec: 120,
  tags: [],
};

async function runFor(tenant) {
  const rec = await svc.submit({ tenant, harness: { id: "scripted", version: "1.0.0" }, case: judgeCase });
  // track is fire-and-forget → poll until complete.
  for (let i = 0; i < 60; i++) {
    const r = await svc.get(rec.id);
    if (r && r.status !== "queued" && r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  return svc.get(rec.id);
}

console.log("=== workspace default judge model → job.judge auto-injection ===");
const acme = await runFor("acme"); // has a workspace default judge → real model verdict
const beta = await runFor("beta"); // no default → judge skipped

const jOf = (r) => r?.result?.scores?.find((s) => s.metric === "judge");
const ja = jOf(acme);
const jb = jOf(beta);
console.log(`\n[acme] status=${acme?.status}  judge: pass=${ja?.pass} value=${ja?.value?.toFixed?.(2) ?? ja?.value}`);
console.log(`   detail: ${String(ja?.detail).slice(0, 110)}`);
console.log(`[beta] status=${beta?.status}  judge: pass=${jb?.pass}  detail: ${String(jb?.detail).slice(0, 60)}`);

const ok =
  acme?.status === "succeeded" &&
  ja?.pass === true &&
  !String(ja?.detail).startsWith("skipped") &&
  beta?.status === "succeeded" &&
  jb?.pass === undefined &&
  String(jb?.detail).startsWith("skipped");

console.log(
  ok
    ? "\n✅ SLICE 57: the workspace default judge model is auto-injected as job.judge by the control plane (RunService) → acme gets real-model judge scoring (pass), and beta (no default) skips the judge. The user only needs a judge grader on the case (the model comes from workspace settings)."
    : "\n⚠️ does not match expectation",
);
process.exit(ok ? 0 : 1);
