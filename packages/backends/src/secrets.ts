// 테넌트별 시크릿 스코핑 — 각 테넌트의 모델 키(ANTHROPIC_API_KEY 등)를 그 테넌트의 잡에만 주입한다.
// 한 테넌트의 키가 다른 테넌트의 샌드박스로 새지 않게 하는 것이 핵심(멀티테넌트 격리의 일부).
export interface SecretProvider {
  // 이 테넌트의 잡 env 에 주입할 시크릿. 절대 다른 테넌트 것을 섞지 않는다.
  secretsFor(tenant: string): Record<string, string>;
}

// 고정 매핑: tenant → env. 미등록 테넌트는 fallback(없으면 빈 값 → 키 없이 실행).
export function staticSecrets(
  byTenant: Record<string, Record<string, string>>,
  fallback: Record<string, string> = {},
): SecretProvider {
  return {
    secretsFor(tenant) {
      return { ...(byTenant[tenant] ?? fallback) };
    },
  };
}
