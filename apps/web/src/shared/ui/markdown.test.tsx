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
    expect(out).toContain('<img')
    expect(out).toContain('src="https://example.com/a.png"')
    expect(out).toContain('alt="alt"')
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

// 이슈 본문에는 화면 녹화가 붙는다 — 그런데 새니타이즈 기본 스키마(= GitHub 규칙)에는 video/audio 가 없어서,
// 열어 주기 전까지 그 태그는 통째로 사라졌다("첨부한 적 없는 이슈"처럼 보인다).
describe('markdown viewer (media)', () => {
  it('renders an inline video tag instead of dropping it', () => {
    const out = html('<video src="https://x.test/clip.mp4" controls></video>')

    expect(out).toContain('<video')
    expect(out).toContain('src="https://x.test/clip.mp4"')
    expect(out).toContain('controls=""')
  })

  it('renders sources inside a video', () => {
    const out = html(
      '<video controls><source src="https://x.test/a.webm" type="video/webm"></video>'
    )

    expect(out).toContain('<source')
    expect(out).toContain('type="video/webm"')
  })

  // 본문을 열자마자 소리가 나는 건 글쓴이가 정할 일이 아니다 — 스키마에서 뺐으므로 새니타이즈가 지운다.
  it('strips autoplay from a body-supplied player', () => {
    expect(html('<video src="https://x.test/a.mp4" controls autoplay></video>')).not.toContain(
      'autoplay'
    )
  })

  it('still strips a script and an event handler now that the schema is wider', () => {
    const out = html(
      '<video src="https://x.test/a.mp4" onerror="alert(1)"></video><script>x</script>'
    )

    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<script')
  })

  it('turns a bare recording address into a player, as GitHub does', () => {
    expect(html('https://x.test/clip.mp4')).toContain('<video')
  })

  // 글쓴이가 붙인 문구가 있는 링크는 링크로 남는다 — 재생기로 바꾸면 그 문구를 지우는 셈이 된다.
  it('leaves a titled link to a recording as a link', () => {
    const out = html('[watch the repro](https://x.test/clip.mp4)')

    expect(out).toContain('watch the repro')
    expect(out).not.toContain('<video')
  })

  it('renders an image-syntax recording as a player, and audio as an audio player', () => {
    expect(html('![repro](https://x.test/clip.webm)')).toContain('<video')
    expect(html('![note](https://x.test/note.mp3)')).toContain('<audio')
  })

  // 확대 뷰어가 잡을 표식. 뷰어 밖에서는 아무 일도 하지 않는 속성이라 이 뷰어는 확대 여부를 알 필요가 없다.
  it('marks an ordinary image for the lightbox', () => {
    const out = html('![shot](https://x.test/a.png)')

    expect(out).toContain('data-media-preview')
    expect(out).toContain('<img')
  })
})
