// A REAL LLM-driven browser agent, judged end-to-end, with an ablation that proves the client extension is required.
//
// The agent (examples/bundles/browser-ext-agent/agent-real) is a genuine ReAct loop: the LLM observes the page's
// interactive elements + visible text, DECIDES one browser action (goto / type / click / read / finish), the agent
// executes it over CDP, re-observes, and repeats. NOTHING about the task steps is scripted — the model drives the
// browser itself. We send it a task, print its decision TRACE (proof it controls the browser), and an LLM judge scores
// the answer.
//
// Ablation (proves the extension is genuinely used, not merely loaded):
//   (A) WITH the extractor extension — the results page's masked access code is unmasked into #__ext_extracted; the
//       agent reads it and answers EVDX-4242 → judge=1.
//   (B) WITHOUT it (control) — the code stays masked (••••••••); the honest agent reports it cannot find the code →
//       judge=0. Different agent behaviour driven by the real page state = not scripted, not hallucinated.
//
// Prereqs: LiteLLM(:4000). Images are built by this script if missing:
//   examples/browser-extensions/extractor-ext   -> everdict-extractor-ext:1  (unmasks the code)
//   examples/browser-extensions/hello-ext        -> everdict-hello-ext:1       (no-extractor control)
//   examples/bundles/browser-ext-agent/agent-real -> everdict-bxa-agent-real:1 (the real agent)
//   examples/bundles/browser-ext-agent/tasksite   -> everdict-bxa-tasksite:1   (search form -> masked results)
// Run:  node scripts/live/browser-ext-task-e2e.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MODEL = process.env.LG_MODEL ?? "gpt-5.4-mini";
const EXPECTED = "EVDX-4242";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (a) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const dtry = (a) => {
  try {
    // stderr piped (not inherited) so best-effort cleanups don't spam "No such container".
    return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
};
const ip = (name) => docker(["inspect", name, "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
const haveImage = (t) => dtry(["image", "inspect", t]) !== "";
const buildIfMissing = (tag, ctx) => {
  if (!haveImage(tag)) {
    console.log(`  building ${tag} …`);
    docker(["build", "-q", "-t", tag, ctx]);
  }
};

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
  console.error("no LLM key (set OPENAI_API_KEY or infra/litellm/.env)");
  process.exit(2);
}

async function judge(answer) {
  const r = await fetch("http://127.0.0.1:4000/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "Grade an agent's answer. Reply ONLY 1 if it contains the exact access code, else 0.",
        },
        { role: "user", content: `Expected access code: ${EXPECTED}\nAgent answer: ${answer}\nScore (1 or 0):` },
      ],
    }),
  });
  return /1/.test((await r.json()).choices?.[0]?.message?.content ?? "0") ? 1 : 0;
}

function printTrace(trace) {
  for (const t of trace ?? []) {
    const a = t.action ?? {};
    const detail = a.url ?? a.text ?? (a.index !== undefined ? `idx ${a.index}` : "") ?? a.answer ?? "";
    const thought = String(a.thought ?? "").slice(0, 58);
    console.log(
      `     step ${t.step}: ${String(a.action ?? "").padEnd(7)} ${String(detail).slice(0, 24).padEnd(24)} | ${thought}`,
    );
  }
}

async function runWith(browserImage, label, agentUrl, siteUrl) {
  const name = `bxt-br-${label}`;
  dtry(["rm", "-f", name]);
  docker(["run", "-d", "--name", name, browserImage]);
  const cdp = `http://${ip(name)}:9222`;
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${cdp}/json/version`)).ok) break;
    } catch {}
    await sleep(2000);
  }
  const task = `Go to ${siteUrl} , search for 'everdict', then tell me the access code shown on the results page.`;
  let out = {};
  try {
    const r = await fetch(`${agentUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, browser_cdp_url: cdp }),
    });
    out = await r.json();
  } catch (e) {
    out = { error: String(e.message) };
  }
  dtry(["rm", "-f", name]);
  const score = await judge(out.output ?? "");
  return { label, out, score };
}

