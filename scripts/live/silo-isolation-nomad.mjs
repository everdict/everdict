// 라이브: Nomad silo 스토어 격리(테넌트 전용 인스턴스). NomadTopologyRuntime 이 존마다 **별도 전용 PG 잡**을 띄우고
// host:port 를 발견해 서비스 connEnv 로 와이어링(pool 과 같은 discover-then-inject, DDL 없음). silo 격리 = 물리적
// 별도 인스턴스. 증명: 두 존 → 서로 다른 전용 PG 잡(다른 host:port), 각 PG 접속 가능.
//
// 준비: `nomad agent -dev`(docker driver) + postgres:16-alpine 호스트 docker.
// 사용: PATH=$HOME/.local/bin:$PATH NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/silo-isolation-nomad.mjs
import net from "node:net";
import process from "node:process";
import { NomadTopologyRuntime, dedicatedStoreJobId, topologyJobId } from "../../packages/topology/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";

const spec = {
  kind: "service",
  id: "silo-nomad",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "mendhak/http-https-echo:latest", needs: [], perRun: [], replicas: 1 }],
  dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
// trusted:false → silo 파생(전용 인스턴스). namespace 미설정=default.
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  network: "deny-cross-tenant",
  trusted: false,
  storeIsolation: "silo",
});

const rt = new NomadTopologyRuntime({ addr: ADDR, datacenters: ["dc1"], pollIntervalMs: 2000, maxPolls: 60 });

// 토폴로지 잡의 서비스 env(DATABASE_URL) 읽기.
const serviceDbUrl = async (zoneId) => {
  const res = await fetch(`${ADDR}/v1/job/${topologyJobId(spec, zoneId)}`);
  const job = await res.json();
  const env = job.TaskGroups?.[0]?.Tasks?.[0]?.Env ?? {};
  return env.DATABASE_URL ?? "";
};
const jobExists = async (id) => (await fetch(`${ADDR}/v1/job/${id}`)).status === 200;
// 전용 PG 의 host-mapped 동적 포트로 TCP 접속 확인(initdb 대기 재시도). DATABASE_URL=...@127.0.0.1:<port>/...
const tcpOk = (host, port) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
const pgReachable = async (url) => {
  const m = /@([\d.]+):(\d+)\//.exec(url);
  if (!m) return false;
  for (let i = 0; i < 20; i++) {
    if (await tcpOk(m[1], Number(m[2]))) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
};

console.log("Nomad silo 스토어 격리 — 존마다 전용 PG 인스턴스(별도 host:port), 각 접속 가능 검증\n");
let ok = false;
try {
  await rt.ensureTopology(spec, zone("acme"));
  await rt.ensureTopology(spec, zone("globex"));

  const acmeJob = await jobExists(dedicatedStoreJobId(spec, "acme"));
  const globexJob = await jobExists(dedicatedStoreJobId(spec, "globex"));
  const acmeUrl = await serviceDbUrl("acme");
  const globexUrl = await serviceDbUrl("globex");
  const distinct = acmeUrl !== "" && globexUrl !== "" && acmeUrl !== globexUrl; // 다른 인스턴스 host:port
  const acmeReady = await pgReachable(acmeUrl);
  const globexReady = await pgReachable(globexUrl);

  console.log(`dedicated PG jobs : acme=${acmeJob} globex=${globexJob}`);
  console.log(`acme  service DATABASE_URL: ${acmeUrl}`);
  console.log(`globex service DATABASE_URL: ${globexUrl}`);
  console.log(`distinct instances(host:port 다름): ${distinct}`);
  console.log(`PG reachable     : acme=${acmeReady} globex=${globexReady}`);

  ok = acmeJob && globexJob && distinct && acmeReady && globexReady;
  console.log(
    ok
      ? "\n✅ Nomad silo: 존마다 전용 PG 인스턴스(별도 host:port) 배포 + 서비스에 발견된 엔드포인트 주입 + 각 접속 가능. 물리 격리. K8s↔Nomad silo 패리티 → 스토어 격리 매트릭스 완성(pool+silo, 양 오케스트레이터)."
      : "\n⚠️ 일부 체크 실패",
  );
} finally {
  await rt.teardown(spec, zone("acme")).catch(() => {});
  await rt.teardown(spec, zone("globex")).catch(() => {});
  console.log("teardown: 토폴로지+전용 스토어 잡 purge 요청됨");
}
process.exit(ok ? 0 : 1);
