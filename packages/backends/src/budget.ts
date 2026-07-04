import { type CaseResult, PaymentRequiredError, type TraceEvent } from "@assay/core";

// 테넌트 예산. 어떤 차원이든 미지정이면 무제한.
export interface BudgetLimit {
  usd?: number; // 누적 비용 상한
  tokens?: number; // 누적 토큰 상한
  runs?: number; // 누적 실행 수 상한(레이트/볼륨)
}

export interface BudgetUsage {
  usd: number;
  tokens: number;
  runs: number; // admit 된 실행 수(예약 포함)
}

// 트레이스의 llm_call cost 를 합산 → 한 run 의 비용.
export function sumCost(trace: TraceEvent[]): { usd: number; tokens: number } {
  let usd = 0;
  let tokens = 0;
  for (const e of trace) {
    if (e.kind === "llm_call" && e.cost) {
      usd += e.cost.usd;
      tokens += e.cost.inputTokens + e.cost.outputTokens;
    }
  }
  return { usd, tokens };
}

export function costOf(result: CaseResult): { usd: number; tokens: number } {
  return sumCost(result.trace);
}

// 이 run 의 비용을 누구 예산에 달 것인가(settle 대상 테넌트) — provenance 로 결정.
//  - 관리형 백엔드(self-hosted 아님): 잡의 원래 테넌트가 결제(originalTenant).
//  - 워크스페이스-공유 셀프호스티드 러너(provenance.by = "ws:<workspace>"): 그 워크스페이스가 결제(팀 자원).
//    by 는 SelfHostedBackend 가 러너 owner 로 스탬프하고, 워크스페이스-공유 러너의 owner 는 "ws:<workspace>".
//  - 개인 셀프호스티드 러너(by = subject): 유저 자기 로그인이 결제 주체 → 워크스페이스 버짓 미차감(undefined).
// undefined = settle 하지 않음(own-pays). 설계: docs/architecture/self-hosted-runtime-and-runners.md.
export function billingTenant(result: CaseResult, originalTenant: string): string | undefined {
  const prov = result.provenance;
  if (!prov || prov.ranOn !== "self-hosted") return originalTenant;
  const by = prov.by;
  if (by !== undefined && by.startsWith("ws:")) return by.slice("ws:".length);
  return undefined;
}

// 테넌트 예산 추적기.
//  - admit: 실행을 받기 전(큐잉 전) 검사. 이미 commit 된 usd/tokens 가 상한이거나, runs(예약 포함)가
//    상한이면 PaymentRequiredError(402). 통과하면 run 1건을 즉시 예약(버스트가 상한을 못 넘게).
//  - settle: 실행 완료 후 실제 비용(usd/tokens)을 commit. (usd/tokens 는 실행 전 알 수 없으므로
//    상한을 살짝 넘는 마지막 run 은 허용 — 비용 예산의 표준 동작.)
export interface BudgetTracker {
  admit(tenant: string): void;
  settle(tenant: string, cost: { usd: number; tokens: number }): void;
  usage(tenant: string): BudgetUsage;
}

export interface InMemoryBudgetOptions {
  limitFor: (tenant: string) => BudgetLimit | undefined;
}

export function inMemoryBudget(opts: InMemoryBudgetOptions): BudgetTracker {
  const usage = new Map<string, BudgetUsage>();
  const get = (t: string): BudgetUsage => {
    let u = usage.get(t);
    if (!u) {
      u = { usd: 0, tokens: 0, runs: 0 };
      usage.set(t, u);
    }
    return u;
  };
  return {
    admit(tenant) {
      const limit = opts.limitFor(tenant);
      if (!limit) {
        get(tenant).runs += 1; // 무제한이어도 실행 수는 집계
        return;
      }
      const u = get(tenant);
      if (limit.usd !== undefined && u.usd >= limit.usd) {
        throw new PaymentRequiredError("BUDGET_EXCEEDED", { tenant, usd: u.usd, limit: limit.usd }, "비용 예산 초과");
      }
      if (limit.tokens !== undefined && u.tokens >= limit.tokens) {
        throw new PaymentRequiredError("BUDGET_EXCEEDED", { tenant, tokens: u.tokens }, "토큰 예산 초과");
      }
      if (limit.runs !== undefined && u.runs >= limit.runs) {
        throw new PaymentRequiredError(
          "BUDGET_EXCEEDED",
          { tenant, runs: u.runs, limit: limit.runs },
          "실행 수 예산 초과",
        );
      }
      u.runs += 1; // 예약(버스트 동시제출이 상한을 못 넘게)
    },
    settle(tenant, cost) {
      const u = get(tenant);
      u.usd += cost.usd;
      u.tokens += cost.tokens;
    },
    usage(tenant) {
      return { ...get(tenant) };
    },
  };
}
