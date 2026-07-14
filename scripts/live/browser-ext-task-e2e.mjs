// Complex, extension-DEPENDENT judged e2e:
//  (a) multi-step web task — the agent opens the portal, types a query into the search form, clicks Search, lands on
//      the results page;
//  (b) the results page MASKS the access code (shows only ••••••••); a client extension unmasks it into #__ext_extracted.
//      The agent reads the extension's output and answers; an LLM judge scores it.
// Ablation proves the extension is genuinely required: the SAME task runs with the extractor extension (PASS) and with a
// non-extractor browser (the code stays masked → FAIL).
//
// Prereqs: LiteLLM(:4000). Build the images:
//   docker build -t everdict-extractor-ext:1  examples/browser-extensions/extractor-ext
//   docker build -t everdict-hello-ext:1       examples/browser-extensions/hello-ext           (the no-extractor control)
//   docker build -t everdict-bxa-agent-task:1  examples/bundles/browser-ext-agent/agent-task
//   docker build -t everdict-bxa-tasksite:1    examples/bundles/browser-ext-agent/tasksite
// Run:  node scripts/live/browser-ext-task-e2e.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MODEL = process.env.LG_MODEL ?? "gpt-5.4-mini";
const EXPECTED = "EVDX-4242";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (a) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const dtry = (a) => {
  try {
    return docker(a);
  } catch {
    return "";
  }
};
const ip = (name) => docker(["inspect", name, "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
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
  console.error("no LLM key");
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
  const task = `Go to ${siteUrl}, search for 'everdict', then report the access code shown on the results page.`;
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
  console.log("\n\x1b[1mExtension-dependent multi-step web task — judged e2e + ablation\x1b[0m");
  dtry(["rm", "-f", "bxt-site", "bxt-agent"]);
  docker(["run", "-d", "--name", "bxt-site", "everdict-bxa-tasksite:1"]);
  const siteUrl = `http://${ip("bxt-site")}:8080`;
  docker([
    "run",
    "-d",
    "--name",
    "bxt-agent",
    "-e",
    `OPENAI_API_KEY=${KEY}`,
    "-e",
    "OPENAI_BASE_URL=http://172.17.0.1:4000/v1",
    "-e",
    `MODEL=${MODEL}`,
    "everdict-bxa-agent-task:1",
  ]);
  const agentUrl = `http://${ip("bxt-agent")}:8000`;
  console.log(`site=${siteUrl} agent=${agentUrl} ; warming up…`);
  await sleep(12000);

  console.log("\n(A) WITH the extractor extension — the task should succeed");
  const a = await runWith("everdict-extractor-ext:1", "ext", agentUrl, siteUrl);
  console.log(`   steps: ${JSON.stringify(a.out.steps)}${a.out.error ? ` | err=${a.out.error}` : ""}`);
  console.log(`   masked_on_page="${a.out.masked_on_page}"  ext_extracted="${a.out.ext_extracted}"`);
  console.log(
    `   answer="${String(a.out.output ?? "")
      .slice(0, 80)
      .replace(/\n/g, " ")}"  judge=${a.score}`,
  );

  console.log("\n(B) WITHOUT the extractor extension (control) — the code stays masked, so the task should FAIL");
  const b = await runWith("everdict-hello-ext:1", "noext", agentUrl, siteUrl);
  console.log(`   steps: ${JSON.stringify(b.out.steps)}${b.out.error ? ` | err=${b.out.error}` : ""}`);
  console.log(`   masked_on_page="${b.out.masked_on_page}"  ext_extracted="${b.out.ext_extracted}"`);
  console.log(
    `   answer="${String(b.out.output ?? "")
      .slice(0, 80)
      .replace(/\n/g, " ")}"  judge=${b.score}`,
  );

  dtry(["rm", "-f", "bxt-site", "bxt-agent"]);
  const proven = a.score === 1 && b.score === 0;
  console.log("\n\x1b[1m=== RESULT ===\x1b[0m");
  console.log(`  multi-step (form fill → click → results): ${a.out.steps?.length >= 4 ? "✓ performed" : "✗"}`);
  console.log(
    `  extension REQUIRED (with=PASS, without=FAIL): ${proven ? "✓ proven by ablation" : `✗ (with=${a.score}, without=${b.score})`}`,
  );
  console.log(
    proven
      ? "\n\x1b[32m✅ Real multi-step web task, and the client extension is genuinely required (ablation).\x1b[0m"
      : "\n\x1b[31m⚠️ inconclusive — see per-case above\x1b[0m",
  );
  process.exit(proven ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
