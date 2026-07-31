import type { TrackerHistoryEntry, TrackerHistoryEvent } from "@everdict/contracts";
import { TRACKER_HISTORY_LIMIT } from "@everdict/contracts";

// The tracker's durable history lives ON the record (the platform-event log is swept, so it can never answer
// "why did this regress last quarter"). Every transition appends here, and the tail is capped so a chatty sync
// cannot grow a row without bound — the oldest entries fall off first, newest last.
export function appendHistory(
  history: readonly TrackerHistoryEntry[],
  entry: { at: string; by: string; event: TrackerHistoryEvent; detail?: Record<string, unknown> },
): TrackerHistoryEntry[] {
  const next: TrackerHistoryEntry[] = [
    ...history,
    {
      at: entry.at,
      by: entry.by,
      event: entry.event,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    },
  ];
  return next.length > TRACKER_HISTORY_LIMIT ? next.slice(next.length - TRACKER_HISTORY_LIMIT) : next;
}
