// How much of a posted update rides along on its fact. A project update and an initiative update both emit
// one, and every downstream reader of that fact — the bell row, the chat post — needs the SENTENCE to be worth
// anything: none of them can re-read the timeline from an event. Long enough to carry the point, short enough
// that the event log never becomes a copy of the timeline; the full body stays the record.
export const TRACKER_UPDATE_EXCERPT_LIMIT = 240;

export function excerptOf(body: string): string {
  const flat = body.trim().replace(/\s+/g, " ");
  return flat.length <= TRACKER_UPDATE_EXCERPT_LIMIT
    ? flat
    : `${flat.slice(0, TRACKER_UPDATE_EXCERPT_LIMIT - 1).trimEnd()}…`;
}
