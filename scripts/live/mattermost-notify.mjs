// live e2e: workspace Mattermost integration — completion notifications against a REAL Mattermost.
// Full user path (no hand-driven posting): boot mattermost-preview → bootstrap admin/team/channel/bot token via
// the MM API → register the token in the workspace SecretStore + PUT /workspace/mattermost → run a scorecard →
// the control plane's completion notification lands in the channel (read back via the MM API).
// Design: docs/architecture/workspace-scoped-integrations.md.
//
// Prereqs: a running control plane + a registered fast harness/dataset (fastbot/orchestra-fast) + docker.
// Usage: EVERDICT_API_KEY=ak_… [EVERDICT_API_URL=…] [EVERDICT_RUNTIME=nomad-local] node scripts/live/mattermost-notify.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = (process.env.EVERDICT_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const KEY = process.env.EVERDICT_API_KEY;
if (!KEY) throw new Error("EVERDICT_API_KEY is required (ak_…)");
// Admin-gated ops (workspace secrets + integration settings) need an admin credential — pass one via
// EVERDICT_ADMIN_KEY when the main key is member-scoped (falls back to the main key).
const ADMIN_KEY = process.env.EVERDICT_ADMIN_KEY ?? KEY;
const RUNTIME = process.env.EVERDICT_RUNTIME ?? "nomad-local";
const CONTAINER = "everdict-mm-e2e";
const MM = "http://127.0.0.1:8065";

const everdict = async (method, path, body, opts = {}) => {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.admin ? ADMIN_KEY : KEY}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
};

let adminToken = "";
const mm = async (method, path, body, opts = {}) => {
  const res = await fetch(`${MM}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...((opts.token ?? adminToken) ? { authorization: `Bearer ${opts.token ?? adminToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok && !opts.tolerate) throw new Error(`MM ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
};

console.log("▶ booting mattermost-preview (docker)…");
execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", "8065:8065", "mattermost/mattermost-preview"], {
  stdio: "inherit",
});

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${MM}/api/v4/system/ping`)).ok) break;
    } catch {}
    await sleep(2000);
  }
  console.log("▶ Mattermost up — bootstrapping admin/team/channel/bot");

  // First user on a fresh server = system admin.
  await mm(
    "POST",
    "/api/v4/users",
    { email: "e2e@example.com", username: "e2e-admin", password: "E2e-password-123" },
    { token: "" },
  );
  const login = await mm(
    "POST",
    "/api/v4/users/login",
    { login_id: "e2e-admin", password: "E2e-password-123" },
    { token: "" },
  );
  adminToken = login.headers.get("token");
  if (!adminToken) throw new Error("MM login gave no session token");

  await mm("PUT", "/api/v4/config/patch", { ServiceSettings: { EnableBotAccountCreation: true } });
  const team = (await mm("POST", "/api/v4/teams", { name: "everdict-e2e", display_name: "Everdict E2E", type: "O" }))
    .json;
  const channel = (
    await mm("POST", "/api/v4/channels", {
      team_id: team.id,
      name: "eval-alerts",
      display_name: "Eval alerts",
      type: "O",
    })
  ).json;
  const bot = (await mm("POST", "/api/v4/bots", { username: "everdict-bot", display_name: "Everdict" })).json;
  const botToken = (await mm("POST", `/api/v4/users/${bot.user_id}/tokens`, { description: "e2e" })).json.token;
  await mm("POST", `/api/v4/teams/${team.id}/members`, { team_id: team.id, user_id: bot.user_id });
  await mm("POST", `/api/v4/channels/${channel.id}/members`, { user_id: bot.user_id });
  console.log(`▶ bot ready (channel ${channel.id})`);

  // Everdict side — token into the SecretStore (name reference only in settings), then register the integration.
  await everdict("PUT", "/secrets/MM_BOT_TOKEN_E2E", { value: botToken }, { admin: true });
  await everdict(
    "PUT",
    "/workspace/mattermost",
    { host: MM, botTokenSecretName: "MM_BOT_TOKEN_E2E", defaultChannelId: channel.id },
    { admin: true },
  );
  console.log("▶ workspace Mattermost integration registered");

  // Fire a real (fast) scorecard — its completion notification must land in the channel.
  const sc = await everdict("POST", "/scorecards", {
    dataset: { id: "orchestra-fast", version: "1.0.0" },
    harness: { id: "fastbot", version: "1.0.0" },
    runtime: RUNTIME,
    cases: { limit: 1 },
    concurrency: 1,
    retries: 0,
  });
  console.log(`▶ scorecard ${sc.id} queued`);
  let status = sc.status;
  for (let i = 0; i < 60 && (status === "queued" || status === "running"); i++) {
    await sleep(3000);
    status = (await everdict("GET", `/scorecards/${sc.id}`)).status;
  }
  if (status !== "succeeded") throw new Error(`scorecard ${status}`);

  // The notification is fire-and-forget after completion — poll the channel briefly.
  let found;
  for (let i = 0; i < 20 && !found; i++) {
    await sleep(2000);
    const posts = (await mm("GET", `/api/v4/channels/${channel.id}/posts`)).json;
    found = Object.values(posts.posts ?? {}).find((p) => p.message.includes(sc.id));
  }
  if (!found) throw new Error("✗ completion notification did not land in the channel");
  console.log(`✓ completion notification in #eval-alerts: ${found.message.split("\n")[0].slice(0, 120)}`);
  console.log(
    "\n✅ mattermost-notify live e2e PASS — workspace integration → real channel post, read back via the MM API.",
  );
} finally {
  try {
    await everdict("DELETE", "/workspace/mattermost", undefined, { admin: true });
  } catch {}
  execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}
