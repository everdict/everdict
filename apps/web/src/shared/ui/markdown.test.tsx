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
