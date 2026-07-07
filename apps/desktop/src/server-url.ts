// 데스크톱이 렌더링할 웹(서버) URL 결정 — 순수 함수(electron 미의존). 설계 D8(docs/architecture/desktop-app.md):
// 패키징된 앱은 접속할 서버를 알아야 로그인 화면에 도달한다. 우선순위:
//   env EVERDICT_WEB_URL(개발/e2e 오버라이드) > config.json webUrl(첫 실행/트레이에서 사용자가 저장)
//   > CI 주입 기본값(esbuild define — 릴리즈 빌드에 배포 URL 을 굽는다). 전부 없으면 null → 설정 화면.
export function normalizeWebUrl(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString().replace(/\/$/, "");
}

export interface WebUrlSources {
  envUrl?: string | undefined;
  configUrl?: string | undefined;
  bakedUrl?: string | undefined;
}

export function resolveWebUrl(sources: WebUrlSources): string | null {
  return normalizeWebUrl(sources.envUrl) ?? normalizeWebUrl(sources.configUrl) ?? normalizeWebUrl(sources.bakedUrl);
}
