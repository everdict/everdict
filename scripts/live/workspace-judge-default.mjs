// 라이브 e2e (SLICE 57): 워크스페이스 기본 judge 모델 → 컨트롤플레인(RunService)이 job.judge 를 자동으로 채움.
// 유저는 케이스에 judge grader 만 두고(모델 미지정), 워크스페이스 설정에 기본 judge 모델만 등록하면
// 모든 run 이 그 모델로 inline judge 채점된다. 요청별 override 가 워크스페이스 기본을 이긴다.
// process.env.EVERDICT_JUDGE_MODEL 은 일부러 비운다 → 모델은 오직 워크스페이스 설정 → job.judge 에서 와야 한다.
import process from "node:process";
import { RunService } from "../../apps/api/dist/run-service.js";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { InMemoryRunStore, InMemoryWorkspaceSettingsStore } from "../../packages/db/dist/index.js";

// biome-ignore lint/performance/noDelete: process.env 키 제거가 의도(워크스페이스 기본값만 적용됨을 검증)
delete process.env.EVERDICT_JUDGE_MODEL;
// biome-ignore lint/performance/noDelete: process.env 키 제거가 의도(테스트 격리)
delete process.env.EVERDICT_JUDGE_PROVIDER;

const settings = new InMemoryWorkspaceSettingsStore();
// 워크스페이스 기본 judge 모델 등록(키는 시크릿/ env, 여기엔 모델/프로바이더만).
await settings.set("acme", { judge: { provider: "openai", model: process.env.LLM_MODEL ?? "gpt-5.4-mini" } });

// 컨트롤플레인이 in-process 로 케이스를 돌리는 디스패처(LocalBackend 동치). runAgentJob 이 job.judge 로 judge 구성.
const dispatcher = { dispatch: (job) => runAgentJob(job) };
const svc = new RunService({
  dispatcher,
  store: new InMemoryRunStore(),
  judgeFor: async (t) => (await settings.get(t))?.judge, // main.ts 와 동일 배선
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
  // track 은 fire-and-forget → 완료까지 폴링.
  for (let i = 0; i < 60; i++) {
    const r = await svc.get(rec.id);
    if (r && r.status !== "queued" && r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  return svc.get(rec.id);
}

console.log("=== 워크스페이스 기본 judge 모델 → job.judge 자동 주입 ===");
const acme = await runFor("acme"); // 워크스페이스 기본 judge 있음 → 실 모델 판정
const beta = await runFor("beta"); // 기본 없음 → judge skip

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
    ? "\n✅ SLICE 57: 워크스페이스 기본 judge 모델이 컨트롤플레인(RunService)에서 job.judge 로 자동 주입 → acme 는 실 모델 judge 채점(pass), 기본 없는 beta 는 judge skip. 유저는 케이스에 judge grader 만 두면 됨(모델은 워크스페이스 설정)."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
