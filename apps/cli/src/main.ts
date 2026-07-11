import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DriverMount, collectAuthEnv, hasClaudeAuth } from "@everdict/agent";
import { runSuite } from "@everdict/application-control";
import {
  BackendRegistry,
  BackendsConfigSchema,
  LocalBackend,
  NomadBackend,
  Router,
  buildRegistry,
} from "@everdict/backends";
import { type AgentJob, AppError, type GraderSpec, ScorecardSchema, SuiteSchema } from "@everdict/contracts";
import { diffScorecards, summarizeScorecard } from "@everdict/domain";
import { DirectOrchestrator, type Orchestrator, TemporalOrchestrator, runWorker } from "@everdict/orchestrator";
import {
  ResilientMcpSession,
  detectCapabilities,
  mcpConnect,
  runLeaseWorkers,
  runLeasedJob,
} from "@everdict/self-hosted-runner";
import type { DockerTopologyRuntimeOptions } from "@everdict/topology";
import { imageBakeCommand } from "./image-bake.js";
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
      "everdict image bake <base-ref> [--agent-image <ref>] [--tag <target-ref>]",
      "  wrap a BYO eval image with the everdict in-job agent (entrypoint) so it runs on MANAGED",
      "  runtimes (nomad/k8s run the case.image AS the task — it must boot the agent itself)",
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

