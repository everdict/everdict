import { readFileSync } from "node:fs";
import { collectAuthEnv, hasClaudeAuth } from "@assay/agent";
import {
  BackendRegistry,
  BackendsConfigSchema,
  LocalBackend,
  NomadBackend,
  Router,
  buildRegistry,
} from "@assay/backends";
import { type AgentJob, AppError, type GraderSpec } from "@assay/core";
import { DirectOrchestrator, type Orchestrator, TemporalOrchestrator, runWorker } from "@assay/orchestrator";

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
      "  --orchestrator direct | temporal       (default: direct)",
      "  --harness      claude-code | scripted   (default: claude-code)",
      "  --backend      local | nomad            (direct mode; default: local)",
      "  --git <url> --ref <ref> / --test <cmd>",
      "  nomad:    --nomad-addr <url> --image <ref> [--runtime runsc]",
      "  routing:  --backends-config <file> [--target <name>]",
      "  temporal: --temporal-address <addr> [--task-queue <q>]",
      "",
      "assay worker [--backends-config <file>] [--temporal-address <addr>] [--task-queue <q>]",
      "  long-running control-plane worker (runs activities = backend dispatch)",
    ].join("\n"),
  );
}

function buildJob(flags: Map<string, string>, task: string): AgentJob {
  const backendName = flags.get("backend") ?? "local";
  const explicitTarget = flags.get("target");
  const git = flags.get("git");
  const graders: GraderSpec[] = [{ id: "steps" }, { id: "cost" }, { id: "latency" }];
  const testCmd = flags.get("test");
  if (testCmd) graders.push({ id: "tests-pass", config: { cmd: testCmd } });
  return {
    harness: {
      id: flags.get("harness") ?? "claude-code",
      version: flags.get("harness-version") ?? (backendName === "local" ? "cli" : "latest"),
    },
    evalCase: {
      id: `cli-${process.pid}`,
      env: git
        ? { kind: "repo", source: { git, ref: flags.get("ref") ?? "HEAD" } }
        : { kind: "repo", source: { files: {} } },
      task,
      graders,
      timeoutSec: Number(process.env.ASSAY_TIMEOUT_SEC ?? "300"),
      tags: ["cli"],
      ...(explicitTarget ? { placement: { target: explicitTarget } } : {}),
    },
  };
}

// direct 모드용 Router 구성. 에러를 출력하고 exitCode 를 세팅했으면 undefined 반환.
function buildDirectRouter(flags: Map<string, string>): Router | undefined {
  const harnessName = flags.get("harness") ?? "claude-code";
  const backendName = flags.get("backend") ?? "local";
  const configPath = flags.get("backends-config") ?? process.env.ASSAY_BACKENDS_CONFIG;

  if (configPath) {
    const cfg = BackendsConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    const { registry, defaultTarget } = buildRegistry(cfg, { secretEnv: collectAuthEnv() });
    return new Router(registry, defaultTarget);
  }
  if (backendName === "nomad") {
    const addr = flags.get("nomad-addr") ?? process.env.NOMAD_ADDR;
    const image = flags.get("image") ?? process.env.ASSAY_AGENT_IMAGE;
    if (!addr || !image) {
      console.error("✗ nomad 백엔드엔 --nomad-addr 와 --image (또는 NOMAD_ADDR / ASSAY_AGENT_IMAGE) 가 필요합니다.");
      process.exitCode = 1;
      return undefined;
    }
    if (harnessName === "claude-code" && !hasClaudeAuth()) {
      console.error(
        "✗ 샌드박스 잡엔 CLAUDE_CODE_OAUTH_TOKEN 또는 ANTHROPIC_API_KEY 가 필요합니다(.env). ⚠ alloc 으로 전달됩니다.",
      );
      process.exitCode = 2;
      return undefined;
    }
    return new Router(
      new BackendRegistry().register(
        "nomad",
        new NomadBackend({ addr, image, secretEnv: collectAuthEnv(), runtime: flags.get("runtime") }),
      ),
      "nomad",
    );
  }
  return new Router(new BackendRegistry().register("local", new LocalBackend()), "local");
}

async function runCommand(flags: Map<string, string>): Promise<void> {
  const task = flags.get("task");
  if (!task) {
    console.error("✗ --task 는 필수입니다.");
    usage();
    process.exitCode = 1;
    return;
  }
  const job = buildJob(flags, task);
  const orchestratorName = flags.get("orchestrator") ?? "direct";

  let orch: Orchestrator;
  if (orchestratorName === "temporal") {
    // durable: 워크플로를 시작하고 결과를 기다린다. 실제 디스패치는 워커가 수행.
    orch = new TemporalOrchestrator({ address: flags.get("temporal-address"), taskQueue: flags.get("task-queue") });
  } else {
    const router = buildDirectRouter(flags);
    if (!router) return; // 에러 출력됨
    orch = new DirectOrchestrator(router);
  }

  console.error(`▶ ${job.harness.id} via ${orchestratorName} 오케스트레이터 …`);
  const result = await orch.run(job);
  console.log(
    JSON.stringify(
      {
        orchestrator: orchestratorName,
        harness: result.harness,
        scores: result.scores,
        trace: result.trace,
        snapshot: result.snapshot,
      },
      null,
      2,
    ),
  );
}

async function workerCommand(flags: Map<string, string>): Promise<void> {
  const configPath = flags.get("backends-config") ?? process.env.ASSAY_BACKENDS_CONFIG;
  const config = configPath ? BackendsConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))) : undefined;
  if (!hasClaudeAuth()) {
    console.error("ℹ worker env 에 claude 인증이 없습니다 — claude-code 잡이 샌드박스 백엔드에서 실패할 수 있습니다.");
  }
  console.error(
    `▶ assay worker — task queue '${flags.get("task-queue") ?? "assay-eval"}' @ ${flags.get("temporal-address") ?? "localhost:7233"} (Ctrl-C 종료) …`,
  );
  await runWorker({ address: flags.get("temporal-address"), taskQueue: flags.get("task-queue"), config });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  try {
    if (cmd === "run") {
      await runCommand(parseFlags(argv.slice(1)));
      return;
    }
    if (cmd === "worker") {
      await workerCommand(parseFlags(argv.slice(1)));
      return;
    }
    usage();
    process.exitCode = 1;
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
