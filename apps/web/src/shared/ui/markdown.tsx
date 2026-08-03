import type { ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import { mediaKindForUrl, type MediaKind } from '@/shared/lib/media'
import { cn } from '@/shared/lib/utils'
import { MermaidDiagram } from '@/shared/ui/mermaid'

// GitHub 마크다운(GFM) 뷰어 — remark-gfm 위에서 CommonMark + GFM 확장(표·체크리스트·취소선·autolink·각주)을
// 모두 커버한다. 손으로 쓴 정규식 파서가 중첩 리스트·체크박스·autolink 를 흘리던 자리를 스펙 파서로 교체했다.
// 인라인 HTML 도 CommonMark 의 일부다(`<br>`·`<details>`·`<sub>` 는 GitHub 이슈 본문의 일상 표현) — rehype-raw
// 로 파싱하되 rehype-sanitize 의 기본 스키마(= GitHub 의 새니타이즈 규칙)를 반드시 뒤에 세운다: script·on*
// 핸들러·javascript: 링크·작성자가 넣은 style 은 전부 제거되고, GFM 이 만든 표 정렬과 체크박스 상태만 남는다.
// 이 경로에는 dangerouslySetInnerHTML 이 없다 — 새니타이즈된 트리를 React 엘리먼트로 그린다.
// 마크업은 여기서만 만들고 색/타이포는 전부 앱 토큰 — 컴포넌트 매핑을 거치지 않는 태그는 나오지 않는다.
// Opt-in `mermaid`: ```mermaid 펜스를 다이어그램으로 렌더(shared/ui/mermaid, 파싱 실패 시 원문 코드 블록).
// 기본 off — 스트리밍 표면(agent chat)은 청크마다 재파싱하므로 호출자가 선택한다.

const HEADING: Record<number, string> = {
  1: 'text-[16px] font-[600]',
  2: 'text-[15px] font-[600]',
  3: 'text-[14px] font-[560]',
  4: 'text-[13px] font-[560]',
  5: 'text-[13px] font-[560]',
  6: 'text-[13px] font-[560]',
}

// 본문 이미지 중 "브라우저가 직접 받아올 수 없는 것"을 우리 라우트로 우회시키는 명세. 비공개 리포나 GitHub
// Enterprise 의 첨부는 리포와 똑같은 인증 뒤에 있는데 이 화면을 보는 브라우저에는 그쪽 세션이 없다 — 그래서
// 서버가 대신 받아온다. 콜백이 아니라 값인 이유: 서버 컴포넌트(이슈 설명)와 클라이언트 섬(GitHub 코멘트 패널)이
// 같은 규칙을 각자 만들어 넘기는데, 직렬화되는 값이면 어느 쪽에서 만들었는지 이 뷰어가 알 필요가 없다.
export interface MarkdownImageProxy {
  // 프록시를 태울 오리진 목록. `new URL(...).origin` 과 같은 표기여야 한다(소문자 호스트, 기본 포트 생략).
  origins: string[]
  // 최종 src = `${path}?url=<encodeURIComponent(원본)>`
  path: string
}

// 목록에 없는 오리진·상대경로·data: 는 원본 그대로 둔다 — 공개 이미지까지 서버를 거치게 만들 이유가 없다.
function proxiedSrc(src: string | undefined, proxy?: MarkdownImageProxy): string | undefined {
  if (src === undefined || proxy === undefined) return src
  let origin: string
  try {
    origin = new URL(src).origin
  } catch {
    return src
  }
  if (!proxy.origins.includes(origin)) return src
  return `${proxy.path}?url=${encodeURIComponent(src)}`
}

// 새니타이즈 기본 스키마(= GitHub 규칙)에는 video·audio 가 없다 — 그대로 두면 이슈 본문에 붙은 화면 녹화가
// 태그째 사라져 "첨부한 적 없는 이슈"처럼 보인다. 그래서 재생 태그만 딱 열어 준다.
//
// 여는 폭은 최소한이다. `autoPlay` 는 넣지 않았다(본문을 열자마자 소리가 나는 건 글쓴이가 정할 일이 아니다),
// `style`·`on*` 은 기본 스키마가 이미 막고, src 는 기본 스키마의 프로토콜 제한(http/https)을 그대로 물려받는다.
// 속성 이름이 hast 프로퍼티 표기(`playsInline`)인 것도 기본 스키마와 같은 규칙이다.
const MEDIA_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'video', 'audio', 'source'],
  attributes: {
    ...defaultSchema.attributes,
    video: [
      'src',
      'poster',
      'controls',
      'loop',
      'muted',
      'playsInline',
      'preload',
      'width',
      'height',
    ],
    audio: ['src', 'controls', 'loop', 'preload'],
    source: ['src', 'type'],
  },
}

