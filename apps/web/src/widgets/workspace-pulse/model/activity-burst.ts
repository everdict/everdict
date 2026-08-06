import type { PlatformEvent } from '@/entities/platform-event'

// One feed row — the newest event of a run of alike events, plus how many more it stands for.
export interface ActivityBurst {
  event: PlatformEvent
  more: number
}

// Who the fact is attributed to, for grouping. Events without an actor fall back to what caused them
// (an agent's `causedBy` stamp), and truly unattributed system facts share one bucket — a burst of
// schedule fires reads as one line the same way a member's burst does.
function burstKey(event: PlatformEvent): string {
  return `${event.actor ?? event.causedBy ?? 'system'}|${event.kind}`
}

// Collapse consecutive same-actor same-kind events into one row. The home feed shows the newest N
// facts — but an agent publishing thirteen files in one turn IS one act, and left uncollapsed it
// monopolizes the whole feed and hides every other member's activity behind it. Only consecutive
// runs collapse: interleaved actors stay separate lines, so the feed never re-orders time.
export function collapseActivityBursts(events: readonly PlatformEvent[]): ActivityBurst[] {
  const bursts: ActivityBurst[] = []
  for (const event of events) {
    const last = bursts[bursts.length - 1]
    if (last !== undefined && burstKey(last.event) === burstKey(event)) {
      last.more += 1
      continue
    }
    bursts.push({ event, more: 0 })
  }
  return bursts
}
