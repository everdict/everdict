// Live drill: the EVERDICT AGENT runs a delegation loop end to end, with a real model.
//
// The delegation-profile drill proves the plumbing by driving the routes by hand. This one removes the hand:
// the agent is given the first-party `delegate_work` skill and a job, and it must decide to delegate, open a
// session from a registered profile, write a brief of its own, drive the turns, verify the result inside the
// sandbox, and close. What we assert is what the AGENT called — plus the server-side evidence that its
// handoff really landed (the ledger's delegation.brief marker), so a model that merely narrates a delegation
// cannot pass.
//
// Prereqs: pnpm build · a local Docker daemon · an OpenAI-compatible model endpoint.
// Usage:
//   AGENT_LLM_BASE_URL=http://127.0.0.1:4000/v1 AGENT_LLM_API_KEY=… AGENT_LLM_MODEL=gpt-5.4-mini \
//     node scripts/live/agent-delegation-loop.mjs
import { execFileSync, spawn } from "node:child_process";
import process from "node:process";

const API_PORT = process.env.EVERDICT_LOOP_API_PORT ?? "18907";
const AGENT_PORT = process.env.EVERDICT_LOOP_AGENT_PORT ?? "18908";
const API = `http://127.0.0.1:${API_PORT}`;
const AGENT = `http://127.0.0.1:${AGENT_PORT}`;
const ROOT = new URL("../..", import.meta.url).pathname;
const IMAGE = process.env.EVERDICT_DELEGATE_IMAGE ?? "everdict-delegate-stub:live";
const PROFILE_ID = "repair-delegate";
const MODEL = process.env.AGENT_LLM_MODEL;
const KEY = process.env.AGENT_LLM_API_KEY;
if (MODEL === undefined || KEY === undefined)
  throw new Error("AGENT_LLM_MODEL and AGENT_LLM_API_KEY are required (an OpenAI-compatible endpoint)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTERNAL_TOKEN = "loop-drill-internal";
// The agent bridges the control plane's tools over MCP with the CALLER's credential — the dev tenant header
// is not one. Without a real key the whole delegation surface is simply absent to it (the agent then reaches
// for its own subagent instead), so the drill mints a workspace key and speaks to the agent as a member would.
let apiKey;

const call = async (base, path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-everdict-tenant": "default",
      ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
};
const api = (path, init) => call(API, path, init);
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`✓ ${label}`);
};

if (process.env.EVERDICT_DELEGATE_IMAGE === undefined)
  execFileSync("docker", ["build", "-q", "-t", IMAGE, "scripts/live/delegate-stub"], { cwd: ROOT, stdio: "inherit" });

const children = [];
const spawnChild = (script, env) => {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(child);
  return child;
};
const killAll = () => {
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
};
process.on("exit", killAll);

async function waitHealthy(base, label) {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`${label} did not come up`);
}

