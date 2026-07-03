// 창 네비게이션 정책 — 순수 함수(electron 미의존, 테스트 용이). 설계: docs/architecture/desktop-app.md D1/D4/D5.
//
// 앱 창은 "배포된 웹에 고정된 브라우저 탭"이다. 탑레벨 네비게이션은 http/https 면 허용한다 —
// Keycloak OIDC 로그인과 연결계정 OAuth 가 웹 origin 밖(Keycloak/GitHub)을 경유해 리다이렉트로
// 돌아오는 플로우라서, 웹 origin 만 허용하면 로그인 자체가 깨진다. 로컬 권한(브리지)은 네비게이션
// 정책이 아니라 IPC 계층의 sender origin 검사로 지킨다(슬라이스 3).
// window.open(새 창)은 웹 origin 만 앱 안에 허용하고, 그 외 http/https 는 시스템 브라우저로 넘긴다.

export type WindowOpenDecision = "in-app" | "external" | "deny";

// 설정된 웹 URL → origin (비교 기준). 잘못된 URL 은 기동 실패가 맞으므로 throw 그대로.
export function webOriginOf(webUrl: string): string {
  return new URL(webUrl).origin;
}

// window.open / target=_blank 판정: 웹 origin=in-app 새 창, 그 외 http/https=시스템 브라우저, 나머지(javascript: 등)=차단.
export function decideWindowOpen(target: string, webOrigin: string): WindowOpenDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  if (url.origin === webOrigin) return "in-app";
  return url.protocol === "http:" || url.protocol === "https:" ? "external" : "deny";
}

// 탑레벨 네비게이션 판정: http/https 만(위 주석의 OIDC/OAuth 리다이렉트 근거). file:/javascript: 등은 차단.
export function allowTopLevelNavigation(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}
