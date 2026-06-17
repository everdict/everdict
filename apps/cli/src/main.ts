import { AppError, type Driver, type EvalCase, type EvaluableHarness, type Grader } from "@assay/core";
import { E2BLinuxDriver, LocalDriver } from "@assay/drivers";
import { RepoEnvironment } from "@assay/environments";
import { TestsPassGrader, costGrader, latencyGrader, stepsGrader } from "@assay/graders";
import { ClaudeCodeHarness, ScriptedHarness } from "@assay/harnesses";
import { runCase } from "@assay/runner";
import { runContextFromEnv } from "./config.js";

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, "true");
    }
  }
  return flags;
}

function usage(): void {
  console.error(
    [
      "assay run --task <text> [options]",
      "  --harness   claude-code | scripted     (default: claude-code)",
      "  --driver    local | e2b                (default: local)",
      "  --git <url> --ref <ref>                (default: empty repo)",
      "  --test <cmd>                           (tests-pass grader, run in work/)",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "run") {
    usage();
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(argv.slice(1));

  const task = flags.get("task");
  if (!task) {
    console.error("✗ --task 는 필수입니다.");
    usage();
    process.exitCode = 1;
    return;
  }

  const harnessName = flags.get("harness") ?? "claude-code";
  const driverName = flags.get("driver") ?? "local";
  const testCmd = flags.get("test");
  const git = flags.get("git");

  const ctx = runContextFromEnv();

  // claude CLI 는 이 머신의 구독(subscription) 로그인으로 동작한다 — LocalDriver 에선 별도 키 불필요.
  // 로그인이 없는 샌드박스 드라이버에선 ANTHROPIC_API_KEY 가 필요할 수 있다.
  if (harnessName === "claude-code" && driverName !== "local" && !ctx.apiKeyEnv.ANTHROPIC_API_KEY) {
    console.error("ℹ 샌드박스 드라이버인데 ANTHROPIC_API_KEY 가 없습니다 — claude 인증이 실패할 수 있습니다.");
  }

  const driver: Driver = driverName === "e2b" ? new E2BLinuxDriver() : new LocalDriver();
  const harness: EvaluableHarness =
    harnessName === "scripted"
      ? new ScriptedHarness("demo", () => [{ tool: "bash", cmd: "echo hello > out.txt" }])
      : new ClaudeCodeHarness(flags.get("harness-version") ?? "cli", { install: driverName === "e2b" });

  const graders: Grader[] = [stepsGrader, costGrader, latencyGrader];
  if (testCmd) graders.push(new TestsPassGrader(testCmd));

  const evalCase: EvalCase = {
    id: `cli-${process.pid}`,
    env: git
      ? { kind: "repo", source: { git, ref: flags.get("ref") ?? "HEAD" } }
      : { kind: "repo", source: { files: {} } },
    task,
    graders: graders.map((g) => g.id),
    timeoutSec: ctx.timeoutSec,
    tags: ["cli"],
  };

  console.error(`▶ ${harnessName} 실행 중 (driver=${driverName}) …`);
  try {
    const result = await runCase(evalCase, {
      driver,
      environment: new RepoEnvironment(),
      harness,
      graders,
      runCtx: ctx,
    });
    console.log(
      JSON.stringify(
        { harness: result.harness, scores: result.scores, trace: result.trace, diff: result.snapshot.diff },
        null,
        2,
      ),
    );
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`✗ ${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

void main();
