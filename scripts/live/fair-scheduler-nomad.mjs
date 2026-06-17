// 라이브 검증: 테넌트 공정 스케줄링(WFQ)이 실제 Nomad 위에서 작동한다.
//
// 테넌트 A 가 4건을 먼저, 테넌트 B 가 1건을 나중에 제출한다. 백엔드 cap=1(한 번에 하나).
//  - FIFO 라면 B 는 맨 마지막(5번째)에야 실행된다.
//  - WFQ 라면 B 는 A 한 건 뒤(2번째)에 끼어든다 → 한 테넌트의 대량 제출이 다른 테넌트를 굶기지 않음.
// 디스패치 순서를 래퍼 백엔드로 기록해 증명한다.
//
// 사용: NOMAD_ADDR=http://127.0.0.1:4646 ASSAY_AGENT_IMAGE=assay-agent:local node scripts/live/fair-scheduler-nomad.mjs

import { BackendRegistry, NomadBackend, Scheduler } from "../../packages/backends/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.ASSAY_AGENT_IMAGE ?? "assay-agent:local";
const STAMP = Date.now().toString(36);

// 디스패치된 케이스 id 순서를 기록하는 래퍼.
class LoggingBackend {
  id = "nomad";
  order = [];
  constructor(inner) {
    this.inner = inner;
  }
  capacity() {
    return this.inner.capacity();
  }
  dispatch(job) {
    this.order.push(job.evalCase.id);
    return this.inner.dispatch(job);
  }
}

function jobFor(tenant, label) {
  return {
    harness: { id: "scripted", version: "latest" },
    tenant,
    evalCase: {
      id: `${STAMP}-${label}`,
      env: { kind: "repo", source: { files: {} } },
      task: `fair sched ${label}`,
      graders: [{ id: "steps" }],
      timeoutSec: 120,
      tags: ["live", "fair"],
    },
  };
}

async function main() {
  const backend = new LoggingBackend(new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: 1 }));
  const sched = new Scheduler(new BackendRegistry().register("nomad", backend)); // 동일 weight, WFQ

  // A 4건 먼저, B 1건 나중 — 전부 한꺼번에 제출.
  const submit = [
    jobFor("tenant-A", "A0"),
    jobFor("tenant-A", "A1"),
    jobFor("tenant-A", "A2"),
    jobFor("tenant-A", "A3"),
    jobFor("tenant-B", "B0"),
  ];
  console.log("submitted: A0,A1,A2,A3 (tenant-A), then B0 (tenant-B); backend cap=1\n");

  const t0 = Date.now();
  const results = await Promise.all(
    submit.map((j) => sched.dispatch(j).then(() => j.evalCase.id.replace(`${STAMP}-`, ""))),
  );

  const order = backend.order.map((id) => id.replace(`${STAMP}-`, ""));
  const bIndex = order.indexOf("B0");
  console.log("=== RESULT ===");
  console.log("dispatch order :", order.join(" → "));
  console.log("completed      :", results.length, `cases in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`tenant-B served at position: ${bIndex + 1} of ${order.length}`);
  console.log(
    bIndex === 1
      ? "✅ WFQ fairness — B jumped ahead of A's backlog (FIFO would put B last)"
      : `⚠ B at position ${bIndex + 1} (expected 2)`,
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
