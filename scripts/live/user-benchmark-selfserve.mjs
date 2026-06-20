// 라이브 e2e (SLICE 60): SaaS 유저가 *새* 테스트-실행 벤치마크를 first-party 코드 0줄로 스스로 추가.
// 벤치마크 = 순수 데이터(EvalCase): env.source(코드) + env.setup(의존성 프로비저닝 명령) + graders=[제네릭 command].
// 카탈로그 어댑터도, swe-bench 같은 전용 grader 도 없이 → runCase 풀 루프 + 실 pytest 로 채점.
//   A) 수정 O + setup O → resolved
//   B) 수정 X + setup O → unresolved (테스트 실패)
//   C) 수정 O + setup X → unresolved (의존성 미프로비저닝 → ImportError) = env.setup 이 load-bearing 데이터 훅임을 증명
import { Buffer } from "node:buffer";
import process from "node:process";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { ScriptedHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";

// 유저가 import 한 새 벤치마크의 케이스(순수 데이터; 우리 코드에 이 벤치마크 관련 줄은 전혀 없음).
const FILES = {
  // lib 는 setup 이 생성하는 _deps 모듈에 의존 → env.setup(의존성 프로비저닝)이 없으면 import 실패.
  "lib.py": "from _deps import OFFSET\n\ndef solve(x):\n    return x + OFFSET  # BUG: should be x*2\n",
  "make_deps.py": "open('_deps.py', 'w').write('OFFSET = 0\\n')\n",
  "test_lib.py": "from lib import solve\n\ndef test_solve():\n    assert solve(3) == 6\n",
};
const userCase = (withSetup) => ({
  id: "fix-solve",
  env: {
    kind: "repo",
    source: { files: FILES },
    ...(withSetup ? { setup: ["python3 make_deps.py"] } : {}), // 의존성 프로비저닝 = 데이터(유저 제공)
  },
  task: "Fix solve() in lib.py so test_lib passes (should return x*2).",
  // 채점도 데이터 — 제네릭 command grader(벤치마크 전용 코드 없음).
  graders: [{ id: "command", config: { cmd: "python3 -m pytest -q --no-header test_lib.py", metric: "resolved" } }],
  timeoutSec: 60,
  tags: [],
});

// 에이전트 하니스: 수정안을 만드는 ScriptedHarness(에이전트 자리). base64 로 따옴표 이슈 회피.
const FIXED = "from _deps import OFFSET\n\ndef solve(x):\n    return x * 2 + OFFSET\n";
const fixPlan = () => [{ tool: "bash", cmd: `echo ${Buffer.from(FIXED).toString("base64")} | base64 -d > lib.py` }];
const noopPlan = () => [];

async function run(label, { fix, setup }) {
  const result = await runCase(userCase(setup), {
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness: new ScriptedHarness("1.0.0", fix ? fixPlan : noopPlan),
    graders: makeGraders(userCase(setup).graders),
    runCtx: { apiKeyEnv: {}, timeoutSec: 300 },
  });
  const s = result.scores.find((x) => x.metric === "resolved");
  console.log(`[${label}] resolved=${s?.pass}  ${String(s?.detail).split("\n").slice(-2)[0]?.slice(0, 60) ?? ""}`);
  return s;
}

console.log("=== 유저 정의 새 벤치마크 (카탈로그/전용 grader 코드 0줄) — runCase + 실 pytest ===");
const a = await run("fix + setup ", { fix: true, setup: true });
const b = await run("no-fix+setup", { fix: false, setup: true });
const c = await run("fix + NO setup", { fix: true, setup: false });

const ok = a?.pass === true && b?.pass === false && c?.pass === false;
console.log(
  ok
    ? "\n✅ SLICE 60: 유저가 새 테스트-실행 벤치마크를 순수 데이터로 정의(env.source+env.setup+제네릭 command grader) → first-party 코드 없이 runCase 풀 루프 + 실 pytest 로 채점. 수정 O→resolved, 수정 X→unresolved, setup 없으면 의존성 미프로비저닝→unresolved(=env.setup 이 데이터 훅). SWE-bench 류는 이 위의 프리셋일 뿐."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
