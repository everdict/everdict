import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { collectAuthEnv, hasClaudeAuth } from "@assay/agent";
import {
  BackendRegistry,
  BackendsConfigSchema,
  LocalBackend,
  NomadBackend,
  Router,
  buildRegistry,
} from "@assay/backends";
import { type AgentJob, AgentJobSchema, AppError, type GraderSpec, ScorecardSchema, SuiteSchema } from "@assay/core";
import { DirectOrchestrator, type Orchestrator, TemporalOrchestrator, runWorker } from "@assay/orchestrator";
import { diffScorecards, runSuite, summarizeScorecard } from "@assay/suite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runLeasedJob } from "./run-leased-job.js";

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
      "",
      "assay suite --suite <file.json> [--harness-version <v>] [--baseline <scorecard.json>] [--concurrency N]",
      "  run a suite (cases × a version) → Scorecard + summary; --baseline diffs two versions (regression)",
      "",
      "assay runner --pair <rnr_…> [--api-url <url>] [--wait-ms N] [--heartbeat-ms N]",
      "  self-hosted runner: pull workspace jobs to THIS machine, run locally (your login), report back",
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
async function probeDocker(): Promise<boolean> {
  try {
    await promisify(execFile)("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

// 설계: docs/architecture/self-hosted-runner.md (+ self-hosted-service-runner.md).
async function runnerCommand(flags: Map<string, string>): Promise<void> {
  const token = flags.get("pair") ?? process.env.ASSAY_RUNNER_TOKEN;
  if (!token || !token.startsWith("rnr_")) {
    console.error(
      "✗ --pair <rnr_…> (또는 ASSAY_RUNNER_TOKEN) 가 필요합니다 — 계정 페이지에서 디바이스를 페어링하세요.",
    );
    process.exitCode = 1;
    return;
  }
  const apiUrl = flags.get("api-url") ?? process.env.ASSAY_API_URL ?? "http://localhost:8787";
  const mcpUrl = new URL("/mcp", apiUrl);
  const pollMs = Number(flags.get("poll-interval-ms") ?? "2000"); // 에러 재시도 backoff
  const waitMs = Number(flags.get("wait-ms") ?? "25000"); // lease long-poll 대기(서버가 잡 생길 때까지 잡아둠)
  const hbMs = Number(flags.get("heartbeat-ms") ?? "30000"); // 실행 중 lease 갱신 주기
  if (!hasClaudeAuth()) {
    console.error(
      "ℹ 이 머신 env 에 claude 인증이 없습니다 — claude-code 잡은 이 머신의 로그인을 씁니다(없으면 실패할 수 있음).",
    );
  }

  const client = new Client({ name: "assay-runner", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  // 실제 capability 자가-광고: docker 데몬이 있으면 docker/browser(service 하니스 가능). 매 lease 마다 보고.
  const dockerOk = await probeDocker();
  const capabilities = ["repo", ...(dockerOk ? ["docker", "browser"] : [])];
  console.error(
    `▶ assay runner — ${mcpUrl} 연결됨. capabilities: ${capabilities.join(", ")}${dockerOk ? "" : " (docker 없음 → service 하니스 불가)"}. 잡 폴링 중(${pollMs}ms, Ctrl-C 종료) …`,
  );

  const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await client.callTool({ name, arguments: args });
    const t = (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    if (r.isError) throw new Error(t || `${name} 실패`);
    return JSON.parse(t) as Record<string, unknown>;
  };
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.error("\n▶ 종료 신호 — 현재 잡 후 정지합니다 …");
  });

  while (!stop) {
    let leased: Record<string, unknown>;
    try {
      leased = await callJson("lease_job", { wait_ms: waitMs, capabilities }); // long-poll + capability 자가-광고
    } catch (e) {
      console.error(`✗ lease 실패: ${errMsg(e)}`);
      await sleep(pollMs);
      continue;
    }
    if (!leased.job) {
      await sleep(250); // long-poll 타임아웃(잡 없음) — 즉시 재폴링(서버가 이미 대기)
      continue;
    }
    const jobId = String(leased.jobId);
    const parsed = AgentJobSchema.safeParse(leased.job); // 경계 검증
    if (!parsed.success) {
      console.error(`✗ 잡 ${jobId} 형식 오류 → fail 회신`);
      await callJson("fail_job", { jobId, message: `잡 형식 오류: ${parsed.error.message}` }).catch(() => {});
      continue;
    }
    console.error(`▶ 잡 ${jobId} (case ${parsed.data.evalCase.id}) 실행 …`);
    // 장기 실행 잡이 서버에서 재큐되지 않게 주기적 heartbeat 로 lease 갱신(기본 30s).
    const hb = setInterval(() => {
      void callJson("heartbeat_job", { jobId }).catch(() => {});
    }, hbMs);
    try {
      const result = await runLeasedJob(parsed.data); // service→로컬 Docker 토폴로지, 그 외→LocalDriver(이 머신)
      await callJson("submit_job_result", { jobId, result });
      console.error(`✓ 잡 ${jobId} 완료 → 회신`);
    } catch (e) {
      console.error(`✗ 잡 ${jobId} 실패: ${errMsg(e)} → fail 회신`);
      await callJson("fail_job", { jobId, message: errMsg(e) }).catch(() => {});
    } finally {
      clearInterval(hb);
    }
  }
  await client.close();
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
