// 화면별로 하나씩 기억하는 사용자 취향의 저장 계층 — "이 목록을 어떻게 그리나"처럼 **목록마다 다른** 값을
// 쿠키 하나에 담는다. 이슈 목록의 표시 설정과 평가 목록들의 그것이 같은 기계를 쓰게 하려고 여기 있다.
//
// 담는 그릇이 URLSearchParams 인 이유가 둘이다: 뷰 키에 들어가는 `:` 를 알아서 이스케이프하고, 같은 키가
// 두 번 적힌 손상된 쿠키에 대해 **마지막 하나**라는 한 가지 답을 준다(두 답이 있는 취향은 취향이 아니다).
//
// 쿠키인 이유는 localStorage 가 아니어야 하기 때문이다: 목록은 서버 컴포넌트가 첫 화면을 그리므로, 그리기
// 전에 이 값을 알아야 한다. localStorage 는 그 시점에 읽을 수 없어서 고른 보기가 깜빡임으로 도착한다.

export function decodeKeyedPreference(cookie: string | undefined): Map<string, string> {
  const entries = new Map<string, string>()
  if (cookie === undefined || cookie === '') return entries
  for (const [key, value] of new URLSearchParams(cookie)) entries.set(key, value)
  return entries
}

export function encodeKeyedPreference(entries: Map<string, string>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) params.append(key, value)
  return params.toString()
}

// 한 화면의 선택을 써 넣는다. 바뀐 화면이 맨 앞으로 오는 것이 요점이다 — 쿠키는 모든 요청에 실려 가므로
// 무한히 자랄 수 없고, 상한을 넘으면 **가장 오래 손대지 않은** 화면이 밀려나야 한다(아무거나가 아니라).
// 밀려난 화면은 다음에 열 때 기본값으로 돌아갈 뿐이다.
export function withKeyedPreference(
  cookie: string | undefined,
  key: string,
  value: string,
  max: number
): string {
  const existing = decodeKeyedPreference(cookie)
  existing.delete(key)
  const next = new Map<string, string>([[key, value]])
  for (const [otherKey, otherValue] of existing) {
    if (next.size >= max) break
    next.set(otherKey, otherValue)
  }
  return encodeKeyedPreference(next)
}

// 브라우저에서 직접 읽고 쓴다. 취향 쿠키는 httpOnly 가 아니고 데이터가 아니므로, 서버 액션 왕복을 한 번
// 거칠 이유가 없다 — 그리고 그 왕복이 바로 "그룹 바꿨는데 왜 이렇게 오래 걸리지"의 한 조각이었다.
// 인증·인가에 쓰이는 쿠키는 절대 이 문을 쓰지 않는다(그건 서버만 쓴다).
const PREFERENCE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export function readPreferenceCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (decodeURIComponent(part.slice(0, eq)) !== name) continue
    return decodeURIComponent(part.slice(eq + 1))
  }
  return undefined
}

export function writePreferenceCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=${PREFERENCE_MAX_AGE_SECONDS}; samesite=lax`
}
