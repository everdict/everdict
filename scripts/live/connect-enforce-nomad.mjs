// 라이브 하니스: Nomad **데이터플레인 enforce**(Consul Connect/Envoy) 시도. Connect-enabled echo 서버(테넌트별) +
// upstream 2개(같은/다른 테넌트)를 가진 probe + intention deny-default → 같은 테넌트 ALLOWED, 다른 테넌트 DENIED 를 노린다.
//
// 상태(2026-06-20): **부분 검증.** 전제 인프라는 충족 — root nomad(bridge/iptables) + self-contained Consul(gRPC/xDS,
//   18500/18502) + Envoy 사이드카가 healthy 로 뜨고 서비스 등록·앱 도달까지 확인됨. 그러나 probe 의 upstream 라우팅이
//   **모든 목적지에서 reset**(같은/다른 테넌트 둘 다) → allow/deny 차등을 깔끔히 못 보였다(블랭킷 reset 은 enforce 증명이
//   아님). Envoy 이미지에 curl/wget 부재로 admin(/clusters @127.0.0.2:19001) 인트로스펙션이 막혀 원인(upstream xDS 엔드포인트
//   미수신 추정) 미해결. **권위 있는 네트워크 격리 증명은 여전히 intention 결정(SLICE 43, /v1/connect/intentions/check)**;
//   이 하니스는 (a) Connect 빌더(buildConnectService)가 정상 잡을 렌더하고 (b) 메시가 Nomad-as-root+gRPC-Consul 에서
//   기동함을 보인다. FOLLOW-UP: upstream xDS 라우팅 원인 규명(인트로스펙션 가능한 envoy 이미지/디버그 잡).
// 사용: PATH=$HOME/.local/bin:$PATH node scripts/live/connect-enforce-nomad.mjs (root nomad + alt consul-dev 필요)
import { execFileSync } from "node:child_process";
import process from "node:process";
import { buildConnectService, consulHttp } from "../../packages/topology/dist/index.js";

const NOMAD = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const CONSUL = process.env.CONSUL_HTTP_ADDR ?? "http://127.0.0.1:18500";
const consul = consulHttp(CONSUL);
const nomad = (args) => execFileSync("nomad", args, { encoding: "utf8", env: { ...process.env, NOMAD_ADDR: NOMAD } });
const submit = async (job) => {
  const r = await fetch(`${NOMAD}/v1/jobs`, { method: "POST", body: JSON.stringify({ Job: job }) });
  if (!r.ok) throw new Error(`submit ${job.ID}: ${r.status} ${(await r.text()).slice(0, 200)}`);
};

// Connect echo 서버 잡(메시 서비스 t-<zone>-echo + Envoy sidecar).
const echoJob = (zone) => ({
  ID: `echo-${zone}`,
  Type: "service",
  Datacenters: ["dc1"],
  TaskGroups: [
    {
      Name: "echo",
      Count: 1,
      // Connect: bridge + 서비스 포트는 앱이 듣는 리터럴 포트(8080) — 사이드카가 netns 안 localhost:8080 으로 포워드.
      Networks: [{ Mode: "bridge" }],
      Services: [buildConnectService(`t-${zone}-echo`, "8080")],
      Tasks: [
        {
          Name: "echo",
          Driver: "docker",
          Config: { image: "mendhak/http-https-echo:latest" },
          Resources: { CPU: 200, MemoryMB: 128 },
        },
      ],
    },
  ],
});
// probe 잡: 같은 테넌트(acme) echo + 다른 테넌트(globex) echo 로의 upstream 2개. busybox 로 도달성 테스트.
const probeJob = {
  ID: "probe-acme",
  Type: "service",
  Datacenters: ["dc1"],
  TaskGroups: [
    {
      Name: "probe",
      Count: 1,
      // probe 도 실제 inbound 앱(echo:8080)을 둬 sidecar 서비스가 healthy → upstream xDS 가 정상 전달되게.
      Networks: [{ Mode: "bridge" }],
      Services: [
        buildConnectService("t-probe-acme", "8080", [
          { DestinationName: "t-acme-echo", LocalBindPort: 7001 }, // 같은 테넌트
          { DestinationName: "t-globex-echo", LocalBindPort: 7002 }, // 다른 테넌트(차단돼야)
        ]),
      ],
      Tasks: [
        {
          Name: "probe",
          Driver: "docker",
          Config: { image: "mendhak/http-https-echo:latest" }, // alpine+node → wget 있음, 8080 listen
          Resources: { CPU: 150, MemoryMB: 128 },
        },
      ],
    },
  ],
};

