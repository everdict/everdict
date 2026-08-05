'use client'

import { useCallback, useReducer } from 'react'
import { useRouter } from 'next/navigation'

// 변이 뒤에 화면을 다시 그리는 유일한 방법. `router.refresh()` 를 직접 부르지 않는 이유가 둘 있다.
//
// ① 트랜지션 밖에서 불러야 한다. 변이는 거의 항상 `startTransition(async () => { await action(); … })` 안에서
//    일어나는데, 그 안에서 부르면 라우터 갱신이 우리 트랜지션과 엮여 컨트롤이 스피너에 붙잡힌다.
// ② 새 RSC 가 도착해도 커밋이 스스로 일어나지 않는다. 실측(이슈 상세, 프로젝트 배정 8회):
//    26·158·4691·9754·9757·14765·4754·235ms — 그동안 네트워크는 끝나 있고 메인 스레드는 idle 이며, 커밋은
//    **관계없는 다른 업데이트**가 한 번 일어날 때 따라온다(폴러가 돌거나, 사용자가 아무 버튼이나 누르거나).
//    그래서 화면 갱신 시점이 사실상 폴러 주기(~5초)에 묶여, 같은 클릭이 어떤 때는 즉시, 어떤 때는 15초 뒤에
//    반영됐다. 같은 8회를 300ms 지점에 인위적으로 깨우면 328·368·329·380·377·372·368·368ms 로 평평해진다.
//
// 그래서 여기서 두 가지를 한다: 타이머 한 틱 뒤로 미뤄 트랜지션 밖에서 `router.refresh()` 를 부르고, 응답이
// 도착할 만한 시점들에 빈 상태 변화를 넣어 대기 중인 커밋을 깨운다. 깨우기는 유한하고(4회), 렌더 비용은
// 이 훅을 든 컴포넌트 하나뿐이다. 자세한 내용은 `docs/web.md` §"A mutation refreshes; it must not revalidate".
const WAKE_AT_MS = [120, 350, 800, 1600]

export function useRefresh(): () => void {
  const router = useRouter()
  const [, wake] = useReducer((n: number) => n + 1, 0)
  return useCallback(() => {
    setTimeout(() => {
      router.refresh()
      for (const at of WAKE_AT_MS) setTimeout(wake, at)
    }, 0)
  }, [router])
}
