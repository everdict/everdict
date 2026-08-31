import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { VirtualList } from './virtual-list'

// The reason this component exists IS this test: on a scorecard of hundreds of cases the list must not draw
// ALL of them. A server render (no effects) shows exactly that property — how many rows stand on first paint.

const ROW = 40
const rows = Array.from({ length: 500 }, (_, index) => ({ id: `case-${index}` }))

const render = (maxHeight = '600px') =>
  renderToStaticMarkup(
    <VirtualList
      items={rows}
      keyOf={(row) => row.id}
      heightOf={() => ROW}
      maxHeight={maxHeight}
      className="scroller"
    >
      {(row) => <div className="row">{row.id}</div>}
    </VirtualList>
  )

const drawnIds = (html: string) => html.match(/case-\d+/g) ?? []
// React writes no unit for 0 (`height:0`), and one of the two spacers being 0 is the normal case — so both
// spellings are read.
const spacerHeights = (html: string) =>
  [...html.matchAll(/style="height:(\d+)(?:px)?"/g)].map((match) => Number(match[1]))

describe('virtual list — hundreds of rows, a screenful of DOM', () => {
  it('draws a window instead of every row', () => {
    const html = render()
    const ids = drawnIds(html)

    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(60)
    expect(ids).toContain('case-0')
    expect(ids).not.toContain('case-400')
  })

  it('stands spacers in for the rows it did not draw, so the scrollbar still spans the whole list', () => {
    const html = render()
    const [top, bottom] = spacerHeights(html)

    expect(top).toBe(0)
    expect((top ?? 0) + drawnIds(html).length * ROW + (bottom ?? 0)).toBe(rows.length * ROW)
  })

  it('carries the caller max-height onto the scroll area', () => {
    expect(render('70vh')).toContain('max-height:70vh')
  })

  it('draws nothing but two empty spacers for an empty list', () => {
    const html = renderToStaticMarkup(
      <VirtualList items={[]} keyOf={() => 'x'} heightOf={() => ROW} maxHeight="600px">
        {() => <div>row</div>}
      </VirtualList>
    )

    expect(drawnIds(html)).toHaveLength(0)
    expect(html).not.toContain('row')
  })
})
