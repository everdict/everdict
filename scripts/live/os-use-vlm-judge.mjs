// Live e2e (SLICE 74): auto-grade an os-use screenshot with a VLM (vision) judge — "is the screen in the goal state?".
// SLICE73 went up to actually driving (transitioning) the desktop GUI, with grading via DOM/byte checks. Here we let *the model look at the screenshot*
// and decide whether the task goal was met (auto-grade an arbitrary desktop task with no benchmark-specific grader).
//
//   Path (all real production code):
//     judgeFromEnv(env) → modelJudge(openaiComplete(LiteLLM proxy))  [real VLM, gpt-5.4-mini]
//     JudgeGrader({useScreenshot:true, rubric}) → resolveScreenshot(os-use snapshot, compute=LocalDriver)
//       → read the PNG as `base64` from the environment and send multimodal as image_url (data-URL) → JSON verdict.
//   Verify: distinguish *goal/non-goal* using 2 real hermes os-use screenshots captured by SLICE73.
//     after (Connect to Remote Hermes form = goal) → pass=true,  before (Welcome landing = non-goal) → pass=false.
//
// The key is read only from infra/litellm/.env (or the OPENAI_API_KEY env) and is never printed/committed.
import { readFileSync } from "node:fs";
import process from "node:process";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { JudgeGrader, judgeFromEnv } from "../../packages/graders/dist/index.js";

// --- judge env config (LiteLLM OpenAI-compatible proxy) ---
// everdict/scripts/live → workclaw/infra/litellm/.env is 4 levels up.
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
  console.error("no VLM key (OPENAI_API_KEY or LITELLM_MASTER_KEY in infra/litellm/.env required).");
  process.exit(2);
}
const env = {
  EVERDICT_JUDGE_MODEL: process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini",
  EVERDICT_JUDGE_PROVIDER: "openai",
  OPENAI_API_KEY: key,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1",
};

const judge = judgeFromEnv(env);
if (!judge) {
  console.error("judgeFromEnv failed to construct a Judge.");
  process.exit(2);
}

// Desktop task goal + rubric (zero benchmark-specific code — this is where the user defines it as data).
const task = "Reach the 'Connect to Remote Hermes' screen where a user can type a remote Hermes API server URL.";
const rubric =
  "PASS only if a 'Server URL' input field for connecting to a remote server is visible on screen. " +
  "The initial welcome/landing screen (a 'Get Started' button, install hint) is NOT the goal state.";

const grader = new JudgeGrader(judge, { id: "vlm-judge", useScreenshot: true, rubric });

// os-use snapshots (real screenshots captured by SLICE73, absolute paths).
const shots = [
  {
    label: "after  (Remote connect form = goal)",
    ref: process.env.SHOT_AFTER ?? "/tmp/hermes-after.png",
    expect: true,
  },
  {
    label: "before (Welcome landing = non-goal)",
    ref: process.env.SHOT_BEFORE ?? "/tmp/hermes-before.png",
    expect: false,
  },
];

const driver = new LocalDriver();
const compute = await driver.provision({ os: "linux", needs: ["shell"] });

console.log(`=== auto-grade os-use screenshots with a VLM judge (model=${env.EVERDICT_JUDGE_MODEL}) ===\n`);
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
    console.log(`    pass=${score.pass} score=${score.value} (expected pass=${s.expect})`);
    console.log(`    reason: ${String(score.detail).slice(0, 200)}\n`);
  }
} finally {
  await compute.dispose();
}

console.log(
  allOk
    ? "✅ SLICE 74: the VLM judge accurately decides whether the desktop task goal was met from the os-use screenshot alone — goal (Remote form)=pass, non-goal (Welcome)=fail. The model auto-grades an arbitrary desktop/UI task with no benchmark-specific grader. (real production path: judgeFromEnv→modelJudge→openaiComplete(image_url)→JudgeGrader.resolveScreenshot)"
    : "⚠️ does not match expectation (VLM verdict fails to distinguish goal/non-goal)",
);
process.exit(allOk ? 0 : 1);
