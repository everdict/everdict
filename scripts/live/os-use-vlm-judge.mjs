// 라이브 e2e (SLICE 74): os-use 스크린샷을 VLM(비전) judge 로 자동 채점 — "화면이 목표 상태인가?".
// SLICE73 은 데스크탑 GUI 를 실제 구동(전이)까지였고, 채점은 DOM/바이트 체크였다. 여기선 *모델이 스크린샷을 보고*
// 태스크 목표 달성 여부를 판정하게 한다(벤치마크 종속 grader 없이 임의 데스크탑 태스크 자동 채점).
//
//   경로(전부 실제 프로덕션 코드):
//     judgeFromEnv(env) → modelJudge(openaiComplete(LiteLLM 프록시))  [실 VLM, gpt-5.4-mini]
//     JudgeGrader({useScreenshot:true, rubric}) → resolveScreenshot(os-use 스냅샷, compute=LocalDriver)
//       → 환경에서 `base64` 로 PNG 읽어 image_url(data-URL)로 멀티모달 전송 → JSON 판정.
//   검증: SLICE73 이 캡처한 실제 hermes os-use 스크린샷 2장으로 *목표/비목표 구분*.
//     after(Connect to Remote Hermes 폼=목표) → pass=true,  before(Welcome 랜딩=비목표) → pass=false.
//
// 키는 infra/litellm/.env(또는 OPENAI_API_KEY env)에서만 읽고 절대 출력/커밋하지 않는다.
import { readFileSync } from "node:fs";
import process from "node:process";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { JudgeGrader, judgeFromEnv } from "../../packages/graders/dist/index.js";

// --- judge env 구성(LiteLLM OpenAI-호환 프록시) ---
// assay/scripts/live → workclaw/infra/litellm/.env 는 4 단계 상위.
const ENV_PATH = process.env.LITELLM_ENV ?? "../../../../infra/litellm/.env";
function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(new URL(ENV_PATH, import.meta.url), "utf8");
    return (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const key = masterKey();
if (!key) {
  console.error("VLM 키 없음(OPENAI_API_KEY 또는 infra/litellm/.env 의 LITELLM_MASTER_KEY 필요).");
  process.exit(2);
}
const env = {
  ASSAY_JUDGE_MODEL: process.env.ASSAY_JUDGE_MODEL ?? "gpt-5.4-mini",
  ASSAY_JUDGE_PROVIDER: "openai",
  OPENAI_API_KEY: key,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1",
};

const judge = judgeFromEnv(env);
if (!judge) {
  console.error("judgeFromEnv 가 Judge 를 구성하지 못함.");
  process.exit(2);
}

// 데스크탑 태스크 목표 + 루브릭(벤치마크 종속 코드 0 — 유저가 데이터로 정의하는 그 자리).
const task = "Reach the 'Connect to Remote Hermes' screen where a user can type a remote Hermes API server URL.";
const rubric =
  "PASS only if a 'Server URL' input field for connecting to a remote server is visible on screen. " +
  "The initial welcome/landing screen (a 'Get Started' button, install hint) is NOT the goal state.";

const grader = new JudgeGrader(judge, { id: "vlm-judge", useScreenshot: true, rubric });

// os-use 스냅샷(SLICE73 이 캡처한 실 스크린샷, 절대경로).
const shots = [
  { label: "after  (Remote 연결폼 = 목표)", ref: process.env.SHOT_AFTER ?? "/tmp/hermes-after.png", expect: true },
  { label: "before (Welcome 랜딩 = 비목표)", ref: process.env.SHOT_BEFORE ?? "/tmp/hermes-before.png", expect: false },
];

const driver = new LocalDriver();
const compute = await driver.provision({ os: "linux", needs: ["shell"] });

console.log(`=== VLM judge 로 os-use 스크린샷 자동 채점 (model=${env.ASSAY_JUDGE_MODEL}) ===\n`);
let allOk = true;
try {
  for (const s of shots) {
    const score = await grader.grade({
      case: { id: "hermes", env: { kind: "os-use" }, task, graders: [], timeoutSec: 60, tags: [] },
      trace: [],
      snapshot: { kind: "os-use", screenshotRef: s.ref, windows: [] },
      compute,
    });
    const ok = score.pass === s.expect;
    allOk = allOk && ok;
    console.log(`${ok ? "✓" : "✗"} ${s.label}`);
    console.log(`    pass=${score.pass} score=${score.value} (기대 pass=${s.expect})`);
    console.log(`    reason: ${String(score.detail).slice(0, 200)}\n`);
  }
} finally {
  await compute.dispose();
}

console.log(
  allOk
    ? "✅ SLICE 74: VLM judge 가 os-use 스크린샷만 보고 데스크탑 태스크 목표 달성 여부를 정확히 판정 — 목표(Remote 폼)=pass, 비목표(Welcome)=fail. 벤치마크 종속 grader 없이 임의 데스크탑/UI 태스크를 모델이 자동 채점. (실 프로덕션 경로: judgeFromEnv→modelJudge→openaiComplete(image_url)→JudgeGrader.resolveScreenshot)"
    : "⚠️ 기대와 불일치(VLM 판정이 목표/비목표를 구분 못함)",
);
process.exit(allOk ? 0 : 1);
