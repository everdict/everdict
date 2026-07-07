import type { RunStore, ScorecardStore } from "@everdict/db";

// 부팅 시 고아 작업 회수 — 배치(scorecard)와 run 은 컨트롤플레인 프로세스 안에서 in-process 로 track 된다
// (inFlight supersede/in-process 랑데부와 같은 단일 프로세스 전제). 따라서 프로세스가 재시작되면 이전
// 프로세스가 돌리던 queued/running 레코드는 다시 이어받을 주체가 없는 유령이 된다 — 큐/현황이 영원히
// "실행 중"을 보이는 원인. 부팅 시점에 이들을 failed(INTERRUPTED)로 종결해 상태를 사실과 일치시킨다.
// 주의: 같은 스토어(DB)를 공유하는 컨트롤플레인이 둘 이상이면 남의 in-flight 도 회수한다 — 단일
// 컨트롤플레인 전제(코드베이스 공통)를 그대로 따른다.

const INTERRUPTED = {
  code: "INTERRUPTED",
  message: "컨트롤플레인 재시작으로 실행이 중단됐어요. 다시 실행해주세요.",
};

const ACTIVE = new Set(["queued", "running"]);

export interface RecoveryDeps {
  scorecards: ScorecardStore;
  runs?: RunStore;
  now?: () => string;
}

export async function recoverInterrupted(deps: RecoveryDeps): Promise<{ scorecards: number; runs: number }> {
  const now = deps.now ?? (() => new Date().toISOString());
  let scorecardCount = 0;
  let runCount = 0;

  // ① 고아 배치 + 그 배치의 실행 중 자식 run.
  const cards = (await deps.scorecards.list()).filter((c) => ACTIVE.has(c.status));
  for (const c of cards) {
    await deps.scorecards.update(c.id, { status: "failed", error: INTERRUPTED, updatedAt: now() });
    scorecardCount += 1;
    if (!deps.runs) continue;
    const children = await deps.runs.list(c.tenant, { scorecardId: c.id });
    for (const child of children) {
      if (!ACTIVE.has(child.status)) continue;
      await deps.runs.update(child.id, { status: "failed", error: INTERRUPTED, updatedAt: now() });
      runCount += 1;
    }
  }

  // ② 고아 standalone run(활동 리스트 기본 스코프 — 자식은 ①에서 부모 기준으로 회수).
  if (deps.runs) {
    const runs = (await deps.runs.list()).filter((r) => ACTIVE.has(r.status));
    for (const r of runs) {
      await deps.runs.update(r.id, { status: "failed", error: INTERRUPTED, updatedAt: now() });
      runCount += 1;
    }
  }

  return { scorecards: scorecardCount, runs: runCount };
}