// hast className 은 string | number | (string|number)[] 이라 문자열 목록으로 정규화해서 본다.
function classNames(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/)
  if (Array.isArray(value)) return value.filter((c): c is string => typeof c === 'string')
  return []
}

// Opt-in `mentions`: the names a body may address (a comment thread passes the workspace's members + the agent).
// The pass runs AFTER sanitize on purpose — it ADDS markup, so it must never hand rehype-sanitize something to
// interpret, and sanitize has already dropped the class a body would need to forge a mention chip by writing the
// span itself. It only ever rewrites text nodes, and never inside a link, code or a fenced block.
const MENTION_CLASS = 'everdict-mention'
const MENTION_SKIP = new Set(['a', 'code', 'pre'])

// The hast tree as this pass needs it. Kept structural (not imported from `hast`) so the viewer stays free of a
// type-only dependency it does not otherwise carry; `children` is optional so a plugin transformer still accepts
// the bare unist node unified types it with.
type MentionText = { type: 'text'; value: string }
type MentionElement = {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: MentionNode[]
}
type MentionNode = MentionText | MentionElement | { type: string }

function isMentionElement(node: MentionNode): node is MentionElement {
  return node.type === 'element'
}
function isMentionText(node: MentionNode): node is MentionText {
  return node.type === 'text'
}

