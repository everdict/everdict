// 라이브 검증: 큐 깊이 기반 오토스케일링이 실제 Nomad 위에서 용량을 탄력 조정한다.
//
// NomadBackend 는 maxConcurrent 를 동적(슬롯 게터)으로 읽는다. 시작 슬롯=1. N개를 한꺼번에 제출하면
// 스케줄러가 1개만 띄우고 나머지는 큐에 쌓인다 → 오토스케일러가 backlog 를 보고 슬롯을 MAX 까지 올려
// 동시 alloc 이 늘고, 큐가 빠지면 다시 MIN 으로 줄인다. 폴러가 실제 동시 alloc 수를 관측한다.
//
// 사용: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-agent:local node scripts/live/autoscaler-nomad.mjs

import {
  Autoscaler,
  BackendRegistry,
  MutableSlots,
  NomadBackend,
  Scheduler,
  aggregateLoad,
} from "../../packages/backends/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-agent:local";
const N = Number(process.env.N ?? "8");
const MIN = Number(process.env.MIN ?? "1");
const MAX = Number(process.env.MAX ?? "4");
const STAMP = Date.now().toString(36);

function jobFor(i) {
  return {
    harness: { id: "scripted", version: "latest" },
    evalCase: {
      id: `as-${STAMP}-${i}`,
      env: { kind: "repo", source: { files: {} } },
      task: `autoscale case ${i}`,
      graders: [{ id: "steps" }],
      timeoutSec: 120,
      tags: ["live", "autoscale"],
    },
  };
}

async function runningCount() {
  try {
    const r = await fetch(`${NOMAD_ADDR}/v1/jobs?prefix=everdict-as-${STAMP}&namespace=*`);
    const jobs = await r.json();
    return jobs.filter((j) => j.Status === "running" || j.Status === "pending").length;
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const slots = new MutableSlots("nomad", MIN); // 시작=MIN, 동적
  const backend = new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: slots.get });
  const sched = new Scheduler(new BackendRegistry().register("nomad", backend));

  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);
  const auto = new Autoscaler({
    signal: () => aggregateLoad(sched.stats()),
    targets: [slots],
    policy: { min: MIN, max: MAX, scaleDownAfterTicks: 3 },
    intervalMs: 600,
    onScale: (id, from, to) =>
      console.log(`  ↕ autoscale t+${el()}s  ${id}: ${from} → ${to} slots  (queued=${sched.stats().queued})`),
    onChanged: () => sched.poke(),
  });

  console.log(`submitting ${N} cases at once; slots start=${MIN}, autoscale range [${MIN}..${MAX}]\n`);
  let peak = 0;
  const poller = setInterval(async () => {
    peak = Math.max(peak, await runningCount());
  }, 400);
  auto.start();

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      sched
        .dispatch(jobFor(i))
        .then(() => true)
        .catch(() => false),
    ),
  );

  // drain 이후 스케일-다운 관측 (몇 틱 더 돌린다)
  console.log(`\nall ${results.filter(Boolean).length}/${N} done @ t+${el()}s — observing scale-down …`);
  for (let i = 0; i < 6 && slots.current() > MIN; i++) await sleep(700);

  auto.stop();
  clearInterval(poller);
  console.log("\n=== RESULT ===");
  console.log(`peak concurrent allocs on Nomad: ${peak} (autoscaled within [${MIN}..${MAX}])`);
  console.log(`final slots after drain        : ${slots.current()} (back toward MIN=${MIN})`);
  console.log(
    peak > MIN && peak <= MAX && slots.current() === MIN
      ? "✅ elastic: scaled UP under backlog, scaled DOWN when idle, never exceeded MAX"
      : `ℹ peak=${peak}, final=${slots.current()}`,
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
