import { AppError, type Driver, type EvalCase, type EvaluableHarness, type Grader } from "@assay/core";
import { E2BLinuxDriver, LocalDriver } from "@assay/drivers";
import { RepoEnvironment } from "@assay/environments";
import { TestsPassGrader, costGrader, latencyGrader, stepsGrader } from "@assay/graders";
import { ClaudeCodeHarness, ScriptedHarness } from "@assay/harnesses";
import { runCase } from "@assay/runner";
import { hasClaudeAuth, runContextFromEnv } from "./config.js";

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

  // LocalDriver 는 이 머신의 claude 구독 로그인을 그대로 쓴다(키 불필요).
  // 샌드박스(비-local)엔 로그인이 없으므로 구독 토큰/키가 env 로 주입돼야 한다.
  if (harnessName === "claude-code" && driverName !== "local" && !hasClaudeAuth(ctx)) {
    console.error(
      [
        "✗ 샌드박스 드라이버엔 claude 인증이 없습니다. 다음 중 하나를 .env 에 설정하세요:",
        "  • CLAUDE_CODE_OAUTH_TOKEN  (구독: 호스트에서 `claude setup-token` 실행 후 그 토큰)",
        "  • ANTHROPIC_API_KEY        (API 과금)",
        "  ⚠ 이 값은 샌드박스로 전달됩니다 — 신뢰되는/셀프호스팅 샌드박스에서만 쓰세요.",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const harnessVersion = flags.get("harness-version") ?? (driverName === "e2b" ? "latest" : "cli");
  const driver: Driver = driverName === "e2b" ? new E2BLinuxDriver() : new LocalDriver();
  const harness: EvaluableHarness =
    harnessName === "scripted"
      ? new ScriptedHarness("demo", () => [{ tool: "bash", cmd: "echo hello > out.txt" }])
      : new ClaudeCodeHarness(harnessVersion, { install: driverName === "e2b" });

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
