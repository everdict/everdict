// The pure half of the windowing arithmetic — which rows cross the scroll area right now, and how much empty
// space has to stand above and below them so the scrollbar behaves as if everything had been drawn. It lives
// outside React because being wrong here raises nothing at all: the screen simply shows the wrong rows.

export interface VirtualWindow {
  // The rows to draw, [first, last) — overscan included.
  first: number
  last: number
  // The heights of the spacers standing in for everything above and below that range.
  top: number
  bottom: number
  totalHeight: number
}

// Cumulative offsets — offsets[i] is row i's top, offsets[count] is the full height. The length being
// count + 1 is the point: the last entry IS the total, so nothing has to add it up a second time.
export function rowOffsets(count: number, heightOf: (index: number) => number): number[] {
  const offsets: number[] = new Array(count + 1)
  offsets[0] = 0
  for (let i = 0; i < count; i += 1) offsets[i + 1] = (offsets[i] ?? 0) + heightOf(i)
  return offsets
}

// The largest i with offsets[i] <= value — a binary search that runs twice per scrolled frame.
function indexAt(offsets: readonly number[], value: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((offsets[mid] ?? 0) <= value) low = mid
    else high = mid - 1
  }
  return low
}

export function virtualWindowOf(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): VirtualWindow {
  const count = Math.max(0, offsets.length - 1)
  const totalHeight = offsets[count] ?? 0
  if (count === 0) return { first: 0, last: 0, top: 0, bottom: 0, totalHeight }
  // The scroll position is clamped rather than trusted: right after a filter shrinks the list the browser
  // still holds the old offset, and a negative scrollTop really does arrive from iOS rubber-banding. Left
  // alone, `first` runs past the last row and `bottom` goes negative — the list draws nothing at all.
  const top = Math.min(Math.max(scrollTop, 0), Math.max(totalHeight - viewportHeight, 0))
  const first = Math.max(0, indexAt(offsets, top) - overscan)
  const last = Math.min(count, indexAt(offsets, top + Math.max(viewportHeight, 0)) + 1 + overscan)
  return {
    first,
    last,
    top: offsets[first] ?? 0,
    bottom: totalHeight - (offsets[last] ?? totalHeight),
    totalHeight,
  }
}
