// 라이브 e2e: 개인 러너 풀(self). 내 러너 2개를 붙이고 러너 id 없이 self 로 제출하면 내 러너 아무거나 가져간다
// (여러 프로세스/머신을 한 개인 풀에). 워크스페이스 풀(self:ws)의 개인 버전 — owner=제출자, own-pays.
// 검증: POST /runners ×2 → assay runner ×2 → runtime=self 로 N잡 → 전부 succeeded, ranBy 는 내 러너 중 하나, by=제출자.
// 설계: docs/architecture/self-hosted-runtime-and-runners.md (슬라이스 2).
//
// 준비: pnpm build && node apps/api/dist/main.js
// 사용: node scripts/live/personal-pool.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.ASSAY_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-assay-tenant": "default", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// 개인 러너 2개 페어링(owner=dev, dev 폴백). POST /runners = 개인 소유.
const pair = async (label) => {
  const { runner, token } = await api("/runners", {
    method: "POST",
    body: JSON.stringify({ label, capabilities: ["git"] }),
  });
  return { id: runner.id, token };
};
const r1 = await pair("mine-a");
const r2 = await pair("mine-b");
console.log(`▶ paired 2 personal runners: ${r1.id}, ${r2.id}`);

const procs = [r1, r2].map((r) =>
  spawn(
    process.execPath,
    ["apps/cli/dist/main.js", "runner", "--pair", r.token, "--api-url", B, "--poll-interval-ms", "500"],
    { stdio: "inherit" },
  ),
);
const cleanup = () => {
  for (const p of procs) if (!p.killed) p.kill("SIGINT");
};
process.on("exit", cleanup);

try {
  await sleep(2500);
  const N = 4;
  const submit = (i) =>
    api("/runs", {
      method: "POST",
      body: JSON.stringify({
        harness: { id: "scripted", version: "0" },
        case: {
          id: `mine-${i}`,
          env: { kind: "repo", source: { files: {} } },
          task: "say hi",
          graders: [{ id: "steps" }],
          timeoutSec: 120,
          tags: ["e2e"],
          placement: { target: "self" }, // ← 개인 풀(러너 id 없이)
        },
      }),
    }).then((r) => r.id);
  const runIds = await Promise.all(Array.from({ length: N }, (_, i) => submit(i)));
  console.log(`▶ submitted ${N} runs → self (개인 풀)`);

  const ranOn = new Set();
  for (const id of runIds) {
    let rec;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      rec = await api(`/runs/${id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    if (rec.status !== "succeeded") throw new Error(`run ${id} ${rec.status}: ${JSON.stringify(rec.error)}`);
    const prov = rec.result?.provenance;
    if (prov?.ranOn !== "self-hosted") throw new Error(`run ${id} self-hosted 아님: ${JSON.stringify(prov)}`);
    if (prov.by !== "dev") throw new Error(`개인 풀은 own-pays(by=제출자) 여야 하는데 by=${prov.by}`);
    ranOn.add(prov.runner);
  }
  const known = new Set([r1.id, r2.id]);
  for (const id of ranOn) if (!known.has(id)) throw new Error(`알 수 없는 러너가 처리: ${id}`);
  console.log(`✓ ${N} runs 전부 succeeded (self-hosted, by=dev/own-pays); 처리 러너: ${[...ranOn].join(", ")}`);
  console.log("✓ PASS — self(개인 풀)이 내 러너로 라우팅(owner=제출자). 분배 완전성은 유닛 테스트가 증명.");
} finally {
  cleanup();
}
process.exit(0);
