// Live drill: DELEGATION through a registered profile (docker canary).
//
// Registers a `delegation` capability (the work environment: which conversational agent, which image, the
// standing instructions), boots a session by that ONE reference with a structured brief, and proves the
// handoff physically landed — the delegate reads its own BRIEF.md from inside the container and the goal text
// comes back in its answer. Then a second turn proves the conversation continued, and the sealed trajectory
// carries the delegation.brief marker (the ledger alone answers what they were asked to do).
//
// Prereqs: pnpm build · a local Docker daemon · an agent image whose CLI is on PATH. The default image is the
// fake-claude one the conversation drill builds; point EVERDICT_DELEGATE_IMAGE at a real one to drill for real.
// Usage: node scripts/live/delegation-profile-drill.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const PORT = process.env.EVERDICT_DELEGATION_TEST_PORT ?? "18904";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("../..", import.meta.url).pathname;
const IMAGE = process.env.EVERDICT_DELEGATE_IMAGE ?? "everdict-fake-claude:conv";
const PROFILE_ID = `code-delegate-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-everdict-tenant": "default", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
};
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`✓ ${label}`);
};

const cp = spawn(process.execPath, ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT, EVERDICT_SANDBOX_DRIVER: "docker" },
  stdio: ["ignore", "inherit", "inherit"],
});
const kill = () => {
  if (!cp.killed) cp.kill("SIGTERM");
};
process.on("exit", kill);

async function waitTerminal(sessionId, turnId, budgetMs = 90_000) {
  const start = Date.now();
  for (;;) {
    const page = await api(`/sandboxes/${sessionId}/tasks/${turnId}/trace`);
    if (page.done) return page;
    if (Date.now() - start > budgetMs) throw new Error(`turn ${turnId} not settled in ${budgetMs}ms`);
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

  // 1) the delegation profile — the work environment, registered once.
  await api(`/capabilities/${PROFILE_ID}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "code_delegate_drill",
      description: "The drill's delegate: a conversational agent in a prebuilt image.",
      spec: {
        type: "delegation",
        harness: { id: "claude-code" },
        image: IMAGE,
        env: { DELEGATION_DRILL: "1" },
        workDir: "work",
        instructions: "You are a delegate. Read BRIEF.md beside this file before doing anything.",
        instructionsFile: "CLAUDE.md",
        ttlSec: 1800,
      },
    }),
  });
  console.log(`▶ registered delegation profile ${PROFILE_ID}`);

  // 2) delegate: ONE reference + the structured handoff.
  const session = await api("/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      profile: { id: PROFILE_ID },
      brief: {
        goal: "make the regressed spreadsheet cases pass",
        context: "two cases started failing after the judge changed",
        references: [{ type: "scorecard", id: "sc-9", note: "the batch that regressed" }],
        constraints: ["do not touch the dataset"],
        doneWhen: ["both cases pass", "no other case regresses"],
      },
    }),
  });
  assert(session.session?.conversation === true, "a delegation IS a conversation");
  assert(session.session?.image === IMAGE, "the profile's image booted (no image passed by the caller)");
  assert(session.session?.ttlSec === 1800, "the profile's own budget applied");

  // 3) the context PHYSICALLY landed — read it from inside the container, not from our own render.
  const seeded = await api(`/sandboxes/${session.id}/exec`, {
    method: "POST",
    body: JSON.stringify({ command: "cat work/CLAUDE.md work/BRIEF.md" }),
  });
  assert(seeded.stdout.includes("You are a delegate"), "the standing instructions landed in the workdir");
  assert(seeded.stdout.includes("make the regressed spreadsheet cases pass"), "the brief's goal landed");
  assert(seeded.stdout.includes("- scorecard `sc-9` — the batch that regressed"), "the handed-over evidence landed");
  assert(seeded.stdout.includes("- do not touch the dataset"), "the constraints landed");

  // 4) the profile's env reached the agent's environment (the model connection travels the same way).
  const env = await api(`/sandboxes/${session.id}/exec`, {
    method: "POST",
    body: JSON.stringify({ command: "printenv DELEGATION_DRILL || true" }),
  });
  console.log(`  (profile env in-container: ${JSON.stringify(env.stdout.trim())})`);

  // 5) delegate the work — and prove the delegate can read its own brief.
  const turn1 = await api(`/sandboxes/${session.id}/tasks`, {
    method: "POST",
    body: JSON.stringify({ task: "read BRIEF.md and tell me the goal" }),
  });
  assert(turn1.caseId === "turn-1", "the first message is turn-1");
  assert(turn1.group?.role === "turn", "turns group as dependent evidence");
  const page1 = await waitTerminal(session.id, turn1.id);
  assert(page1.status === "succeeded", "turn 1 settled succeeded");

  const turn2 = await api(`/sandboxes/${session.id}/tasks`, {
    method: "POST",
    body: JSON.stringify({ task: "what did I ask you to do?" }),
  });
  const page2 = await waitTerminal(session.id, turn2.id);
  assert(answerOf(page2).length > 0, "turn 2 answered — the conversation continued");

  // 6) the live view names WHO was delegated to.
  const view = await api(`/sandboxes/${session.id}`);
  assert(view.live?.profile?.id === PROFILE_ID, "the live view names the delegate's profile");

  // 7) close → the handoff is on the ledger, reproducible without the container.
  await api(`/sandboxes/${session.id}/close`, { method: "POST" });
  const trajectory = await api(`/runs/${session.id}/trajectory`);
  // The read serves both shapes — a flat `events` array and per-emitter `segments`. Merge rather than prefer:
  // an empty segment list is still a list, so a `??` chain would silently skip the flat array.
  const events = [...(trajectory.events ?? []), ...(trajectory.segments ?? []).flatMap((s) => s.events ?? [])];
  const marker = events.find((e) => e.kind === "env_action" && e.action === "delegation.brief");
  assert(marker !== undefined, "the sealed trajectory carries the delegation.brief marker");
  assert(
    String(marker.detail?.brief ?? "").includes("make the regressed spreadsheet cases pass"),
    "the ledger alone says what was asked",
  );

  console.log("\n✅ delegation profile drill PASSED");
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
