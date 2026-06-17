import type { RunContext } from "@assay/core";

// claude 인증 env 변수 (claude 바이너리에서 확인). 우선순위: 구독 토큰 → auth 토큰 → API 키.
const AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

// 현재 프로세스 env 에서 존재하는 claude 인증 변수만 모은다.
// LocalDriver/로컬 백엔드: 이 값들(보통 비어있음) → claude 는 머신 로그인 사용.
// Nomad 백엔드: 이 값들을 잡(alloc)으로 주입한다(샌드박스엔 로그인이 없으므로).
export function collectAuthEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of AUTH_VARS) {
    const val = process.env[v];
    if (val) out[v] = val;
  }
  return out;
}

export function runContextFromEnv(): RunContext {
  return {
    apiKeyEnv: collectAuthEnv(),
    timeoutSec: Number(process.env.ASSAY_TIMEOUT_SEC ?? "300"),
  };
}

export function hasClaudeAuth(): boolean {
  return Object.keys(collectAuthEnv()).length > 0;
}
