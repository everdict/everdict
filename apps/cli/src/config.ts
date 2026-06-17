import type { RunContext } from "@assay/core";

// 환경변수 → RunContext.
// claude CLI 는 이 머신의 구독(subscription) 로그인으로 동작하므로 보통 키가 필요 없다.
// ANTHROPIC_API_KEY 는 로그인이 없는 신선한 샌드박스(E2B 등)·CI 에서만 주입한다.
export function runContextFromEnv(): RunContext {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  const apiKeyEnv: Record<string, string> = {};
  if (key) apiKeyEnv.ANTHROPIC_API_KEY = key;
  const timeoutSec = Number(process.env.ASSAY_TIMEOUT_SEC ?? "300");
  return { apiKeyEnv, timeoutSec };
}
