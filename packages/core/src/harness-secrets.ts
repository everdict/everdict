import { BadRequestError } from "./errors.js";
import type { EnvValue, HarnessSpec } from "./harness-spec.js";

// env 맵을 문자열 맵으로 평탄화 — {secretRef} 를 lookup 에서 값으로 치환한다.
// 소비 지점(CommandHarness / 토폴로지 런타임)의 타입 좁히기용: 미해석 참조는 조용히 제외한다
// (컨트롤플레인이 이미 resolveHarnessSecrets 로 해석했거나, 시크릿 미존재 → 해당 env 미설정).
export function flattenEnv(env: Record<string, EnvValue>, lookup: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") {
      out[k] = v;
      continue;
    }
    const val = lookup[v.secretRef];
    if (val !== undefined) out[k] = val;
  }
  return out;
}

// 시크릿 티어 맵 — workspace(공유) + user(제출자 개인). 참조의 scope 에 따라 골라 쓴다.
export interface HarnessSecretMaps {
  workspace: Record<string, string>;
  user?: Record<string, string>;
}

// 하니스 스펙의 모든 env 맵에서 시크릿 참조를 실제 값으로 해석한다(디스패치 직전, SecretStore).
// command = env, service = 각 서비스의 env. 참조의 scope("user" | 기본 "workspace")로 티어를 고른다.
// 참조한 시크릿이 없으면 BadRequestError(무엇이/어느 티어가 빠졌는지 명시).
// 반환 스펙의 env 값은 전부 문자열이 되어(레지스트리엔 평문 미저장) 소비 지점이 그대로 쓴다.
export function resolveHarnessSecrets(spec: HarnessSpec, secrets: HarnessSecretMaps): HarnessSpec {
  const missing = new Set<string>();
  const resolve = (env: Record<string, EnvValue>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") {
        out[k] = v;
        continue;
      }
      const isUser = v.scope === "user";
      const val = (isUser ? (secrets.user ?? {}) : secrets.workspace)[v.secretRef];
      if (val === undefined) {
        missing.add(`${isUser ? "user:" : ""}${v.secretRef}`);
        continue;
      }
      out[k] = val;
    }
    return out;
  };

  // command 의 trace.authSecret(워크스페이스 시크릿 이름) → transient trace.auth 값 — 잡 안(collect=job) pull 이
  // 인증 헤더로 쓴다(에이전트는 SecretStore 에 닿지 못하므로 env 와 동일하게 디스패치 직전 해석).
  const resolveTrace = (trace: Extract<HarnessSpec, { kind: "command" }>["trace"]) => {
    if (trace.kind === "none" || !trace.authSecret) return trace;
    const val = secrets.workspace[trace.authSecret];
    if (val === undefined) {
      missing.add(trace.authSecret);
      return trace;
    }
    return { ...trace, auth: val };
  };

  const next: HarnessSpec =
    spec.kind === "command"
      ? { ...spec, env: resolve(spec.env), trace: resolveTrace(spec.trace) }
      : spec.kind === "service"
        ? { ...spec, services: spec.services.map((s) => ({ ...s, env: resolve(s.env) })) }
        : spec;

  if (missing.size > 0) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { secrets: [...missing] },
      `참조한 시크릿이 없습니다: ${[...missing].join(", ")}. 설정에서 먼저 등록하세요(user: = 개인 시크릿).`,
    );
  }
  return next;
}

// env 가 하나라도 개인(user) 스코프 시크릿을 참조하는가 — 그렇다면 이 하니스는 그 개인만 실행/열람 가능(비공개).
// 목록/상세 가시성 필터가 이 값을 createdBy 와 함께 써서 다른 유저에게 숨긴다.
export function referencesUserSecret(spec: HarnessSpec): boolean {
  const has = (env: Record<string, EnvValue>): boolean =>
    Object.values(env).some((v) => typeof v !== "string" && v.scope === "user");
  if (spec.kind === "command") return has(spec.env);
  if (spec.kind === "service") return spec.services.some((s) => has(s.env));
  return false;
}