const runningAlloc = async (jobId) => {
  const a = await (await fetch(`${NOMAD}/v1/job/${jobId}/allocations`)).json();
  return a.find((x) => x.ClientStatus === "running")?.ID;
};
const probeAllocId = () => runningAlloc("probe-acme");
const waitRunning = async (jobId, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const id = await runningAlloc(jobId);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
};
const reach = (allocId, port) => {
  try {
    const out = nomad([
      "alloc",
      "exec",
      "-task",
      "probe",
      allocId,
      "wget",
      "-T",
      "4",
      "-qO-",
      `http://localhost:${port}/`,
    ]);
    return out.length > 0 ? "ALLOWED" : "DENIED";
  } catch {
    return "DENIED"; // 연결 거부/타임아웃 = 메시가 차단
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("Nomad 데이터플레인 enforce(Consul Connect/Envoy) — intention 을 메시가 실제 차단하는지 검증\n");
let ok = false;
try {
  await submit(echoJob("acme"));
  await submit(echoJob("globex"));
  await submit(probeJob);
  // intentions: acme-echo 는 probe 허용, globex-echo 는 거부(교차).
  await consul.applyIntention({
    Kind: "service-intentions",
    Name: "t-acme-echo",
    Sources: [
      { Name: "t-probe-acme", Action: "allow" },
      { Name: "*", Action: "deny" },
    ],
  });
  await consul.applyIntention({
    Kind: "service-intentions",
    Name: "t-globex-echo",
    Sources: [{ Name: "*", Action: "deny" }],
  });

  // echo 서버들 + probe 의 Envoy sidecar 가 모두 뜰 때까지 대기(이미지 pull + xDS sync).
  const eAcme = await waitRunning("echo-acme");
  const eGlobex = await waitRunning("echo-globex");
  const allocId = await waitRunning("probe-acme");
  if (!allocId || !eAcme || !eGlobex) throw new Error("alloc 이 running 이 안 됨(Envoy/이미지 확인)");
  console.log("allocs running (echo-acme, echo-globex, probe) — Envoy/xDS 안정화 대기 40s …");
  await sleep(40000);

  let sameTenant = "DENIED";
  let crossTenant = "ALLOWED";
  for (let i = 0; i < 12; i++) {
    sameTenant = reach(allocId, 7001);
    crossTenant = reach(allocId, 7002);
    if (sameTenant === "ALLOWED") break; // 같은 테넌트가 뚫리면 메시 준비된 것
    await sleep(5000);
  }
  console.log(`\nsame-tenant  probe → t-acme-echo  : ${sameTenant}`);
  console.log(`cross-tenant probe → t-globex-echo: ${crossTenant}   <-- Envoy 가 차단해야 함`);

  ok = sameTenant === "ALLOWED" && crossTenant === "DENIED";
  console.log(`\nchecks: same-allowed=${sameTenant === "ALLOWED"} cross-denied=${crossTenant === "DENIED"}`);
  console.log(
    ok
      ? "\n✅ Nomad 데이터플레인 enforce: Consul Connect/Envoy 가 intention 을 실제로 적용 — 같은 테넌트 도달, 교차 테넌트 Envoy 차단. K8s NetworkPolicy(Calico)↔Nomad Consul-Connect enforce 패리티 완성."
      : "\n⚠️ 일부 체크 실패(메시 미준비 가능 — Envoy/xDS 로그 확인)",
  );
} finally {
  if (process.env.KEEP === "1") {
    console.log("KEEP=1 → teardown 생략(검사용)");
    process.exit(ok ? 0 : 1);
  }
  for (const id of ["probe-acme", "echo-acme", "echo-globex"]) {
    try {
      nomad(["job", "stop", "-purge", id]);
    } catch {}
  }
  for (const n of ["t-acme-echo", "t-globex-echo"]) await consul.deleteIntention(n).catch(() => {});
  console.log("teardown: 잡 purge + intentions 삭제");
}
process.exit(ok ? 0 : 1);