// Build the Router for direct mode. Returns undefined if it printed an error and set exitCode.
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
      console.error("✗ nomad backend requires --nomad-addr and --image (or NOMAD_ADDR / EVERDICT_AGENT_IMAGE).");
      process.exitCode = 1;
      return undefined;
    }
    if (harnessName === "claude-code" && !hasClaudeAuth()) {
      console.error(
        "✗ Sandbox jobs require CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (.env). ⚠ It is passed into the alloc.",
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

// Build the orchestrator (direct/temporal). Returns undefined if it printed an error.
function buildOrchestrator(flags: Map<string, string>): Orchestrator | undefined {
  const orchestratorName = flags.get("orchestrator") ?? "direct";
  if (orchestratorName === "temporal") {
    // durable: start the workflow and wait for the result. The actual dispatch runs in the worker.
    return new TemporalOrchestrator({ address: flags.get("temporal-address"), taskQueue: flags.get("task-queue") });
  }
  const router = buildDirectRouter(flags);
  if (!router) return undefined;
  return new DirectOrchestrator(router);
}

async function runCommand(flags: Map<string, string>): Promise<void> {
  const task = flags.get("task");
  if (!task) {
    console.error("✗ --task is required.");
    usage();
    process.exitCode = 1;
    return;
  }
  const job = buildJob(flags, task);
  const orchestratorName = flags.get("orchestrator") ?? "direct";
  const orch = buildOrchestrator(flags);
  if (!orch) return; // error already printed

  console.error(`▶ ${job.harness.id} via ${orchestratorName} orchestrator …`);
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
    console.error("ℹ No claude auth in the worker env — claude-code jobs may fail on a sandbox backend.");
  }
  console.error(
    `▶ everdict worker — task queue '${flags.get("task-queue") ?? "everdict-eval"}' @ ${flags.get("temporal-address") ?? "localhost:7233"} (Ctrl-C to stop) …`,
  );
  await runWorker({ address: flags.get("temporal-address"), taskQueue: flags.get("task-queue"), config });
}

async function suiteCommand(flags: Map<string, string>): Promise<void> {
  const suitePath = flags.get("suite");
  if (!suitePath) {
    console.error("✗ --suite <file.json> is required.");
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

// Self-hosted runner — pull the workspace's jobs onto this machine, run them, and report back (push→pull).
// Authenticates to /mcp with the pairing token (rnr_) and lease_job → runLeasedJob (service→Docker topology / else→LocalDriver) → submit_job_result.
// Docker daemon reachability — when present, the runner advertises the docker/browser capability (runs a service harness as a local Docker topology).
// Design: docs/architecture/self-hosted-runner.md (+ self-hosted-service-runner.md).
async function runnerCommand(flags: Map<string, string>): Promise<void> {
  const token = flags.get("pair") ?? process.env.EVERDICT_RUNNER_TOKEN;
  if (!token || !token.startsWith("rnr_")) {
    console.error("✗ --pair <rnr_…> (or EVERDICT_RUNNER_TOKEN) is required — pair a device on the account page.");
    process.exitCode = 1;
    return;
  }
  const apiUrl = flags.get("api-url") ?? process.env.EVERDICT_API_URL ?? "http://localhost:8787";
  const mcpUrl = new URL("/mcp", apiUrl);
  const pollMs = Number(flags.get("poll-interval-ms") ?? "2000"); // error-retry backoff
  const waitMs = Number(flags.get("wait-ms") ?? "25000"); // lease long-poll wait (server holds until a job appears)
  const hbMs = Number(flags.get("heartbeat-ms") ?? "30000"); // lease-renewal interval while running
  // Number of lease workers to run concurrently — the knob by which one runner achieves case-level parallelism. Default 1 (preserves the current serial behavior).
  // Submitting a scorecard with concurrency=N parks N jobs, and only this many run at once (actual parallelism = min(N, this value)).
  const maxConcurrent = Math.max(1, Number(flags.get("max-concurrent") ?? "1"));
  // service(topology) harness readiness polling ceiling — the runtime default when a service spec does not declare its own readiness.
  const runtimeOptions: DockerTopologyRuntimeOptions = {};
  if (flags.has("ready-timeout-ms")) runtimeOptions.readyTimeoutMs = Number(flags.get("ready-timeout-ms"));
  if (flags.has("ready-interval-ms")) runtimeOptions.pollIntervalMs = Number(flags.get("ready-interval-ms"));
  if (!hasClaudeAuth()) {
    console.error(
      "ℹ No claude auth in this machine's env — claude-code jobs use this machine's login (may fail if absent).",
    );
  }

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  // Real capability self-advertisement: if the docker daemon is present, docker/browser (service harnesses possible). Reported on every lease.
  const capabilities = await detectCapabilities();
  const dockerOk = capabilities.includes("docker");

  // codex login mount (opt-in): with --mount-codex-login, mount this runner's codex login directory into the
  // containerized job's container at /codex → codex inside the image authenticates with the machine login (own-pays, no API key). The harness references it via CODEX_HOME=/codex.
  // Security: explicit opt-in (the runner owner's decision) — because the login credential is exposed to the job container this runner runs.
  const mounts: DriverMount[] = [];
  if (flags.has("mount-codex-login")) {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    if (dockerOk && existsSync(codexHome)) {
      mounts.push({ source: codexHome, target: "/codex" }); // rw — codex needs to write the token refresh / lock file
      console.error(
        `▶ codex login mount: ${codexHome} → /codex (containerized jobs). Reference it via CODEX_HOME=/codex in the harness.`,
      );
    } else {
      console.error(`⚠ --mount-codex-login: ${dockerOk ? `${codexHome} not found` : "no docker"} → skipping mount.`);
    }
  }

  // wedge prevention: a resilient MCP session (@everdict/runner-core) that auto-reinitializes on API restart/disconnect. Lazy connect.
  const session = new ResilientMcpSession(mcpConnect(mcpUrl, token));
  try {
    await session.ensureConnected();
    console.error(
      `▶ everdict runner — connected to ${mcpUrl}. capabilities: ${capabilities.join(", ")}${dockerOk ? "" : " (no docker → service harnesses unavailable)"}. Polling for jobs with ${maxConcurrent} concurrent worker(s) (Ctrl-C to stop) …`,
    );
  } catch (e) {
    console.error(`⚠ Initial connection failed (${errMsg(e)}) — retrying while polling …`);
  }

  const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await session.call(name, args); // if the session died, it reinitializes internally and retries
    if (r.isError) throw new Error(r.text || `${name} failed`);
    return JSON.parse(r.text) as Record<string, unknown>;
  };

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.error("\n▶ Stop signal — stopping after the current job …");
  });

  // maxConcurrent workers share the same session and lease/run/report concurrently — one runner achieves case-level parallelism.
  await runLeaseWorkers(
    {
      callJson,
      // service→Docker topology / image-case→local Docker (DockerDriver, dockerOk gate, host mounts) / else→host LocalDriver
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
      // the positional arg (local ref) is not consumed by the flag parser, so handle it directly — image push <ref> [--flags]
      const positional = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
      await imagePushCommand(positional, parseFlags(argv.slice(2)));
      return;
    }
    if (cmd === "image" && argv[1] === "bake") {
      const positional = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
      await imageBakeCommand(positional, parseFlags(argv.slice(2)));
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
