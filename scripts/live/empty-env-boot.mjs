// Self-hosted minimal-profile contract: prove with a real process that the control plane boots even with an "empty env".
//   — no DATABASE_URL/KEYCLOAK_*/GITHUB_APP_*/NOMAD/K8S/secret keys at all → in-memory stores,
//     dev-fallback auth (x-everdict-tenant), all integrations disabled. If this breaks, one-command self-hosting breaks.
// Usage (after build): node scripts/live/empty-env-boot.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const PORT = process.env.EVERDICT_BOOT_TEST_PORT ?? "18787";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deliberately pass only a minimal env (PATH/HOME are needed to run node) — it does not read a .env file either.
const child = spawn(process.execPath, ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT },
  stdio: ["ignore", "inherit", "inherit"],
});
const kill = () => {
  if (!child.killed) child.kill("SIGTERM");
};
process.on("exit", kill);

let exited = false;
child.on("exit", (code) => {
  exited = true;
  if (code !== 0 && code !== null) {
    console.error(`✗ control plane failed to boot with an empty env (exit ${code})`);
    process.exit(1);
  }
});

async function main() {
  // 1) Poll until /healthz is up (up to 30s)
  let healthy = false;
  for (let i = 0; i < 60 && !exited; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet — retry
    }
    await sleep(500);
  }
  if (!healthy) throw new Error("no /healthz response within 30s — empty-env boot failed");
  console.log("✓ /healthz ok (empty env, in-memory)");

  // 2) Check that a basic read route works under the dev-fallback tenant (auth not enforced = self-hosted minimal profile)
  const res = await fetch(`${BASE}/harnesses`, { headers: { "x-everdict-tenant": "default" } });
  if (!res.ok) throw new Error(`/harnesses ${res.status} — dev-fallback path failed`);
  await res.json();
  console.log("✓ GET /harnesses ok (dev-fallback tenant)");

  console.log("PASS: empty-env boot contract holds");
}

main()
  .then(() => {
    kill();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`✗ ${err.message}`);
    kill();
    process.exit(1);
  });
