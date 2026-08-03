import { describe, expect, it } from 'vitest'

import { popoverPosition, triggerBoxOf } from './dropdown-menu'

// A dropdown wrapper is a block box, so it stretches to the cell that holds it — an issue's status control
// sits in a property row whose value column is far wider than the little status button. Measuring the
// WRAPPER put the menu at that column's right edge instead of under the button (and once the sidebar folds
// to one column, at the right edge of the page), so these lock the anchor to the trigger itself.

const VIEWPORT = { width: 1440, height: 900 }

// An 85px-wide status button, left-aligned inside a 700px-wide property-row cell.
const TRIGGER = { top: 200, bottom: 224, left: 900, right: 985 }
const WRAPPER = { top: 200, bottom: 224, left: 900, right: 1600 }

describe('dropdown menu geometry', () => {
  it('measures the trigger inside the wrapper, not the wrapper the layout stretched', () => {
    const measured = triggerBoxOf({
      getBoundingClientRect: () => WRAPPER,
      firstElementChild: { getBoundingClientRect: () => TRIGGER },
    })

    expect(measured).toEqual(TRIGGER)
  })

  it('falls back to the wrapper when it holds no element (nothing to anchor on)', () => {
    const measured = triggerBoxOf({
      getBoundingClientRect: () => WRAPPER,
      firstElementChild: null,
    })

    expect(measured).toEqual(WRAPPER)
  })

  it("pins an end-aligned menu to the trigger's right edge, not the cell's", () => {
    const style = popoverPosition(TRIGGER, { side: 'bottom', align: 'end', viewport: VIEWPORT })

    expect(style.right).toBe(VIEWPORT.width - TRIGGER.right)
    expect(style.top).toBe(TRIGGER.bottom + 6)
  })

  it('opens a top-side menu above the trigger, start-aligned to its left edge', () => {
    const style = popoverPosition(TRIGGER, { side: 'top', align: 'start', viewport: VIEWPORT })

    expect(style.bottom).toBe(VIEWPORT.height - TRIGGER.top + 6)
    expect(style.left).toBe(TRIGGER.left)
  })
})
