'use client'

import { useCallback, useReducer } from 'react'
import { useRouter } from 'next/navigation'

// The ONLY way to redraw the screen after a mutation. There are two reasons `router.refresh()` is not called directly.
//
// ① It has to be called outside the transition. A mutation almost always happens inside `startTransition(async () => { await action(); … })`,
//    and called in there the router refresh binds to our transition and the control stays trapped in a spinner.
// ② The commit does not happen by itself even once the new RSC arrives. Measured (issue detail, eight project assignments):
//    26·158·4691·9754·9757·14765·4754·235ms — with the network already done and the main thread idle throughout, and the commit arriving
//    only when **some unrelated update** happened once (a poller ticking, or the user pressing any button at all).
//    So the refresh time was effectively bound to the poller interval (~5s), and the same click landed instantly one time and 15 seconds later
//    the next. Waking the same eight artificially at the 300ms mark flattens them to 328·368·329·380·377·372·368·368ms.
//
// So two things happen here: `router.refresh()` is deferred by one timer tick so it is called outside the transition, and empty state changes
// are injected at the moments a response is likely to arrive, to wake the pending commit. The wakes are finite (four) and the render cost is
// the one component holding this hook. The details are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
