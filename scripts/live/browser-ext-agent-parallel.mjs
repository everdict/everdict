// Judged e2e + parallelism test: a browser agent drives a per-case, EXTENSION-LOADED browser (provisioned by the real
// Everdict buildBrowserJob) to a web page, answers, and an LLM judge scores it — then runs N cases in parallel to
// determine whether ~20 can run at once. The per-case browser is the scale unit (one Nomad alloc per case).
//
// Prereqs: nomad agent -dev + LiteLLM(:4000). Build the images:
//   docker build -t everdict-hello-ext:1   examples/browser-extensions/hello-ext
//   docker build -t everdict-bxa-agent:1    examples/bundles/browser-ext-agent/agent
//   docker build -t everdict-bxa-web:1      examples/bundles/browser-ext-agent/web
// Run:  node scripts/live/browser-ext-agent-parallel.mjs [N]   (default N=20)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const N = Number(process.argv[2] ?? 20);
const MODEL = process.env.LG_MODEL ?? "gpt-5.4-mini";
const EXT_IMAGE = "everdict-hello-ext:1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function llmKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    return (readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8").match(
      /^LITELLM_MASTER_KEY=(.+)$/m,
    ) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = llmKey();
if (!KEY) {
  console.error("no LLM key (OPENAI_API_KEY / infra/litellm/.env)");
  process.exit(2);
}

const docker = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

// LLM judge — scores the agent's answer against the expected fact (0..1). A real model verdict (the quality signal).
async function judge(task, expected, answer) {
  const body = {
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You grade an agent's web-task answer. Reply with ONLY a number: 1 if the answer contains the expected fact, else 0.",
      },
      { role: "user", content: `Task: ${task}\nExpected fact: ${expected}\nAgent answer: ${answer}\nScore (1 or 0):` },
    ],
  };
  const r = await fetch("http://127.0.0.1:4000/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const txt = (await r.json()).choices?.[0]?.message?.content ?? "0";
  return /1/.test(txt) ? 1 : 0;
}

const CASES = Array.from({ length: N }, (_, i) => ({
  id: `c${i}`,
  // Every case navigates the extension-browser to the shared test page and must report the secret number 4242.
  taskTmpl: (url) => `Navigate to ${url} and report the secret Everdict number stated on the page.`,
  expected: "4242",
}));

let webIp = "";
let agentUrl = "";

// Provision a per-case, extension-loaded browser. The image is what the real Everdict buildBrowserJob deploys for a
// target.extension harness (verified separately in browser-extension-nomad.mjs); here we run one per case on the docker
// bridge so the agent container reaches its CDP directly by IP. (Nomad dev publishes alloc ports on 127.0.0.1 only, so
// cross-alloc CDP isn't reachable there — a nomad-dev networking limit, not a scale limit.)
async function provisionBrowser(runId) {
  const name = `bxa-br-${runId}`;
  try {
    docker(["rm", "-f", name]);
  } catch {}
  docker(["run", "-d", "--name", name, EXT_IMAGE]);
  const ip = docker(["inspect", name, "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
  const cdp = `http://${ip}:9222`;
  // Wait until CDP actually answers (headful Chromium + Xvfb startup, ~10-15s).
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${cdp}/json/version`)).ok) return { name, cdp, hostCdp: cdp };
    } catch {}
    await sleep(2000);
  }
  throw new Error(`browser ${name} CDP not ready`);
}

async function runCase(c) {
  const t0 = Date.now();
  let br;
  try {
    br = await provisionBrowser(c.id);
    const task = c.taskTmpl(`http://${webIp}`);
    const resp = await fetch(`${agentUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, browser_cdp_url: br.cdp }),
    });
    const out = await resp.json();
    const score = await judge(task, c.expected, out.output ?? "");
    return {
      id: c.id,
      score,
      answer: String(out.output ?? "")
        .slice(0, 40)
        .replace(/\n/g, " "),
      err: out.error,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { id: c.id, score: 0, answer: "", err: String(e.message), ms: Date.now() - t0 };
  } finally {
    if (br) {
      try {
        docker(["rm", "-f", br.name]);
      } catch {}
    }
  }
}

async function main() {
  console.log(`\n\x1b[1mbrowser-agent × extension-browser — judged e2e + ${N}-parallel test\x1b[0m`);
  // Shared services: 1 test web page + 1 warm agent (docker). The per-case browsers are the Nomad-provisioned scale units.
  docker(["rm", "-f", "bxa-web", "bxa-agent"]);
  docker(["run", "-d", "--name", "bxa-web", "everdict-bxa-web:1"]);
  webIp = docker(["inspect", "bxa-web", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
  docker([
    "run",
    "-d",
    "--name",
    "bxa-agent",
    "-e",
    `OPENAI_API_KEY=${KEY}`,
    "-e",
    "OPENAI_BASE_URL=http://172.17.0.1:4000/v1",
    "-e",
    `MODEL=${MODEL}`,
    "everdict-bxa-agent:1",
  ]);
  const agIp = docker(["inspect", "bxa-agent", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
  agentUrl = `http://${agIp}:8000`;
  console.log(`web=${webIp} agent=${agIp} ; warming up…`);
  await sleep(12000);

  console.log("\n1) Judged e2e (single case)");
  const one = await runCase(CASES[0]);
  console.log(
    `   ${one.id}: answer="${one.answer}" judge=${one.score} (${(one.ms / 1000).toFixed(1)}s)${one.err ? ` err=${one.err}` : ""}`,
  );

  console.log(`\n2) ${N}-parallel — provision ${N} extension-browsers + drive + judge, all at once`);
  const memBefore = docker(["info", "--format", "{{.MemTotal}}"]);
  const t0 = Date.now();
  const results = await Promise.all(CASES.map(runCase));
  const wall = (Date.now() - t0) / 1000;
  const peakBrowsers =
    Number(
      docker(["ps", "-q", "--filter", `ancestor=${EXT_IMAGE}`])
        .split("\n")
        .filter(Boolean).length,
    ) || 0;

  const passed = results.filter((r) => r.score === 1).length;
  const errs = results.filter((r) => r.err).length;
  console.log("\n\x1b[1m=== SCORECARD (browser-ext-agent × judge) ===\x1b[0m");
  for (const r of results)
    console.log(
      `  ${r.id.padEnd(5)} judge=${r.score} ${(r.ms / 1000).toFixed(0).padStart(3)}s ${r.err ? `ERR:${r.err.slice(0, 40)}` : `"${r.answer}"`}`,
    );
  console.log("  ----");
  console.log(
    `  passRate=${((passed / N) * 100).toFixed(0)}% (${passed}/${N}) · errors=${errs} · wall=${wall.toFixed(0)}s · mem=${memBefore}`,
  );

  docker(["rm", "-f", "bxa-web", "bxa-agent"]);
  const ok = passed >= Math.ceil(N * 0.7);
  console.log(
    ok
      ? `\n\x1b[32m✅ ${N} extension-browser agent tasks ran in parallel; judged passRate=${((passed / N) * 100).toFixed(0)}%.\x1b[0m`
      : `\n\x1b[31m⚠️ ${N}-parallel degraded (passRate ${((passed / N) * 100).toFixed(0)}%, errors ${errs}) — see per-case.\x1b[0m`,
  );
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
