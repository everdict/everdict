// 라이브 검증: warm 토폴로지가 테넌트(trust-zone)별로 분리된다 — 공유 금지.
//
// 같은 하니스 spec + 같은 version 을 두 테넌트(alpha, beta)로 ensureTopology 하면,
// 하나의 warm 풀을 공유하는 게 아니라 존별로 별개의 Nomad service 잡이 뜬다
// (assay-harness-...-alpha, ...-beta 가 동시에 running). 평가는 임의 코드 실행이므로
// warm 프로세스를 테넌트 간 공유하면 안 된다.
//
// 사용: NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/tenant-isolation-nomad.mjs
//
// 주의(정직성): 이 dev 클러스터는 docker runtime 으로 runc 만 있고 namespace 미설정이라,
// 데모 존은 trusted=true(runc 허용) + namespace 미지정으로 둔다. 실 untrusted 테넌트는 runsc/kata +
// 전용 네임스페이스가 강제된다(이 부분은 단위테스트로 검증; 클러스터에 runsc/namespace 필요).

import { NomadTopologyRuntime } from "../../packages/topology/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const FRONTDOOR_IMAGE = process.env.FRONTDOOR_IMAGE ?? "mendhak/http-https-echo:latest";
const STAMP = Date.now().toString(36);
const VERSION = `iso-${STAMP}`;

const SPEC = {
  kind: "service",
  id: "bu",
  version: VERSION,
  services: [{ name: "agent-server", image: FRONTDOOR_IMAGE, port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["url"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://127.0.0.1:5501" },
};

// dev 클러스터용 존: runc 허용(trusted) + namespace 미지정. zone.id 만으로 warm 풀이 분리됨을 본다.
const zone = (id) => ({ id, isolationRuntime: "runc", network: "open", trusted: true });

async function harnessJobs() {
  const r = await fetch(`${NOMAD_ADDR}/v1/jobs?prefix=assay-harness-bu-${VERSION}&namespace=*`);
  const jobs = await r.json();
  return jobs.map((j) => ({ id: j.ID, status: j.Status }));
}

async function main() {
  const runtime = new NomadTopologyRuntime({
    addr: NOMAD_ADDR,
    pollIntervalMs: 1500,
    maxPolls: 80,
    readyTimeoutMs: 60000,
  });

  console.log(`same spec (bu@${VERSION}) for two tenants: alpha, beta\n`);
  const a = await runtime.ensureTopology(SPEC, zone("alpha"));
  console.log("  tenant alpha front-door:", a.endpoints["agent-server"]);
  const b = await runtime.ensureTopology(SPEC, zone("beta"));
  console.log("  tenant beta  front-door:", b.endpoints["agent-server"]);

  const jobs = await harnessJobs();
  console.log("\n=== warm topology jobs on Nomad (same spec+version) ===");
  for (const j of jobs) console.log(`  ${j.id}  [${j.status}]`);

  const shared = a.endpoints["agent-server"] === b.endpoints["agent-server"];
  const distinct = jobs.length >= 2 && new Set(jobs.map((j) => j.id)).size >= 2;
  console.log("\n=== RESULT ===");
  console.log("alpha/beta share the same front-door endpoint?", shared);
  console.log("two distinct warm topology jobs exist?       ", distinct);
  console.log(
    !shared && distinct
      ? "✅ warm pools are per-tenant — NOT shared across tenants"
      : "❌ warm pool appears shared across tenants",
  );

  console.log("\ntearing down both tenants' warm topologies …");
  await runtime.teardown(SPEC, zone("alpha"));
  await runtime.teardown(SPEC, zone("beta"));
  const left = await harnessJobs();
  console.log("remaining warm jobs after teardown:", left.filter((j) => j.status !== "dead").length);
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