// Longest name first, so `@Ada Lovelace` never matches as `@Ada` with a trailing surname.
function mentionPattern(names: string[]): RegExp | undefined {
  const unique = [...new Set(names.filter((n) => n.trim() !== ''))].sort(
    (a, b) => b.length - a.length
  )
  if (unique.length === 0) return undefined
  return new RegExp(
    `@(?:${unique.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'g'
  )
}

function splitMentions(nodes: MentionNode[], re: RegExp): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node === undefined) continue
    if (isMentionElement(node)) {
      if (!MENTION_SKIP.has(node.tagName) && node.children) splitMentions(node.children, re)
      continue
    }
    if (!isMentionText(node)) continue
    const parts: MentionNode[] = []
    let last = 0
    re.lastIndex = 0
    let m: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-iteration pattern
    while ((m = re.exec(node.value)) !== null) {
      if (m.index > last) parts.push({ type: 'text', value: node.value.slice(last, m.index) })
      parts.push({
        type: 'element',
        tagName: 'span',
        properties: { className: [MENTION_CLASS] },
        children: [{ type: 'text', value: m[0] }],
      })
      last = m.index + m[0].length
    }
    if (parts.length === 0) continue
    if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) })
    nodes.splice(i, 1, ...parts)
    i += parts.length - 1
  }
}

function rehypeMentions(re: RegExp) {
  return () => (tree: { children?: MentionNode[] }) => {
    if (tree.children) splitMentions(tree.children, re)
  }
}

// 본문 안의 재생기. 폭은 본문을 넘지 않고 높이는 화면을 삼키지 않게 잡는다 — 세로로 긴 화면 녹화 하나가
// 나머지 본문을 다음 스크롤로 밀어내지 않도록. preload="metadata" 는 여러 개가 실린 본문에서 바이트를 아낀다.
function MediaPlayer({
  kind,
  src,
  poster,
  title,
  children,
}: {
  kind: Exclude<MediaKind, 'image'>
  src: string | undefined
  poster?: string | undefined
  title?: string | undefined
  children?: ReactNode
}) {
  if (kind === 'audio') {
    return (
      <audio controls preload="metadata" src={src} title={title} className="w-full max-w-md">
        {children}
      </audio>
    )
  }
  return (
    <video
      controls
      playsInline
      preload="metadata"
      src={src}
      poster={poster}
      title={title}
      className="max-h-[70vh] w-full rounded-md border border-border bg-black"
    >
      {children}
    </video>
  )
}

// 자동링크(주소가 곧 문구인 링크)인지. 글쓴이가 따로 붙인 문구가 있으면 재생기로 바꾸지 않는다 — 그건 그 문구를
// 지운다는 뜻이 되기 때문이다. GitHub 도 같은 규칙으로 첨부 주소만 재생기로 바꾼다.
function isBareLink(children: ReactNode, href: string): boolean {
  if (typeof children === 'string') return children === href
  if (Array.isArray(children) && children.length === 1) return children[0] === href
  return false
}

function heading(level: number): NonNullable<Components['h1']> {
  return ({ children }) => {
    const Tag = `h${level}` as 'h1'
    return <Tag className={cn('text-foreground', HEADING[level])}>{children}</Tag>
  }
}

export function Markdown({
  content,
  className,
  mermaid = false,
  imageProxy,
  mentions,
}: {
  content: string
  className?: string
  mermaid?: boolean
  imageProxy?: MarkdownImageProxy
  mentions?: string[]
}) {
  const mentionRe = mentions ? mentionPattern(mentions) : undefined
  const components: Components = {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),

    // 문단 안의 개행은 보존한다(GitHub 코멘트와 동일한 체감) — softbreak 이 텍스트의 "\n" 으로 남으므로
    // whitespace-pre-wrap 이 그대로 줄바꿈으로 보이게 한다.
    p: ({ children }) => (
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{children}</p>
    ),

    ul: ({ children }) => (
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground [&_ul]:mt-1 [&_ul]:list-[circle]">
        {children}
      </ul>
    ),
    ol: ({ children, start }) => (
      <ol start={start} className="list-decimal space-y-1 pl-5 text-muted-foreground [&_ol]:mt-1">
        {children}
      </ol>
    ),
    // 체크리스트 항목(remark-gfm 의 task-list-item)은 불릿 대신 체크박스가 마커다.
    li: ({ children, className: liClass }) => (
      <li className={classNames(liClass).includes('task-list-item') ? 'list-none' : undefined}>
        {children}
      </li>
    ),
    input: ({ type, checked }) =>
      type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={checked === true}
          disabled
          readOnly
          className="mr-1.5 size-3 translate-y-[1px] accent-primary"
        />
      ) : null,

    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="border-border" />,

    a: ({ href, children }) => {
      // 첨부 주소가 그대로 적힌 줄은 링크가 아니라 매체다 — 가져온 이슈 본문의 화면 녹화가 이 모양으로 온다.
      const kind = mediaKindForUrl(href)
      if (
        (kind === 'video' || kind === 'audio') &&
        href !== undefined &&
        isBareLink(children, href)
      )
        return <MediaPlayer kind={kind} src={proxiedSrc(href, imageProxy)} />
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-link underline underline-offset-2"
        >
          {children}
        </a>
      )
    },
    img: ({ src, alt, title }) => {
      const raw = typeof src === 'string' ? src : undefined
      // `![](clip.mp4)` — 이미지 문법으로 붙은 영상. GitHub 이 그렇게 그리므로 여기서도 재생기로 그린다.
      const kind = mediaKindForUrl(raw)
      if (kind === 'video' || kind === 'audio')
        return <MediaPlayer kind={kind} src={proxiedSrc(raw, imageProxy)} title={title} />
      // 본문의 이미지는 임의 원격 URL 이라 next/image 의 도메인 화이트리스트를 통과할 수 없다 — 원본 태그로 그린다.
      // imageProxy 가 지정한 오리진만 우리 라우트로 우회한다(인증이 필요한 첨부).
      // data-media-preview 는 확대 뷰어(shared/ui/media-lightbox)가 잡을 표식이다 — 뷰어 안에 없으면 아무 일도
      // 하지 않는 속성이라, 이 뷰어는 확대가 켜졌는지 알 필요가 없다.
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-media-preview=""
          src={proxiedSrc(raw, imageProxy)}
          alt={alt ?? ''}
          title={title}
          className="max-w-full rounded-md border border-border"
        />
      )
    },
    // 인라인 HTML 로 온 재생 태그(`<video src=… controls>`) — 새니타이즈 스키마에서 열어 준 만큼만 지나온다.
    video: ({ src, poster, title, children }) => (
      <MediaPlayer
        kind="video"
        src={proxiedSrc(typeof src === 'string' ? src : undefined, imageProxy)}
        poster={proxiedSrc(typeof poster === 'string' ? poster : undefined, imageProxy)}
        title={title}
      >
        {children}
      </MediaPlayer>
    ),
    audio: ({ src, title, children }) => (
      <MediaPlayer
        kind="audio"
        src={proxiedSrc(typeof src === 'string' ? src : undefined, imageProxy)}
        title={title}
      >
        {children}
      </MediaPlayer>
    ),
    source: ({ src, type }) => (
      <source src={proxiedSrc(typeof src === 'string' ? src : undefined, imageProxy)} type={type} />
    ),

    strong: ({ children }) => <strong className="font-[600] text-foreground">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    del: ({ children }) => <del className="text-faint line-through">{children}</del>,

    // 블록 코드는 pre 에서 원문을 직접 꺼내 그린다 — 그래서 아래 code 매핑은 인라인 코드만 담당한다.
    pre: ({ node }) => {
      const fence = node?.children.find((c) => c.type === 'element')
      const text =
        fence?.type === 'element'
          ? fence.children.map((c) => (c.type === 'text' ? c.value : '')).join('')
          : ''
      const lang =
        classNames(fence?.type === 'element' ? fence.properties.className : undefined)
          .find((c) => c.startsWith('language-'))
          ?.slice('language-'.length)
          .toLowerCase() ?? ''
      if (mermaid && lang === 'mermaid') return <MermaidDiagram chart={text} />
      return (
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed text-foreground">
          <code>{text}</code>
        </pre>
      )
    },
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    ),

    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-[12.5px]">{children}</table>
      </div>
    ),
    th: ({ children, style }) => (
      <th
        style={style}
        className="border border-border bg-muted/40 px-2.5 py-1.5 text-left font-[560] text-foreground"
      >
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td
        style={style}
        className="border border-border px-2.5 py-1.5 text-left align-top text-muted-foreground"
      >
        {children}
      </td>
    ),

    // 각주 — 본문 위첨자 링크 + 문서 끝 각주 절.
    sup: ({ children }) => <sup className="text-[0.7em]">{children}</sup>,
    section: ({ children, className: sectionClass }) => (
      <section
        className={
          classNames(sectionClass).includes('footnotes')
            ? 'border-t border-border pt-3 text-[12px] text-muted-foreground'
            : undefined
        }
      >
        {children}
      </section>
    ),

    // 인라인 HTML 로만 오는 접힘 블록 — 이슈 본문의 로그·스택트레이스가 여기 들어온다.
    details: ({ children }) => (
      <details className="rounded-md border border-border px-3 py-2 text-muted-foreground [&[open]>summary]:mb-2">
        {children}
      </details>
    ),
    summary: ({ children }) => (
      <summary className="cursor-pointer font-[560] text-foreground">{children}</summary>
    ),
    kbd: ({ children }) => (
      <kbd className="rounded border border-border bg-muted px-1 font-mono text-[0.85em]">
        {children}
      </kbd>
    ),
    // Only the mention pass produces a classed span — sanitize strips a body's own class, so this cannot be forged.
    span: ({ children, className: spanClass }) =>
      classNames(spanClass).includes(MENTION_CLASS) ? (
        <span className="rounded bg-primary/12 px-1 font-[560] text-primary">{children}</span>
      ) : (
        <span>{children}</span>
      ),
  }

  return (
    <div className={cn('space-y-3 text-[13px] leading-relaxed', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // 순서가 곧 안전장치다 — raw 가 원문 HTML 을 트리로 만들고, sanitize 가 그 뒤에서 걸러낸다.
        // (mention highlighting comes last: it emits markup, so it must run on the already-sanitized tree.)
        rehypePlugins={
          mentionRe
            ? [rehypeRaw, [rehypeSanitize, MEDIA_SANITIZE_SCHEMA], rehypeMentions(mentionRe)]
            : [rehypeRaw, [rehypeSanitize, MEDIA_SANITIZE_SCHEMA]]
        }
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
