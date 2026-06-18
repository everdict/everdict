// 라이브 검증(키 불필요): 선언형 command 하니스가 코드 어댑터 없이 end-to-end 로 동작한다.
// 유저가 등록할 HarnessSpec(kind:"command")을 잡에 임베드 → 에이전트가 CommandHarness 로 해석 →
// 실제 LocalDriver 샌드박스에서 명령 실행 → repo diff 스냅샷. (aider 도 동일 경로; 단 LLM 키 필요)
// 사용: node scripts/live/command-harness.mjs
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
  harnessSpec, // 컨트롤플레인이 레지스트리에서 풀어 임베드하는 것을 흉내
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
console.log(ok ? "\n✅ 선언형 command 하니스 end-to-end 동작(코드 0, LLM 키 0)" : "\n❌ result.txt 가 diff 에 없음");
process.exit(ok ? 0 : 1);
