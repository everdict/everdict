import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Markdown } from './markdown'

// An issue body arrives written for GitHub, so the viewer has to be a GFM viewer — the hand-rolled parser it
// replaced silently dropped exactly the constructs a real issue is made of (nested lists, checklists,
// strikethrough, bare links), and every one of them looked like plain prose instead of failing loudly.

const html = (content: string) => renderToStaticMarkup(<Markdown content={content} />)

describe('markdown viewer (GFM)', () => {
  it('nests a sub-list inside its parent item instead of flattening it', () => {
    const out = html('- parent\n  - child')

    // The child list lives INSIDE the parent item — the flat parser emitted two sibling items instead.
    expect(out).toMatch(/<li>parent\s*<ul[^>]*>\s*<li>child<\/li>\s*<\/ul>\s*<\/li>/)
  })

  it('renders a task list as checkboxes, checked ones checked', () => {
    const out = html('- [x] done\n- [ ] todo')

    expect(out.match(/type="checkbox"/g)).toHaveLength(2)
    expect(out).toContain('checked=""')
    expect(out).toContain('list-none')
  })

  it('renders strikethrough, a GFM-only inline', () => {
    expect(html('~~gone~~')).toContain('<del')
  })

  it('autolinks a bare URL, as GitHub does', () => {
    expect(html('see https://example.com now')).toContain('href="https://example.com"')
  })

  it('renders a GFM table with its header row', () => {
    const out = html('| a | b |\n| --- | --- |\n| 1 | 2 |')

    expect(out).toContain('<th')
    expect(out).toContain('<td')
  })

  it('renders a fenced code block verbatim, without treating its contents as markdown', () => {
    const out = html('```ts\nconst a = **1**\n```')

    expect(out).toContain('<pre')
    expect(out).toContain('const a = **1**')
    expect(out).not.toContain('<strong')
  })

  it('renders an image and a heading as their own elements', () => {
    const out = html('## title\n\n![alt](https://example.com/a.png)')

    expect(out).toContain('<h2')
    expect(out).toContain('<img src="https://example.com/a.png" alt="alt"')
  })

  // An attachment on GitHub Enterprise (or any private repo) sits behind the same authentication the repo does,
  // and this browser holds no session for that host — so those images, and only those, go through our own route.
  it('routes images from the proxied origins through our path and leaves every other image alone', () => {
    const proxy = { origins: ['https://ghe.example.net'], path: '/api/issues/iss-1/attachment' }
    const out = renderToStaticMarkup(
      <Markdown
        imageProxy={proxy}
        content={
          '![shot](https://ghe.example.net/user-attachments/assets/a-1)\n\n' +
          '![public](https://example.com/a.png)\n\n' +
          '![relative](/uploads/a.png)'
        }
      />
    )

    expect(out).toContain(
      'src="/api/issues/iss-1/attachment?url=https%3A%2F%2Fghe.example.net%2Fuser-attachments%2Fassets%2Fa-1"'
    )
    expect(out).toContain('src="https://example.com/a.png"')
    expect(out).toContain('src="/uploads/a.png"')
  })

  it('renders the HTML subset a GitHub body actually uses', () => {
    const out = html('one<br>two\n\n<details><summary>logs</summary>\n\nbody\n\n</details>')

    expect(out).toContain('<br/>')
    expect(out).toContain('<details')
    expect(out).toContain('<summary')
    expect(out).toContain('body')
  })

  it('strips script and event handlers from that HTML — a description is untrusted input', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">')

    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('onerror')
  })

  it('strips author-supplied style, so a body cannot lay itself over the page', () => {
    const out = html('<p style="position:fixed;inset:0;background:red">overlay</p>')

    expect(out).toContain('overlay')
    expect(out).not.toContain('position:fixed')
  })

  it('neutralises a javascript: link target', () => {
    expect(html('[click](javascript:alert(1))')).not.toContain('href="javascript:')
    expect(html('<a href="javascript:alert(1)">click</a>')).not.toContain('href="javascript:')
  })
})

// A comment body is markdown too, and the thread it lives in addresses people — so the same viewer has to keep
// the @mention chip the plain-text renderer used to draw, without letting a body forge one.
const mentioned = (content: string, names: string[]) =>
  renderToStaticMarkup(<Markdown content={content} mentions={names} />)

const CHIP = 'bg-primary/12'

describe('markdown viewer (mentions)', () => {
  it('highlights a known name, even next to other inline markdown', () => {
    const out = mentioned('hey @Dana **look**', ['Dana'])

    expect(out).toContain(CHIP)
    expect(out).toContain('@Dana')
    expect(out).toContain('<strong')
  })

  it('prefers the longest matching name, so a surname is not left dangling', () => {
    const out = mentioned('@Ada Lovelace shipped it', ['Ada', 'Ada Lovelace'])

    expect(out).toContain('@Ada Lovelace</span>')
  })

  it('leaves an unknown name alone', () => {
    expect(mentioned('@nobody', ['Dana'])).not.toContain(CHIP)
  })

  it('does not rewrite a mention inside code or a link', () => {
    expect(mentioned('`@Dana`', ['Dana'])).not.toContain(CHIP)
    expect(mentioned('```\n@Dana\n```', ['Dana'])).not.toContain(CHIP)
    expect(mentioned('[@Dana](https://example.com)', ['Dana'])).not.toContain(CHIP)
  })

  it('cannot be forged by a body that writes the mention markup itself', () => {
    const out = mentioned('<span class="everdict-mention">@nobody</span>', ['Dana'])

    expect(out).toContain('@nobody')
    expect(out).not.toContain(CHIP)
  })
})