async function main() {
  console.log("\n\x1b[1mReal LLM-driven browser agent — judged e2e + extension ablation\x1b[0m");
  buildIfMissing("everdict-bxa-agent-real:1", "examples/bundles/browser-ext-agent/agent-real");
  buildIfMissing("everdict-bxa-tasksite:1", "examples/bundles/browser-ext-agent/tasksite");
  buildIfMissing("everdict-extractor-ext:1", "examples/browser-extensions/extractor-ext");
  buildIfMissing("everdict-hello-ext:1", "examples/browser-extensions/hello-ext");

  dtry(["rm", "-f", "bxt-site", "bxt-agent"]);
  docker(["run", "-d", "--name", "bxt-site", "everdict-bxa-tasksite:1"]);
  const siteUrl = `http://${ip("bxt-site")}:8080`;
  // The agent container reaches host LiteLLM via host.docker.internal (docker0 gateway 172.17.0.1 is blocked by ufw here).
  docker([
    "run",
    "-d",
    "--name",
    "bxt-agent",
    "--add-host=host.docker.internal:host-gateway",
    "-e",
    `OPENAI_API_KEY=${KEY}`,
    "-e",
    "OPENAI_BASE_URL=http://host.docker.internal:4000/v1",
    "-e",
    `MODEL=${MODEL}`,
    "-e",
    "MAX_STEPS=10",
    "everdict-bxa-agent-real:1",
  ]);
  const agentUrl = `http://${ip("bxt-agent")}:8000`;
  console.log(`site=${siteUrl} agent=${agentUrl} ; warming up…`);
  await sleep(8000);

  console.log("\n(A) WITH the extractor extension — the agent should drive the browser and answer the code");
  const a = await runWith("everdict-extractor-ext:1", "ext", agentUrl, siteUrl);
  if (a.out.error) console.log(`   err=${a.out.error}`);
  console.log(`   decision trace (${a.out.steps} steps, LLM-driven):`);
  printTrace(a.out.trace);
  console.log(
    `   answer="${String(a.out.output ?? "")
      .slice(0, 80)
      .replace(/\n/g, " ")}"  judge=${a.score}`,
  );

  console.log("\n(B) WITHOUT the extractor extension (control) — the code stays masked, so the agent should FAIL");
  const b = await runWith("everdict-hello-ext:1", "noext", agentUrl, siteUrl);
  if (b.out.error) console.log(`   err=${b.out.error}`);
  console.log(`   decision trace (${b.out.steps} steps, LLM-driven):`);
  printTrace(b.out.trace);
  console.log(
    `   answer="${String(b.out.output ?? "")
      .slice(0, 80)
      .replace(/\n/g, " ")}"  judge=${b.score}`,
  );

  dtry(["rm", "-f", "bxt-site", "bxt-agent"]);

  // Evidence the agent genuinely controlled the browser (not scripted): the trace shows a real multi-step interaction.
  const acts = (a.out.trace ?? []).map((t) => t.action?.action);
  const droveBrowser = acts.includes("goto") && acts.includes("type") && acts.includes("click");
  const proven = a.score === 1 && b.score === 0 && droveBrowser;

  console.log("\n\x1b[1m=== RESULT ===\x1b[0m");
  console.log(`  agent drove the browser (goto→type→click, LLM-decided): ${droveBrowser ? "✓" : "✗"}`);
  console.log(`  answer correct WITH extension (judge=1):                 ${a.score === 1 ? "✓" : "✗"}`);
  console.log(
    `  extension REQUIRED — control FAILS WITHOUT (judge=0):    ${b.score === 0 ? "✓ proven by ablation" : "✗"}`,
  );
  console.log(
    proven
      ? "\n\x1b[32m✅ A real agent controlled the extension-loaded browser end-to-end to produce the result, and it was judged. The extension is genuinely required (ablation).\x1b[0m"
      : `\n\x1b[31m⚠️ inconclusive (with=${a.score}, without=${b.score}, drove=${droveBrowser})\x1b[0m`,
  );
  process.exit(proven ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
