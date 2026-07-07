// Live e2e: workspace image registry — real verification of the full **publish (everdict image push) → authenticated pull** path.
// Live proof of S2 (publish) + S4 (pull auth) from docs/architecture/workspace-image-registry.md.
//
// Setup (all local, no external credentials needed):
//   • registry:2 (docker, htpasswd basic auth, 127.0.0.1:5005) — stand-in for a BYO workspace registry.
//   • control plane (node, in-memory) — registry registration + push/pull secrets + push-credentials minting.
//   • everdict CLI (image push) — mint credentials → docker tag → push with a temp DOCKER_CONFIG.
//
// Flow:
//   ① start the auth registry (confirm 401 without auth) → ② build a marker image → ③ start the CP + mint an API key
//   → ④ secrets (REG_PUSH/REG_PULL) + register /workspace/image-registries (multi model, name specified) → ⑤ everdict image push
//   → ⑥ confirm the repo is in the catalog + ~/.docker/config.json untouched + local image removed then unauthenticated pull fails
//   → ⑦ authenticated pull via pullWithRegistryAuth (temp DOCKER_CONFIG) succeeds + image sha matches → ⑧ clean up.
//
// Usage: after build (pnpm build --filter @everdict/cli --filter @everdict/api --filter @everdict/drivers)
//   `node scripts/live/image-registry-push-pull.mjs` (docker required).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8919";
const BASE = `http://127.0.0.1:${PORT}`;
const REG_PORT = process.env.REG_PORT ?? "5005";
const REG_HOST = `localhost:${REG_PORT}`;
const REG_NAME = "everdict-e2e-registry";
const IMAGE = "everdict-e2e-img:v1";
const USER = "everdictbot";
const PASS = "s3cret-tok";
const INTERNAL = "dev-internal-token";
const H = { "content-type": "application/json", "x-everdict-tenant": "acme" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

let api;
try {
  // ① Auth registry (htpasswd) — generate a bcrypt hash with the httpd image.
  const dir = mkdtempSync(join(tmpdir(), "everdict-reg-e2e-"));
  const htpasswd = sh("docker", ["run", "--rm", "--entrypoint", "htpasswd", "httpd:2", "-Bbn", USER, PASS]);
  writeFileSync(join(dir, "htpasswd"), htpasswd);
  sh("docker", ["rm", "-f", REG_NAME], { stdio: "ignore" });
  sh("docker", [
    "run",
    "-d",
    "--name",
    REG_NAME,
    "-p",
    `${REG_PORT}:5000`,
    "-v",
    `${dir}:/auth:ro`,
    "-e",
    "REGISTRY_AUTH=htpasswd",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_REALM=Registry Realm",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    "registry:2",
  ]);
  await sleep(2000);
  const unauth = await fetch(`http://127.0.0.1:${REG_PORT}/v2/`);
  if (unauth.status !== 401)
    throw new Error(`registry must reject unauthenticated access (401) — got ${unauth.status}`);
  console.log("① auth registry up — 401 without auth confirmed");

  // ② Build the marker image.
  writeFileSync(join(dir, "Dockerfile"), "FROM alpine:3\nRUN echo everdict-e2e-marker > /opt/marker.txt\n");
  sh("docker", ["build", "-q", "-t", IMAGE, dir]);
  const builtId = sh("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"]).trim();
  console.log(`② marker image built: ${IMAGE}`);

  // ③ Control plane (in-memory) + API key.
  api = spawn("node", [join(ROOT, "apps/api/dist/main.js")], {
    env: { ...process.env, PORT, EVERDICT_INTERNAL_TOKEN: INTERNAL, EVERDICT_LOG_LEVEL: "silent" },
    stdio: "ignore",
  });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ok = await fetch(`${BASE}/me`, { headers: H })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    if (i === 29) throw new Error("control plane failed to start");
  }
  const { apiKey } = await fetch(`${BASE}/internal/tenant-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
    body: JSON.stringify({ workspace: "acme" }),
  }).then((r) => r.json());
  console.log("③ control plane up + API key minted");

  // ④ Secrets + registry registration.
  for (const name of ["REG_PUSH", "REG_PULL"])
    await fetch(`${BASE}/secrets/${name}`, { method: "PUT", headers: H, body: JSON.stringify({ value: PASS }) });
  const reg = await fetch(`${BASE}/workspace/image-registries`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({
      name: "local",
      host: REG_HOST,
      username: USER,
      pullSecretName: "REG_PULL",
      pushSecretName: "REG_PUSH",
    }),
  }).then((r) => r.json());
  if (reg.config?.imagePrefix !== `${REG_HOST}/`)
    throw new Error(`registry registration failed: ${JSON.stringify(reg)}`);
  console.log(`④ registry registered: ${reg.config.imagePrefix}`);

  // ⑤ everdict image push (temp DOCKER_CONFIG — the user's docker config is left untouched).
  const before = (() => {
    try {
      return readFileSync(join(process.env.HOME ?? "", ".docker/config.json"), "utf8");
    } catch {
      return "";
    }
  })();
  const out = sh("node", [
    join(ROOT, "apps/cli/dist/main.js"),
    "image",
    "push",
    IMAGE,
    "--api-url",
    BASE,
    "--api-key",
    apiKey,
  ]);
  const pushed = out.trim().split("\n").pop();
  if (pushed !== `${REG_HOST}/${IMAGE}`) throw new Error(`published ref mismatch: ${pushed}`);
  console.log(`⑤ everdict image push → ${pushed}`);

  // ⑥ Verify: catalog + user config untouched + unauthenticated pull fails.
  const catalog = await fetch(`http://127.0.0.1:${REG_PORT}/v2/_catalog`, {
    headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` },
  }).then((r) => r.json());
  if (!catalog.repositories?.includes("everdict-e2e-img"))
    throw new Error(`repo not in catalog: ${JSON.stringify(catalog)}`);
  const after = (() => {
    try {
      return readFileSync(join(process.env.HOME ?? "", ".docker/config.json"), "utf8");
    } catch {
      return "";
    }
  })();
  if (before !== after) throw new Error("~/.docker/config.json changed — temp DOCKER_CONFIG isolation violated");
  sh("docker", ["rmi", "-f", pushed, IMAGE], { stdio: "ignore" });
  let unauthPullFailed = false;
  try {
    sh("docker", ["pull", pushed], { stdio: "pipe" });
  } catch {
    unauthPullFailed = true;
  }
  if (!unauthPullFailed) throw new Error("unauthenticated docker pull succeeded — registry auth not enforced");
  console.log("⑥ catalog confirmed + user docker config untouched + unauthenticated pull rejected");

  // ⑦ Authenticated pull (same path as the runtime consumer — pullWithRegistryAuth used by DockerDriver/runner pre-pull).
  const { pullWithRegistryAuth } = await import(join(ROOT, "packages/drivers/dist/index.js"));
  await pullWithRegistryAuth(pushed, { host: REG_HOST, username: USER, password: PASS });
  const pulledId = sh("docker", ["image", "inspect", pushed, "--format", "{{.Id}}"]).trim();
  if (pulledId !== builtId) throw new Error(`pulled image sha mismatch: ${pulledId} != ${builtId}`);
  console.log("⑦ pullWithRegistryAuth authenticated pull succeeded + sha matches");
  console.log("✓ PASS — full publish → authenticated pull path live-verified");
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  // ⑧ Clean up — registry/image/CP.
  api?.kill();
  try {
    sh("docker", ["rm", "-f", REG_NAME], { stdio: "ignore" });
    sh("docker", ["rmi", "-f", `${REG_HOST}/${IMAGE}`, IMAGE], { stdio: "ignore" });
  } catch {
    // best-effort cleanup
  }
}
