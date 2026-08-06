// Front-door CONVERSATION on a real Nomad cluster — the playground's service lane, end to end through the
// real API surface: register a nomad runtime (topology-capable: traceSource set, deliberately dead — the
// trace pull degrades, never the turn) + a conversation-aware stub service harness → boot a conversation
// session (`POST /sandboxes {harness, runtime}` → warm topology on Nomad) → two turns whose SECOND reply
// contains what the FIRST said (the stub keys memory by thread_id, so this proves ONE session-stable thread
// across submits) → close → the warm topology deliberately survives (its lifecycle is the cluster idle TTL).
//
// Prereqs: pnpm build · a local Docker daemon · a Nomad agent (e.g. `nomad agent -dev` + docker driver).
// Usage:   NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/frontdoor-conversation-nomad.mjs
import { execFileSync, spawn } from "node:child_process";
import process from "node:process";

const NOMAD = (process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646").replace(/\/$/, "");
const PORT = process.env.EVERDICT_CONV_TEST_PORT ?? "18902";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("../..", import.meta.url).pathname;
const TENANT = "default";
const HARNESS_ID = `conv-frontdoor-${Date.now().toString(36)}`;
const STUB_IMAGE = "everdict-conversation-stub:e2e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-everdict-tenant": TENANT, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`✓ ${label}`);
};

// 0) the stub image (per-thread memory — the continuity oracle).
execFileSync("docker", ["build", "-q", "-t", STUB_IMAGE, "scripts/live/topology-conversation-stub"], {
  cwd: ROOT,
  stdio: "inherit",
});

// 1) a control plane with the sandbox lane on (the playground surface) and nothing else special.
const cp = spawn(process.execPath, ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PORT,
    EVERDICT_SANDBOX_DRIVER: "docker",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const kill = () => {
  if (!cp.killed) cp.kill("SIGTERM");
};
process.on("exit", kill);

async function waitForTerminal(sessionId, turnId, budgetMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const page = await api(`/sandboxes/${sessionId}/tasks/${turnId}/trace`);
    if (page.done) return page;
    if (Date.now() - start > budgetMs) throw new Error(`turn ${turnId} did not settle in ${budgetMs}ms`);
    await sleep(1000);
  }
}

const answerOf = (page) => {
  const messages = page.events.filter((e) => e.kind === "message" && e.role === "assistant");
  return messages.length > 0 ? messages[messages.length - 1].text : "";
};

async function main() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await sleep(500);
  }

  // 2) a topology-capable nomad runtime (traceSource REQUIRED to host service harnesses; the endpoint is
  // deliberately dead — a turn's trace pull degrades to one error event, never a failed turn).
  await api("/runtimes", {
    method: "POST",
    body: JSON.stringify({
      kind: "nomad",
      id: "nomad-dev",
      version: "1.0.0",
      addr: NOMAD,
      image: "everdict-job-runner:unused", // the eval lane's job image — conversations never dispatch it
      traceSource: { kind: "mlflow", endpoint: "http://127.0.0.1:59911" },
      // A dev Nomad's docker driver builds /etc/hosts itself (bridge networking) and rejects the
      // `host-gateway` keyword — the registered runtime names the concrete docker0 gateway instead.
      hostGatewayAddr: process.env.EVERDICT_HOST_GATEWAY ?? "172.17.0.1",
    }),
  });
  console.log(`▶ registered runtime nomad-dev → ${NOMAD}`);

  // 3) the conversation-aware service harness (template → pinned instance, the authoring shape).
  await api("/harness-templates", {
    method: "POST",
    body: JSON.stringify({
      kind: "service",
      category: "topology",
      id: HARNESS_ID,
      version: "1",
      services: [{ name: "frontdoor", image: STUB_IMAGE, port: 8080, needs: [], perRun: [], replicas: 1, env: {} }],
      dependencies: [],
      frontDoor: { service: "frontdoor", submit: "POST /runs" },
      traceSource: { kind: "mlflow", endpoint: "http://127.0.0.1:59911" },
    }),
  });
  await api("/harnesses", {
    method: "POST",
    body: JSON.stringify({
      template: { id: HARNESS_ID, version: "1" },
      id: HARNESS_ID,
      version: "1.0.0",
      pins: { frontdoor: STUB_IMAGE },
    }),
  });
  console.log(`▶ registered service harness ${HARNESS_ID}@1.0.0`);

  // 4) boot the conversation session — the warm topology stands up on the real cluster here.
  const session = await api("/sandboxes", {
    method: "POST",
    body: JSON.stringify({ harness: { id: HARNESS_ID }, runtime: "nomad-dev", ttlSec: 900 }),
  });
  assert(session.trigger === "frontdoor", "session joined the frontdoor pool");
  assert(session.session?.conversation === true, "session row says conversation");
  assert(session.runtime === "nomad-dev", "session placed on the registered runtime");
  assert(session.session?.computeId === undefined, "no computeId — nothing for Driver.reap");

  // 5) turn 1 — a fresh thread has nothing to remember.
  const turn1 = await api(`/sandboxes/${session.id}/tasks`, {
    method: "POST",
    body: JSON.stringify({ task: "remember the number 7" }),
  });
  assert(turn1.caseId === "turn-1", "turn 1 counts turn-<n>");
  assert(turn1.group?.role === "turn", "turn 1 groups with role 'turn'");
  const page1 = await waitForTerminal(session.id, turn1.id);
  assert(page1.status === "succeeded", "turn 1 settled succeeded");
  assert(answerOf(page1).includes("starting fresh"), "turn 1 reply = fresh thread");

  // 6) turn 2 — the SAME thread: the stub's memory (keyed by thread_id) must carry turn 1's words. This is
  // the continuity proof: one session-stable thread_id across two independent front-door submits.
  const turn2 = await api(`/sandboxes/${session.id}/tasks`, {
    method: "POST",
    body: JSON.stringify({ task: "what do you remember?" }),
  });
  const page2 = await waitForTerminal(session.id, turn2.id);
  assert(answerOf(page2).includes("remember the number 7"), "turn 2 reply carries turn 1 (one thread)");

  // 7) fresh is refused — a service conversation's thread IS its session.
  const freshRes = await fetch(`${BASE}/sandboxes/${session.id}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-everdict-tenant": TENANT },
    body: JSON.stringify({ task: "again", fresh: true }),
  });
  assert(freshRes.status === 400, "fresh on a service conversation → 400");

  // 8) the live view says conversation + service kind (the web's one branch signal).
  const view = await api(`/sandboxes/${session.id}`);
  assert(view.live?.conversation === true, "live view says conversation");
  assert(view.live?.harness?.kind === "service", "live view says service kind");

  // 9) close — the session settles; the WARM topology deliberately survives (cluster idle TTL owns it).
  await api(`/sandboxes/${session.id}/close`, { method: "POST" });
  const closed = await api(`/sandboxes/${session.id}`);
  assert(closed.record.status === "succeeded", "closed session settled");
  const jobs = await (await fetch(`${NOMAD}/v1/jobs`)).json();
  const warm = jobs.find((j) => j.ID.includes(HARNESS_ID));
  assert(warm !== undefined && warm.Status === "running", "warm topology survives the close");

  // teardown: purge the warm job (this drill's mess, not the idle sweeper's).
  await fetch(`${NOMAD}/v1/job/${warm.ID}?purge=true`, { method: "DELETE" });
  console.log("\n✅ front-door conversation drill PASSED");
}

main()
  .then(() => {
    kill();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n✗ ${err.message}`);
    kill();
    process.exit(1);
  });
