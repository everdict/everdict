// 라이브 e2e: 워크스페이스 이미지 레지스트리 — **발행(assay image push) → 인증 pull** 전 과정 실검증.
// docs/architecture/workspace-image-registry.md 의 S2(발행) + S4(pull 인증) 라이브 프루프.
//
// 구성(모두 로컬, 외부 자격증명 불필요):
//   • registry:2 (docker, htpasswd basic auth, 127.0.0.1:5005) — BYO 워크스페이스 레지스트리 대역.
//   • 컨트롤플레인(node, in-memory) — 레지스트리 등록 + push/pull 시크릿 + push-credentials 발급.
//   • assay CLI(image push) — 자격증명 발급 → docker tag → 임시 DOCKER_CONFIG push.
//
// 흐름:
//   ① 인증 레지스트리 기동(무인증 401 확인) → ② 마커 이미지 빌드 → ③ CP 기동 + API 키 발급
//   → ④ 시크릿(REG_PUSH/REG_PULL) + /workspace/image-registries 등록(복수 모델, name 지정) → ⑤ assay image push
//   → ⑥ 카탈로그에 리포 확인 + ~/.docker/config.json 불가침 확인 + 로컬 이미지 제거 후 무인증 pull 실패 확인
//   → ⑦ pullWithRegistryAuth(임시 DOCKER_CONFIG) 로 인증 pull 성공 + 이미지 sha 일치 → ⑧ 정리.
//
// 사용: 빌드(pnpm build --filter @assay/cli --filter @assay/api --filter @assay/drivers) 후
//   `node scripts/live/image-registry-push-pull.mjs` (docker 필요).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8919";
const BASE = `http://127.0.0.1:${PORT}`;
const REG_PORT = process.env.REG_PORT ?? "5005";
const REG_HOST = `localhost:${REG_PORT}`;
const REG_NAME = "assay-e2e-registry";
const IMAGE = "assay-e2e-img:v1";
const USER = "assaybot";
const PASS = "s3cret-tok";
const INTERNAL = "dev-internal-token";
const H = { "content-type": "application/json", "x-assay-tenant": "acme" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

let api;
try {
  // ① 인증 레지스트리(htpasswd) — httpd 이미지로 bcrypt 해시 생성.
  const dir = mkdtempSync(join(tmpdir(), "assay-reg-e2e-"));
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
  if (unauth.status !== 401) throw new Error(`레지스트리가 무인증을 거부해야 함(401) — got ${unauth.status}`);
  console.log("① 인증 레지스트리 기동 — 무인증 401 확인");

  // ② 마커 이미지 빌드.
  writeFileSync(join(dir, "Dockerfile"), "FROM alpine:3\nRUN echo assay-e2e-marker > /opt/marker.txt\n");
  sh("docker", ["build", "-q", "-t", IMAGE, dir]);
  const builtId = sh("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"]).trim();
  console.log(`② 마커 이미지 빌드: ${IMAGE}`);

  // ③ 컨트롤플레인(in-memory) + API 키.
  api = spawn("node", [join(ROOT, "apps/api/dist/main.js")], {
    env: { ...process.env, PORT, ASSAY_INTERNAL_TOKEN: INTERNAL, ASSAY_LOG_LEVEL: "silent" },
    stdio: "ignore",
  });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ok = await fetch(`${BASE}/me`, { headers: H })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    if (i === 29) throw new Error("컨트롤플레인 기동 실패");
  }
  const { apiKey } = await fetch(`${BASE}/internal/tenant-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
    body: JSON.stringify({ workspace: "acme" }),
  }).then((r) => r.json());
  console.log("③ 컨트롤플레인 기동 + API 키 발급");

  // ④ 시크릿 + 레지스트리 등록.
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
  if (reg.config?.imagePrefix !== `${REG_HOST}/`) throw new Error(`레지스트리 등록 실패: ${JSON.stringify(reg)}`);
  console.log(`④ 레지스트리 등록: ${reg.config.imagePrefix}`);

  // ⑤ assay image push (임시 DOCKER_CONFIG — 유저 docker config 불가침).
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
  if (pushed !== `${REG_HOST}/${IMAGE}`) throw new Error(`발행 ref 불일치: ${pushed}`);
  console.log(`⑤ assay image push → ${pushed}`);

  // ⑥ 검증: 카탈로그 + 유저 config 불가침 + 무인증 pull 실패.
  const catalog = await fetch(`http://127.0.0.1:${REG_PORT}/v2/_catalog`, {
    headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` },
  }).then((r) => r.json());
  if (!catalog.repositories?.includes("assay-e2e-img"))
    throw new Error(`카탈로그에 리포 없음: ${JSON.stringify(catalog)}`);
  const after = (() => {
    try {
      return readFileSync(join(process.env.HOME ?? "", ".docker/config.json"), "utf8");
    } catch {
      return "";
    }
  })();
  if (before !== after) throw new Error("~/.docker/config.json 이 변경됨 — 임시 DOCKER_CONFIG 불가침 위반");
  sh("docker", ["rmi", "-f", pushed, IMAGE], { stdio: "ignore" });
  let unauthPullFailed = false;
  try {
    sh("docker", ["pull", pushed], { stdio: "pipe" });
  } catch {
    unauthPullFailed = true;
  }
  if (!unauthPullFailed) throw new Error("무인증 docker pull 이 성공해버림 — 레지스트리 인증 미강제");
  console.log("⑥ 카탈로그 확인 + 유저 docker config 불가침 + 무인증 pull 거부 확인");

  // ⑦ 인증 pull(런타임 소비자와 같은 경로 — DockerDriver/러너 pre-pull 이 쓰는 pullWithRegistryAuth).
  const { pullWithRegistryAuth } = await import(join(ROOT, "packages/drivers/dist/index.js"));
  await pullWithRegistryAuth(pushed, { host: REG_HOST, username: USER, password: PASS });
  const pulledId = sh("docker", ["image", "inspect", pushed, "--format", "{{.Id}}"]).trim();
  if (pulledId !== builtId) throw new Error(`pull 이미지 sha 불일치: ${pulledId} != ${builtId}`);
  console.log("⑦ pullWithRegistryAuth 인증 pull 성공 + sha 일치");
  console.log("✓ PASS — 발행→인증 pull 전 과정 라이브 검증 완료");
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  // ⑧ 정리 — 레지스트리/이미지/CP.
  api?.kill();
  try {
    sh("docker", ["rm", "-f", REG_NAME], { stdio: "ignore" });
    sh("docker", ["rmi", "-f", `${REG_HOST}/${IMAGE}`, IMAGE], { stdio: "ignore" });
  } catch {
    // best-effort 정리
  }
}
