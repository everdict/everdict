// Live e2e: the MANAGED image store — proves the one thing unit tests cannot, that a real
// CNCF distribution registry accepts the tokens our authorization server signs.
//
// What is actually at stake: `RegistryTokenIssuer` mints an RS256 JWT with the certificate in the `x5c`
// header, and distribution verifies that chain against its `rootcertbundle`. Every unit test in
// @everdict/images asserts what WE put in the token; only a real registry can say whether it accepts it.
// The same goes for the two-token flow — a docker client presenting a grant as its password, the registry
// challenging it with our realm, and the exchange narrowing that grant to the scope in flight.
//
// Setup (all local, no external credentials needed):
//   • openssl — a self-signed key/cert pair (the registry's rootcertbundle + our signing key).
//   • registry:2 (docker, token auth, 127.0.0.1:5010) configured with our realm.
//   • a minimal node http server hosting the REAL exchange (@everdict/images ImageTokenService) at /v2/token.
//     The Fastify route around it is unit-tested (apps/api images.routes.test.ts); what needs a live registry
//     is the protocol, so the script wires the same service the route wires.
//
// Flow:
//   ① keys + registry → ② unauthenticated pull is refused → ③ push grant → docker login+push succeeds
//   → ④ a pull grant for the same repo pulls it back (digest matches) → ⑤ a grant for ANOTHER workspace's
//   namespace cannot push there (the isolation claim, tested against the real enforcement point) → ⑥ cleanup.
//
// Usage: `pnpm -F @everdict/images build && node scripts/live/managed-image-store.mjs` (docker + openssl required).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  ImageTokenService,
  RegistryTokenIssuer,
  grantFromBasicAuth,
  scopeValues,
} from "../../packages/images/dist/index.js";

const REG_PORT = process.env.REG_PORT ?? "5010";
const REALM_PORT = process.env.REALM_PORT ?? "5011";
const REGISTRY = `127.0.0.1:${REG_PORT}`;
const SERVICE = "everdict-registry";
const ISSUER = "everdict";
const CONTAINER = "everdict-live-managed-registry";
const NS = "acme-1a2b3c4d"; // a workspace namespace (imageRepoFor output shape)
const OTHER_NS = "rival-9f8e7d6c";
const IMAGE = `${REGISTRY}/${NS}/officeqa`;

const work = mkdtempSync(join(tmpdir(), "everdict-managed-images-"));
let realm;
let ok = false;

