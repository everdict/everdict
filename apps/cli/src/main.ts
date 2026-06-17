import { collectAuthEnv, hasClaudeAuth } from "@assay/agent";
import { type Backend, LocalBackend, NomadBackend } from "@assay/backends";
import { type AgentJob, AppError, type GraderSpec } from "@assay/core";

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
      "  --harness     claude-code | scripted   (default: claude-code)",
      "  --backend     local | nomad            (default: local)",
      "  --git <url> --ref <ref>                (default: empty repo)",
      "  --test <cmd>                           (tests-pass grader, run in work/)",
      "  nomad: --nomad-addr <url> --image <ref> [--runtime runsc]",
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
  const backendName = flags.get("backend") ?? "local";
  const testCmd = flags.get("test");
  const git = flags.get("git");

  const graders: GraderSpec[] = [{ id: "steps" }, { id: "cost" }, { id: "latency" }];
  if (testCmd) graders.push({ id: "tests-pass", config: { cmd: testCmd } });

  const job: AgentJob = {
    harness: { id: harnessName, version: flags.get("harness-version") ?? (backendName === "local" ? "cli" : "latest") },
    evalCase: {
      id: `cli-${process.pid}`,
      env: git
        ? { kind: "repo", source: { git, ref: flags.get("ref") ?? "HEAD" } }
        : { kind: "repo", source: { files: {} } },
      task,
      graders,
      timeoutSec: Number(process.env.ASSAY_TIMEOUT_SEC ?? "300"),
      tags: ["cli"],
    },
  };

  let backend: Backend;
  if (backendName === "nomad") {
    const addr = flags.get("nomad-addr") ?? process.env.NOMAD_ADDR;
    const image = flags.get("image") ?? process.env.ASSAY_AGENT_IMAGE;
    if (!addr || !image) {
      console.error("✗ nomad 백엔드엔 --nomad-addr 와 --image (또는 NOMAD_ADDR / ASSAY_AGENT_IMAGE) 가 필요합니다.");
      process.exitCode = 1;
      return;
    }
    if (harnessName === "claude-code" && !hasClaudeAuth()) {
      console.error(
        [
          "✗ 샌드박스 잡엔 claude 인증이 필요합니다. .env 에 다음 중 하나:",
          "  • CLAUDE_CODE_OAUTH_TOKEN  (구독: 호스트 `claude setup-token`)",
          "  • ANTHROPIC_API_KEY        (API 과금)",
          "  ⚠ 이 값은 alloc 으로 전달됩니다 — 신뢰되는/셀프호스팅 Nomad 에서만.",
        ].join("\n"),
      );
      process.exitCode = 2;
      return;
    }
    backend = new NomadBackend({ addr, image, secretEnv: collectAuthEnv(), runtime: flags.get("runtime") });
  } else {
    backend = new LocalBackend();
  }

  console.error(`▶ ${harnessName} via ${backendName} 백엔드 …`);
  try {
    const result = await backend.dispatch(job);
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
