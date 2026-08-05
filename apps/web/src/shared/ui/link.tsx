import type { ComponentProps } from 'react'
import NextLink from 'next/link'

// 이 앱의 유일한 링크. `next/link` 를 직접 쓰지 않는 이유는 기본값 하나 때문이다 — **prefetch 를 끈다**.
//
// 이 앱의 라우트는 전부 `force-dynamic` 이라, prefetch 가 실제로 받아 오는 것은 로딩 경계까지의 공유
// 레이아웃 껍데기뿐이다(진짜 데이터는 어차피 클릭할 때 받는다). 그 껍데기는 지금 그리고 있는 화면이 이미
// 들고 있으니 얻는 것이 거의 없다. 반면 값은 크다: 라우터 캐시가 무효화될 때마다 화면에 걸린 모든 링크가
// 한꺼번에 다시 prefetch 되고(동시 4개 제한 + 무효화마다 300ms 쿨다운), 그동안 진행 중인 변이의
// `useTransition` 이 그 큐에 묶여 컨트롤이 스피너에 잠긴다. 변이 하나가 화면의 링크 수만큼 느려지는 셈이라,
// 이슈 상세에서 프로젝트를 배정하는 데 4~13초가 걸렸다(서버 반영은 150ms 에 끝나 있었다).
// 이동 자체는 로딩 경계가 받아 준다 — 클릭에서 URL 36ms, 본문 335ms 로 체감 차이가 없다.
//
// 그래서 기본은 끈 채로 두고, 정말 미리 받아 둘 값이 있는 링크만 `prefetch` 를 명시해서 켠다.
// 자세한 내용은 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export function Link({ prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />
}
