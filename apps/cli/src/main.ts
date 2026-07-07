import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DriverMount, collectAuthEnv, hasClaudeAuth } from "@everdict/agent";
import {
  BackendRegistry,
  BackendsConfigSchema,
  LocalBackend,
  NomadBackend,
  Router,
  buildRegistry,
} from "@everdict/backends";
import { type AgentJob, AppError, type GraderSpec, ScorecardSchema, SuiteSchema } from "@everdict/core";
import { DirectOrchestrator, type Orchestrator, TemporalOrchestrator, runWorker } from "@everdict/orchestrator";
import {
  ResilientMcpSession,
  detectCapabilities,
  mcpConnect,
  runLeaseWorkers,
  runLeasedJob,
} from "@everdict/runner-core";
import { diffScorecards, runSuite, summarizeScorecard } from "@everdict/suite";
import type { DockerTopologyRuntimeOptions } from "@everdict/topology";
import { imagePushCommand } from "./image-push.js";

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
      "everdict run --task <text> [options]",
      "  --orchestrator direct | temporal       (default: direct)",
      "  --harness      claude-code | scripted   (default: claude-code)",
      "  --backend      local | nomad            (direct mode; default: local)",
      "  --git <url> --ref <ref> / --test <cmd>",
      "  nomad:    --nomad-addr <url> --image <ref> [--runtime runsc]",
      "  routing:  --backends-config <file> [--target <name>]",
      "  temporal: --temporal-address <addr> [--task-queue <q>]",
      "",
      "everdict worker [--backends-config <file>] [--temporal-address <addr>] [--task-queue <q>]",
      "  long-running control-plane worker (runs activities = backend dispatch)",
      "",
      "everdict suite --suite <file.json> [--harness-version <v>] [--baseline <scorecard.json>] [--concurrency N]",
      "  run a suite (cases × a version) → Scorecard + summary; --baseline diffs two versions (regression)",
      "",
      "everdict image push <local-ref> [--name <n>] [--tag <t>] [--api-url <url>] [--api-key <ak_…>]",
      "  publish a locally built image to the workspace image registry (docker tag+push,",
      "  credentials minted by the control plane, isolated temp DOCKER_CONFIG) → prints the ref to pin",
      "",
      "everdict runner --pair <rnr_…> [--api-url <url>] [--wait-ms N] [--heartbeat-ms N] [--max-concurrent N]",
      "  self-hosted runner: pull workspace jobs to THIS machine, run locally (your login), report back",
      "  --max-concurrent N: run N lease workers at once (case-level parallelism; default 1)",
      "  --mount-codex-login: bind ~/.codex into containerized (case.image) jobs → codex runs in-image with your login",
      "  service harness readiness: [--ready-timeout-ms N] [--ready-interval-ms N] (topology endpoint polling)",
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
      timeoutSec: Number(process.env.EVERDICT_TIMEOUT_SEC ?? "300"),
      tags: ["cli"],
      ...(explicitTarget ? { placement: { target: explicitTarget } } : {}),
    },
  };
}

// direct 모드용 Router 구성. 에러를 출력하고 exitCode 를 세팅했으면 undefined 반환.
function buildDirectRouter(flags: Map<string, string>): Router | undefined {
  const harnessName = flags.get("harness") ?? "claude-code";
  const backendName = flags.get("backend") ?? "local";
  const configPath = flags.get("backends-config") ?? process.env.EVERDICT_BACKENDS_CONFIG;

  if (configPath) {
    const cfg = BackendsConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    const { registry, defaultTarget } = buildRegistry(cfg, { secretEnv: collectAuthEnv() });
    return new Router(registry, defaultTarget);
  }
  if (backendName === "nomad") {
    const addr = flags.get("nomad-addr") ?? process.env.NOMAD_ADDR;
    const image = flags.get("image") ?? process.env.EVERDICT_AGENT_IMAGE;
    if (!addr || !image) {
      console.error("✗ nomad 백엔드엔 --nomad-addr 와 --image (또는 NOMAD_ADDR / EVERDICT_AGENT_IMAGE) 가 필요합니다.");
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

// orchestrator(direct/temporal) 구성. 에러를 출력했으면 undefined.
function buildOrchestrator(flags: Map<string, string>): Orchestrator | undefined {
  const orchestratorName = flags.get("orchestrator") ?? "direct";
  if (orchestratorName === "temporal") {
    // durable: 워크플로를 시작하고 결과를 기다린다. 실제 디스패치는 워커가 수행.
    return new TemporalOrchestrator({ address: flags.get("temporal-address"), taskQueue: flags.get("task-queue") });
  }
  const router = buildDirectRouter(flags);
  if (!router) return undefined;
  return new DirectOrchestrator(router);
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
  const orch = buildOrchestrator(flags);
  if (!orch) return; // 에러 출력됨

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
  const configPath = flags.get("backends-config") ?? process.env.EVERDICT_BACKENDS_CONFIG;
  const config = configPath ? BackendsConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))) : undefined;
  if (!hasClaudeAuth()) {
    console.error("ℹ worker env 에 claude 인증이 없습니다 — claude-code 잡이 샌드박스 백엔드에서 실패할 수 있습니다.");
  }
  console.error(
    `▶ everdict worker — task queue '${flags.get("task-queue") ?? "everdict-eval"}' @ ${flags.get("temporal-address") ?? "localhost:7233"} (Ctrl-C 종료) …`,
  );
  await runWorker({ address: flags.get("temporal-address"), taskQueue: flags.get("task-queue"), config });
}

