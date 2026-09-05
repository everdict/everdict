import type { ComponentProps } from 'react'
import NextLink from 'next/link'

// The only link in this app. `next/link` is not used directly because of ONE default — **prefetch is off**.
//
// Every route in this app is `force-dynamic`, so what a prefetch actually fetches is the shared layout shell down to the loading boundary
// (the real data arrives on click anyway). The screen being drawn right now already holds that shell, so there is almost nothing to gain.
// The cost, meanwhile, is large: every link on screen re-prefetches at once whenever the router cache is invalidated (four at a time, with a
// 300ms cooldown per invalidation), and an in-flight mutation's `useTransition` is bound behind that queue, locking the control in a spinner.
// One mutation is effectively slowed by the number of links on screen, which is how assigning a project on an issue detail took 4–13 seconds
// (while the server side had finished in 150ms).
// Navigation itself is carried by the loading boundary — 36ms from click to URL and 335ms to the body, so there is no felt difference.
//
// So the default stays off, and only a link with something genuinely worth fetching ahead turns `prefetch` on explicitly.
// The details are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export function Link({ prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />
}
