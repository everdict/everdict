import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LinkChip, LinkChipRow } from './chip'

// The attribute-column chip's WIDTH DISCIPLINE, which is the whole reason this shell exists. Both properties
// below were measured in headless Chrome against the real class chain before they were written down here:
//
//  · the row as `inline-flex`  → 380px wide inside a 188px column (it ran off the screen)
//  · the chip with `max-w-full` only → 474px of ellipsised title in an 816px row ("truncated and still too long")
//
// jsdom does not do layout, so these assert the two CSS facts the measurement blamed. Neither is cosmetic:
// an inline-flex row is shrink-to-fit, which makes the chip's percentage max-width circular (and therefore
// indefinite, and therefore not a clamp at all), and a percentage alone has nothing to say about a wide row.
describe('attribute chip', () => {
  it('lays the row out as a BLOCK-level flex, so a chip percentage has a definite width to resolve against', () => {
    const out = renderToStaticMarkup(<LinkChipRow>chip</LinkChipRow>)

    expect(out).toContain('class="flex flex-wrap items-center gap-1"')
    expect(out).not.toContain('inline-flex')
  })

  it('caps the chip by the column AND by a ceiling, so one long title cannot take the whole row', () => {
    const out = renderToStaticMarkup(
      <LinkChip href="/acme/issue/ENG-12" title="ENG-12 · a very long title">
        <span className="min-w-0 truncate">a very long title</span>
      </LinkChip>
    )

    expect(out).toContain('max-w-[min(100%,15rem)]')
  })

  it('carries the full text on the chip, because what it shows is a truncation of it', () => {
    const out = renderToStaticMarkup(
      <LinkChip href="/acme/issue/ENG-12" title="ENG-12 · a very long title">
        <span className="min-w-0 truncate">a very long title</span>
      </LinkChip>
    )

    expect(out).toContain('title="ENG-12 · a very long title"')
  })

  it('only makes room for the unlink control where there is one to make room for', () => {
    const readOnly = renderToStaticMarkup(
      <LinkChip href="/acme/issue/ENG-12" title="ENG-12">
        ENG-12
      </LinkChip>
    )
    const writable = renderToStaticMarkup(
      <LinkChip
        href="/acme/issue/ENG-12"
        title="ENG-12"
        trailing={<button type="button">x</button>}
      >
        ENG-12
      </LinkChip>
    )

    expect(readOnly).toContain('px-1.5')
    expect(writable).toContain('pr-1')
  })
})