async function main() {
  spawnChild("apps/api/dist/main.js", {
    PORT: API_PORT,
    EVERDICT_SANDBOX_DRIVER: "docker",
    EVERDICT_INTERNAL_TOKEN: INTERNAL_TOKEN,
  });
  await waitHealthy(API, "control plane");
  const issued = await call(API, "/internal/tenant-keys", {
    method: "POST",
    headers: { "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify({ workspace: "default" }),
  });
  apiKey = issued.apiKey;
  assert(typeof apiKey === "string" && apiKey.startsWith("ak_"), "minted the workspace key the agent will bridge with");
  spawnChild("apps/agent/dist/main.js", {
    PORT: AGENT_PORT,
    CONTROL_PLANE_URL: API,
    AGENT_LLM_MODEL: MODEL,
    AGENT_LLM_API_KEY: KEY,
    ...(process.env.AGENT_LLM_BASE_URL ? { AGENT_LLM_BASE_URL: process.env.AGENT_LLM_BASE_URL } : {}),
    AGENT_MAX_TURNS: process.env.AGENT_MAX_TURNS ?? "24",
  });
  await waitHealthy(AGENT, "agent");

  // 1) the workspace registers the environment it delegates repair work to. The brief tells the stand-in
  //    delegate to do something CHECKABLE (`RUN:` is the one instruction it acts on), so "did the work" is a
  //    fact on disk rather than a sentence in a reply.
  await api(`/capabilities/${PROFILE_ID}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "repair_delegate",
      description: "The workspace's repair environment — hand it code work to fix and verify.",
      spec: {
        type: "delegation",
        harness: { id: "claude-code" },
        image: IMAGE,
        env: {},
        workDir: "work",
        instructions: "You are a delegate. Read BRIEF.md beside this file before doing anything.",
        instructionsFile: "CLAUDE.md",
        ttlSec: 1800,
      },
    }),
  });
  console.log(`▶ registered delegation profile ${PROFILE_ID}`);

  // 2) the skill the agent is handed — read straight out of the first-party catalog, so the drill exercises
  //    the SHIPPED text, not a copy that can drift from it.
  const catalog = await api("/capabilities/public");
  const entries = Array.isArray(catalog) ? catalog : (catalog.capabilities ?? catalog.items ?? []);
  const skillRecord = entries.find((c) => c.id === "delegate-work");
  assert(skillRecord !== undefined, "the delegate_work skill is in the first-party catalog");
  assert(skillRecord.spec?.type === "skill", "it is a skill capability");

  // 3) the job — deliberately phrased as an OUTCOME, not as "open a sandbox": the agent has to decide that
  //    this needs a real workspace and reach for delegation itself.
  const job = [
    `The workspace has a delegation profile called "${PROFILE_ID}".`,
    "Job: the file /tmp/repair-target.txt must exist inside the delegate's sandbox and contain the word FIXED.",
    "Delegate this: open a session from that profile with a brief whose goal says exactly that, and include a",
    "line of the form `RUN: <shell command>` in the brief's context so the delegate knows the command to run.",
    "Then drive at least one turn, verify the file yourself inside the sandbox, and close the session.",
  ].join(" ");

  console.log("▶ handing the job to the agent (this runs a real model — expect a minute)…");
  const tried = await call(AGENT, "/agent/skills/try", {
    method: "POST",
    body: JSON.stringify({
      skill: {
        name: skillRecord.name,
        description: skillRecord.description,
        instructions: skillRecord.spec.instructions,
        files: skillRecord.spec.files ?? [],
      },
      message: job,
    }),
  });

  // 4) what the AGENT did — the tool-call sequence is the evidence that it ran the loop rather than described it.
  const calls = (tried.messages ?? []).flatMap((m) => m.toolCalls ?? []);
  const names = calls.map((c) => c.name);
  console.log(`  (agent tool calls: ${names.join(" → ") || "none"})`);
  assert(names.includes("create_sandbox"), "the agent opened a delegation session itself");

  const opened = calls.find((c) => c.name === "create_sandbox");
  const openedArgs = typeof opened.arguments === "string" ? JSON.parse(opened.arguments) : (opened.arguments ?? {});
  assert(openedArgs.profile?.id === PROFILE_ID, "it delegated to the REGISTERED profile, not an ad-hoc image");
  assert(
    typeof openedArgs.brief?.goal === "string" && openedArgs.brief.goal.length > 0,
    "it wrote a brief with a goal",
  );
  assert(names.includes("submit_sandbox_task"), "it drove at least one turn of the conversation");
  assert(
    names.includes("sandbox_exec") || names.includes("read_sandbox_task_trace"),
    "it looked at what came back instead of assuming",
  );

  // 5) the server-side half — a model that narrates a delegation leaves nothing here.
  const sessions = await api("/runs?includeChildren=true");
  const runs = Array.isArray(sessions) ? sessions : (sessions.items ?? sessions.runs ?? []);
  const session = runs.find((r) => r.kind === "sandbox" && r.session?.conversation === true);
  assert(session !== undefined, "a real conversation session exists on the ledger");
  const trajectory = await api(`/runs/${session.id}/trajectory`);
  const events = [...(trajectory.events ?? []), ...(trajectory.segments ?? []).flatMap((s) => s.events ?? [])];
  const marker = events.find((e) => e.kind === "env_action" && e.action === "delegation.brief");
  assert(marker !== undefined, "the agent's own brief was sealed on the ledger");
  assert(String(marker.detail?.profile ?? "").includes(PROFILE_ID), "the ledger names the profile it delegated to");

  const turns = runs.filter((r) => r.group?.id === session.id && r.group?.role === "turn");
  assert(turns.length > 0, "the turns the agent drove are first-class runs, grouped to the session");

  console.log("\n✅ agent delegation loop drill PASSED");
}

main()
  .then(() => {
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n✗ ${err.message}`);
    killAll();
    process.exit(1);
  });