const sh = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: "utf8", ...opts });
// Failures are the interesting output here (docker writes "unauthorized" to stderr), so both streams are kept.
const quiet = (bin, args) => {
  try {
    return sh(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
};
// Anything that makes docker talk to the realm MUST be async: the realm runs in this very process, and a
// synchronous execFileSync would block the event loop that has to answer the token request (the client then
// times out waiting for headers). Learned the hard way — keep login/push/pull on this path.
const run = (bin, args, input) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
const runOk = async (bin, args, input) => {
  const { code, out } = await run(bin, args, input);
  if (code !== 0) fail(`${bin} ${args.join(" ")} failed (${code}):\n${out}`);
  return out;
};
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

function cleanup() {
  quiet("docker", ["rm", "-f", CONTAINER]);
  quiet("docker", ["rmi", "-f", `${IMAGE}:v1`]);
  realm?.close();
  rmSync(work, { recursive: true, force: true });
}

try {
  step(1, "generate the signing key + certificate (openssl), start registry:2 with token auth");
  const key = join(work, "token.key");
  const cert = join(work, "token.crt");
  sh("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-x509",
    "-days",
    "1",
    "-out",
    cert,
    "-subj",
    "/CN=everdict-image-token",
  ]);
  // PKCS#8 is what node's createPrivateKey + our issuer expect; openssl already writes PKCS#8 with -nodes.
  const issuer = new RegistryTokenIssuer({
    privateKeyPem: sh("cat", [key]),
    certificatePem: sh("cat", [cert]),
    issuer: ISSUER,
    service: SERVICE,
  });
  const exchange = new ImageTokenService({ issuer, service: SERVICE });

  // The realm: the exact service the Fastify route delegates to, over a bare http server.
  realm = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${REGISTRY}`);
    try {
      const result = await exchange.exchange({
        credential: grantFromBasicAuth(req.headers.authorization),
        scopes: scopeValues(url.searchParams.getAll("scope")),
        ...(url.searchParams.get("service") ? { service: url.searchParams.get("service") } : {}),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: result.token, access_token: result.token, expires_in: result.expiresIn }));
    } catch (e) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="everdict"' });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  await new Promise((resolve) => realm.listen(Number(REALM_PORT), "0.0.0.0", resolve));

  // The realm is resolved by the docker CLIENT, never by the registry container — the registry only advertises it
  // in its 401 challenge. That is the live form of the deployment constraint in the design doc: the realm (and the
  // endpoint) must be reachable from every machine that pulls, which is why they are operator-set public
  // addresses rather than container-network names. Using a container-network name here fails on the client.
  quiet("docker", ["rm", "-f", CONTAINER]);
  sh("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-p",
    `${REG_PORT}:5000`,
    "-v",
    `${cert}:/certs/token.crt:ro`,
    "-e",
    "REGISTRY_AUTH=token",
    "-e",
    `REGISTRY_AUTH_TOKEN_REALM=http://127.0.0.1:${REALM_PORT}/v2/token`,
    "-e",
    `REGISTRY_AUTH_TOKEN_SERVICE=${SERVICE}`,
    "-e",
    `REGISTRY_AUTH_TOKEN_ISSUER=${ISSUER}`,
    "-e",
    "REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE=/certs/token.crt",
    "-e",
    "REGISTRY_STORAGE_DELETE_ENABLED=true",
    "registry:2",
  ]);
  for (let i = 0; i < 40; i++) {
    if (quiet("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://${REGISTRY}/v2/`]).trim() === "401")
      break;
    await new Promise((r) => setTimeout(r, 250));
  }

  step(2, "an unauthenticated pull is refused (the registry is private by construction)");
  quiet("docker", ["rmi", "-f", `${IMAGE}:v1`]);
  const anon = (await run("docker", ["pull", `${IMAGE}:v1`])).out;
  if (!/unauthorized|authentication required|denied/i.test(anon)) fail(`expected an auth failure, got: ${anon}`);

  step(3, "mint a PUSH grant, docker login with it, and push");
  const push = await issuer.mintGrant("acme", [
    { type: "repository", name: `${NS}/officeqa`, actions: ["pull", "push"] },
  ]);
  const cfg = mkdtempSync(join(tmpdir(), "everdict-docker-"));
  await runOk("docker", ["--config", cfg, "login", REGISTRY, "-u", "everdict", "--password-stdin"], push.token);
  writeFileSync(join(work, "Dockerfile"), "FROM scratch\nCOPY Dockerfile /marker\n");
  sh("docker", ["build", "-t", `${IMAGE}:v1`, work]);
  await runOk("docker", ["--config", cfg, "push", `${IMAGE}:v1`]);
  const pushed = sh("docker", ["image", "inspect", `${IMAGE}:v1`, "-f", "{{index .RepoDigests 0}}"]).trim();
  console.log(`    pushed ${pushed}`);

  step(4, "a PULL grant pulls the same image back, digest identical");
  quiet("docker", ["rmi", "-f", `${IMAGE}:v1`]);
  const pull = await issuer.mintGrant("acme", [{ type: "repository", name: `${NS}/officeqa`, actions: ["pull"] }]);
  const cfg2 = mkdtempSync(join(tmpdir(), "everdict-docker-"));
  await runOk("docker", ["--config", cfg2, "login", REGISTRY, "-u", "everdict", "--password-stdin"], pull.token);
  await runOk("docker", ["--config", cfg2, "pull", `${IMAGE}:v1`]);
  const pulled = sh("docker", ["image", "inspect", `${IMAGE}:v1`, "-f", "{{index .RepoDigests 0}}"]).trim();
  if (pulled !== pushed) fail(`digest mismatch: pushed ${pushed}, pulled ${pulled}`);

  step(5, "that same grant cannot push into ANOTHER workspace's namespace (the isolation claim)");
  sh("docker", ["tag", `${IMAGE}:v1`, `${REGISTRY}/${OTHER_NS}/stolen:v1`]);
  const stolen = (await run("docker", ["--config", cfg, "push", `${REGISTRY}/${OTHER_NS}/stolen:v1`])).out;
  if (!/unauthorized|denied|authentication required/i.test(stolen))
    fail(`a grant for ${NS} was allowed to write to ${OTHER_NS}: ${stolen}`);
  quiet("docker", ["rmi", "-f", `${REGISTRY}/${OTHER_NS}/stolen:v1`]);
  rmSync(cfg, { recursive: true, force: true });
  rmSync(cfg2, { recursive: true, force: true });

  ok = true;
  console.log("\nPASS — distribution accepts our x5c tokens; grants push, pull, and stop at the namespace boundary.");
} finally {
  cleanup();
  if (!ok) console.log("\nFAIL");
}
process.exit(ok ? 0 : 1);
