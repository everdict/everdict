import { describe, expect, it } from 'vitest'

import { rowOffsets, virtualWindowOf } from './virtual-window'

const ROW = 40
const uniform = (count: number) => rowOffsets(count, () => ROW)

describe('row offsets — the last entry IS the total height', () => {
  it('accumulates each row top and ends with the full height', () => {
    expect(uniform(3)).toEqual([0, 40, 80, 120])
  })

  it('handles mixed heights (group headers among rows)', () => {
    const offsets = rowOffsets(4, (index) => (index % 2 === 0 ? 34 : 40))
    expect(offsets).toEqual([0, 34, 74, 108, 148])
  })

  it('is a single zero for an empty list', () => {
    expect(uniform(0)).toEqual([0])
  })
})

describe('virtual window — what is drawn, and how tall the spacers standing in for the rest are', () => {
  it('covers the viewport plus the overscan on both sides', () => {
    // 500 rows of 40px, viewport 400px (10 rows), scrolled to row 25.
    const slice = virtualWindowOf(uniform(500), 25 * ROW, 400, 6)
    expect(slice.first).toBe(19)
    expect(slice.last).toBe(42)
    expect(slice.totalHeight).toBe(20_000)
  })

  it('keeps the drawn rows and the two spacers adding up to the full height', () => {
    const offsets = uniform(500)
    const slice = virtualWindowOf(offsets, 25 * ROW, 400, 6)
    const drawn = (offsets[slice.last] ?? 0) - (offsets[slice.first] ?? 0)
    expect(slice.top + drawn + slice.bottom).toBe(slice.totalHeight)
  })

  it('draws everything when the content is shorter than the viewport', () => {
    const slice = virtualWindowOf(uniform(4), 0, 900, 6)
    expect(slice).toEqual({ first: 0, last: 4, top: 0, bottom: 0, totalHeight: 160 })
  })

  it('draws nothing — and no spacers — for an empty list', () => {
    expect(virtualWindowOf(uniform(0), 0, 400, 6)).toEqual({
      first: 0,
      last: 0,
      top: 0,
      bottom: 0,
      totalHeight: 0,
    })
  })

  // Right after a filter shrinks the list the browser still holds the old scroll offset, and iOS
  // rubber-banding really does hand over a negative one. Unclamped, `first` runs past the last row and
  // `bottom` goes negative — the list draws nothing at all.
  it('clamps a scroll position the shrunken list can no longer reach', () => {
    const slice = virtualWindowOf(uniform(5), 10_000, 200, 0)
    expect(slice.last).toBe(5)
    expect(slice.bottom).toBe(0)
    expect(slice.top).toBe(0)
  })

  it('clamps a negative scroll position to the top', () => {
    const slice = virtualWindowOf(uniform(50), -120, 200, 0)
    expect(slice.first).toBe(0)
    expect(slice.top).toBe(0)
  })

  it('finds the right first row when rows have different heights', () => {
    // 34 · 40 · 34 · 40 … — a scroll of 74px sits exactly on the third row's top.
    const offsets = rowOffsets(10, (index) => (index % 2 === 0 ? 34 : 40))
    expect(virtualWindowOf(offsets, 74, 40, 0).first).toBe(2)
    expect(virtualWindowOf(offsets, 73, 40, 0).first).toBe(1)
  })
})
