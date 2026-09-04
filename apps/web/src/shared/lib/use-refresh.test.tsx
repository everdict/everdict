import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A regression test — the screen refresh after a mutation has to happen **outside** the caller's transition.
//
// Called INSIDE the transition, as in `startTransition(async () => { await action(); router.refresh() })`, the router refresh gets bound to
// that transition and the commit is deferred even after the new RSC has arrived — measured, the same click finished in 26ms one time and took
// 14.8 seconds another (with the network already done and the main thread idle in between), and the commit came along when some UNRELATED
// update happened. So this hook ① defers by one timer tick to call it outside the transition, and
// ② injects empty state changes at the moments a response is likely to arrive, to wake the pending commit.
const refreshSpy = vi.fn()
const wake = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, useReducer: () => [0, wake] as const }
})

const { useRefresh } = await import('./use-refresh')

// A hook can only live inside a component — it is rendered once and the returned function taken out.
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

    // Nothing has happened yet at the call site (= inside the mutation's transition).
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('refreshes on the next tick and then wakes the pending commit', () => {
    callRefresh()
    vi.advanceTimersByTime(0)

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    // There is no response immediately after the refresh — the wakes are scheduled after it.
    expect(wake).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)

    expect(wake.mock.calls.length).toBeGreaterThan(0)
    // The wakes are FINITE: an infinite poll would mean the screen never goes quiet.
    const woken = wake.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(wake.mock.calls.length).toBe(woken)
  })
})