async function suiteCommand(flags: Map<string, string>): Promise<void> {
  const suitePath = flags.get("suite");
  if (!suitePath) {
    console.error("✗ --suite <file.json> 는 필수입니다.");
    process.exitCode = 1;
    return;
  }
  const suite = SuiteSchema.parse(JSON.parse(readFileSync(suitePath, "utf8")));
  const version = flags.get("harness-version") ?? "latest";
  const orch = buildOrchestrator(flags);
  if (!orch) return;

  console.error(`▶ suite '${suite.id}' (${suite.cases.length} cases) × ${suite.harness.id}@${version} …`);
  const scorecard = await runSuite(suite, version, (job) => orch.run(job), {
    concurrency: Number(flags.get("concurrency") ?? "4"),
  });

  const out: Record<string, unknown> = { scorecard, summary: summarizeScorecard(scorecard) };
  const baselinePath = flags.get("baseline");
  if (baselinePath) {
    const baseline = ScorecardSchema.parse(JSON.parse(readFileSync(baselinePath, "utf8")));
    out.diff = diffScorecards(baseline, scorecard);
  }
  console.log(JSON.stringify(out, null, 2));
}

// 셀프호스티드 러너 — 이 머신에서 워크스페이스의 잡을 가져가(pull) 돌리고 결과를 회신한다(push→pull).
// 페어링 토큰(rnr_)으로 /mcp 에 인증하고 lease_job → runLeasedJob(service→Docker 토폴로지/그외→LocalDriver) → submit_job_result.
// docker 데몬 도달성 — 있으면 러너가 docker/browser capability 를 광고(service 하니스를 로컬 Docker 토폴로지로 구동).
// 설계: docs/architecture/self-hosted-runner.md (+ self-hosted-service-runner.md).
async function runnerCommand(flags: Map<string, string>): Promise<void> {
  const token = flags.get("pair") ?? process.env.EVERDICT_RUNNER_TOKEN;
  if (!token || !token.startsWith("rnr_")) {
    console.error(
      "✗ --pair <rnr_…> (또는 EVERDICT_RUNNER_TOKEN) 가 필요합니다 — 계정 페이지에서 디바이스를 페어링하세요.",
    );
    process.exitCode = 1;
    return;
  }
  const apiUrl = flags.get("api-url") ?? process.env.EVERDICT_API_URL ?? "http://localhost:8787";
  const mcpUrl = new URL("/mcp", apiUrl);
  const pollMs = Number(flags.get("poll-interval-ms") ?? "2000"); // 에러 재시도 backoff
  const waitMs = Number(flags.get("wait-ms") ?? "25000"); // lease long-poll 대기(서버가 잡 생길 때까지 잡아둠)
  const hbMs = Number(flags.get("heartbeat-ms") ?? "30000"); // 실행 중 lease 갱신 주기
  // 동시에 돌릴 lease 워커 수 — 한 러너가 case-level 병렬을 실현하는 손잡이. 기본 1(현행 직렬 보존).
  // 스코어카드를 concurrency=N 으로 제출하면 N 개 잡이 파킹되고, 이 값만큼만 동시 실행된다(실병렬 = min(N, 이값)).
  const maxConcurrent = Math.max(1, Number(flags.get("max-concurrent") ?? "1"));
  // service(topology) 하니스 readiness 폴링 상한 — 서비스 스펙이 자체 readiness 를 선언하지 않을 때의 런타임 기본.
  const runtimeOptions: DockerTopologyRuntimeOptions = {};
  if (flags.has("ready-timeout-ms")) runtimeOptions.readyTimeoutMs = Number(flags.get("ready-timeout-ms"));
  if (flags.has("ready-interval-ms")) runtimeOptions.pollIntervalMs = Number(flags.get("ready-interval-ms"));
  if (!hasClaudeAuth()) {
    console.error(
      "ℹ 이 머신 env 에 claude 인증이 없습니다 — claude-code 잡은 이 머신의 로그인을 씁니다(없으면 실패할 수 있음).",
    );
  }

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  // 실제 capability 자가-광고: docker 데몬이 있으면 docker/browser(service 하니스 가능). 매 lease 마다 보고.
  const capabilities = await detectCapabilities();
  const dockerOk = capabilities.includes("docker");

  // codex 로그인 마운트(opt-in): --mount-codex-login 이면 이 러너의 codex 로그인 디렉터리를 containerize 되는 잡의 컨테이너에
  // /codex 로 마운트 → 이미지 안 codex 가 머신 로그인으로 인증(own-pays, API 키 불필요). 하니스는 CODEX_HOME=/codex 로 참조.
  // 보안: 명시적 opt-in(러너 소유자 결정) — 로그인 자격이 그 러너가 도는 잡 컨테이너에 노출되므로.
  const mounts: DriverMount[] = [];
  if (flags.has("mount-codex-login")) {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    if (dockerOk && existsSync(codexHome)) {
      mounts.push({ source: codexHome, target: "/codex" }); // rw — codex 가 토큰 리프레시/락 파일에 쓰기 필요
      console.error(
        `▶ codex 로그인 마운트: ${codexHome} → /codex (containerize 잡). 하니스에서 CODEX_HOME=/codex 로 참조하세요.`,
      );
    } else {
      console.error(`⚠ --mount-codex-login: ${dockerOk ? `${codexHome} 없음` : "docker 없음"} → 마운트 생략.`);
    }
  }

  // wedge 방지: API 재시작/단절 시 세션을 자동 재초기화하는 회복형 MCP 세션(@everdict/runner-core). 지연 연결.
  const session = new ResilientMcpSession(mcpConnect(mcpUrl, token));
  try {
    await session.ensureConnected();
    console.error(
      `▶ everdict runner — ${mcpUrl} 연결됨. capabilities: ${capabilities.join(", ")}${dockerOk ? "" : " (docker 없음 → service 하니스 불가)"}. 동시 ${maxConcurrent} 워커로 잡 폴링 중(Ctrl-C 종료) …`,
    );
  } catch (e) {
    console.error(`⚠ 초기 연결 실패(${errMsg(e)}) — 폴링하며 재시도합니다 …`);
  }

  const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await session.call(name, args); // 세션이 죽었으면 내부에서 재초기화 후 재시도
    if (r.isError) throw new Error(r.text || `${name} 실패`);
    return JSON.parse(r.text) as Record<string, unknown>;
  };

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.error("\n▶ 종료 신호 — 현재 잡 후 정지합니다 …");
  });

  // maxConcurrent 워커가 같은 세션을 공유하며 동시에 lease/실행/회신 — 한 러너가 case-level 병렬을 실현.
  await runLeaseWorkers(
    {
      callJson,
      // service→Docker 토폴로지 / image-케이스→로컬 Docker(DockerDriver, dockerOk 게이트, 호스트 마운트) / 그 외→호스트 LocalDriver
      runJob: (job) =>
        runLeasedJob(job, { runtimeOptions, dockerAvailable: dockerOk, mounts, log: (m) => console.error(m) }),
      log: (m) => console.error(m),
      sleep,
    },
    { maxConcurrent, waitMs, heartbeatMs: hbMs, pollMs, capabilities, shouldStop: () => stop },
  );
  await session.close();
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
    if (cmd === "suite") {
      await suiteCommand(parseFlags(argv.slice(1)));
      return;
    }
    if (cmd === "runner") {
      await runnerCommand(parseFlags(argv.slice(1)));
      return;
    }
    if (cmd === "image" && argv[1] === "push") {
      // 위치 인자(로컬 ref)는 플래그 파서가 안 먹으므로 직접 — image push <ref> [--flags]
      const positional = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
      await imagePushCommand(positional, parseFlags(argv.slice(2)));
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
