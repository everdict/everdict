import type { RunContext } from "@assay/core";

// claude 인증 env 변수 (claude 바이너리에서 확인). 샌드박스에 주입할 때 이 순서로 본다:
// 구독 토큰 → auth 토큰 → API 키.
const AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

// 환경변수 → RunContext.
// LocalDriver 는 이 머신의 claude 구독 로그인을 그대로 사용하므로 보통 apiKeyEnv 가 비어있다.
// 샌드박스(E2B 등 로그인이 없는 곳)에선 위 변수 중 하나를 호스트 env/.env 에 두면 주입된다.
export function runContextFromEnv(): RunContext {
  const apiKeyEnv: Record<string, string> = {};
  for (const v of AUTH_VARS) {
    const val = process.env[v];
    if (val) apiKeyEnv[v] = val;
  }
  const timeoutSec = Number(process.env.ASSAY_TIMEOUT_SEC ?? "300");
  return { apiKeyEnv, timeoutSec };
}

export function hasClaudeAuth(ctx: RunContext): boolean {
  return AUTH_VARS.some((v) => Boolean(ctx.apiKeyEnv[v]));
}
