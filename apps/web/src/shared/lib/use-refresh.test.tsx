import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 회귀 테스트 — 변이 뒤의 화면 갱신은 부른 쪽의 트랜지션 **밖에서** 일어나야 한다.
//
// `startTransition(async () => { await action(); router.refresh() })` 처럼 트랜지션 안에서 부르면 라우터
// 갱신이 그 트랜지션과 엮여, 새 RSC 가 도착한 뒤에도 커밋이 미뤄진다 — 실측으로 같은 클릭이 26ms 에
// 끝나기도 하고 14.8초가 걸리기도 했고(그 사이 네트워크는 끝나 있고 메인 스레드는 idle), 커밋은 관계없는
// 다른 업데이트가 일어날 때 따라왔다. 그래서 이 훅은 ① 타이머 한 틱 뒤로 미뤄 트랜지션 밖에서 부르고,
// ② 응답이 도착할 만한 시점들에 빈 상태 변화를 넣어 대기 중인 커밋을 깨운다.
const refreshSpy = vi.fn()
const wake = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, useReducer: () => [0, wake] as const }
})

const { useRefresh } = await import('./use-refresh')

// 훅은 컴포넌트 안에서만 살 수 있다 — 한 번 렌더해서 돌려받은 함수를 꺼내 온다.
function callRefresh(): void {
  let captured: (() => void) | undefined
  function Probe() {
    captured = useRefresh()
    return null
  }
  renderToStaticMarkup(<Probe />)
  captured?.()
}

describe('refresh after a mutation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    refreshSpy.mockClear()
    wake.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never refreshes in the caller own synchronous scope', () => {
    callRefresh()

    // 부른 그 자리(= 변이의 트랜지션 안)에서는 아직 아무 일도 일어나지 않는다.
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('refreshes on the next tick and then wakes the pending commit', () => {
    callRefresh()
    vi.advanceTimersByTime(0)

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    // 갱신 직후에는 아직 응답이 없다 — 깨우기는 그 뒤로 예약된다.
    expect(wake).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)

    expect(wake.mock.calls.length).toBeGreaterThan(0)
    // 깨우기는 유한하다: 무한 폴링이 되면 화면이 조용해지지 않는다.
    const woken = wake.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(wake.mock.calls.length).toBe(woken)
  })
})
