import type { ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import { mediaKindForUrl, type MediaKind } from '@/shared/lib/media'
import { cn } from '@/shared/lib/utils'
import { MermaidDiagram } from '@/shared/ui/mermaid'

// The GitHub markdown (GFM) viewer — CommonMark plus the GFM extensions (tables, task lists, strikethrough, autolinks, footnotes)
// on top of remark-gfm. A spec parser replaced the hand-written regex parser that leaked nested lists, checkboxes and autolinks.
// Inline HTML is part of CommonMark too (`<br>`, `<details>` and `<sub>` are everyday shapes in a GitHub issue body) — parsed with
// rehype-raw, but rehype-sanitize's DEFAULT schema (= GitHub's own sanitization rules) must stand behind it: script, on* handlers,
// javascript: links and author-supplied style are all removed, and only GFM's table alignment and checkbox state survive.
// There is no dangerouslySetInnerHTML on this path — the SANITIZED tree is drawn as React elements.
// Markup is produced only here and colour/typography come entirely from the app tokens — a tag that does not go through the component mapping does not appear.
// Opt-in `mermaid`: a ```mermaid fence renders as a diagram (shared/ui/mermaid; the raw code block on a parse failure).
// Off by default — a streaming surface (agent chat) re-parses on every chunk, so the caller chooses.

const HEADING: Record<number, string> = {
  1: 'text-[16px] font-[600]',
  2: 'text-[15px] font-[600]',
  3: 'text-[14px] font-[560]',
  4: 'text-[13px] font-[560]',
  5: 'text-[13px] font-[560]',
  6: 'text-[13px] font-[560]',
}

// The spec for routing body images "the browser cannot fetch itself" through our own route. An attachment on a private repo or on
// GitHub Enterprise sits behind the same auth as the repo, and the browser viewing this screen has no such session — so the server
// fetches it instead. A VALUE rather than a callback because a server component (the issue description) and a client island (the
// GitHub comment panel) each build the same rule and pass it in; serialized as a value, this viewer need not know which side built it.
export interface MarkdownImageProxy {
  // The origins to route through the proxy. Spelled exactly as `new URL(...).origin` does (lower-cased host, default port omitted).
  origins: string[]
  // Final src = `${path}?url=<encodeURIComponent(original)>`
  path: string
}

// An origin not on the list, a relative path and a data: URL are left alone — there is no reason to send a PUBLIC image through the server.
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

// The sanitize default schema (= GitHub's rules) has no video or audio — left as is, a screen recording attached to an issue body loses
// its tag entirely and the issue reads as though nothing was attached. So exactly the playback tags are opened up.
//
// It is opened as narrowly as possible. `autoPlay` is NOT included (sound the moment a body is opened is not the author's call to make),
// `style` and `on*` are already blocked by the default schema, and src inherits the default schema's protocol restriction (http/https).
// The attribute names being hast property spellings (`playsInline`) follows the same rule as the default schema.
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

// A hast className is string | number | (string|number)[], so it is normalized to a list of strings before it is read.
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

// The player inside a body. Its width does not exceed the body and its height does not swallow the screen — so that one tall screen
// recording does not push the rest of the body into the next scroll. preload="metadata" saves bytes in a body carrying several.
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

// Is it an autolink (a link whose text IS its address)? An author-supplied text is never swapped for a player — that would mean DELETING
// that text. GitHub converts only bare attachment addresses into players by the same rule.
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

    // Newlines inside a paragraph are preserved (the same feel as a GitHub comment) — a softbreak stays as a "\n" in the text, so
    // whitespace-pre-wrap renders it as the line break it is.
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
    // A task-list item (remark-gfm's task-list-item) has a CHECKBOX as its marker rather than a bullet.
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
      // A line that is just an attachment address is MEDIA rather than a link — an imported issue body's screen recording arrives in this shape.
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
      // `![](clip.mp4)` — a video attached with image syntax. GitHub draws it that way, so it is drawn as a player here too.
      const kind = mediaKindForUrl(raw)
      if (kind === 'video' || kind === 'audio')
        return <MediaPlayer kind={kind} src={proxiedSrc(raw, imageProxy)} title={title} />
      // A body image is an arbitrary remote URL and cannot pass next/image's domain allowlist — it is drawn as the raw tag.
      // Only the origins imageProxy names are routed through our own route (attachments that need auth).
      // data-media-preview is the marker the zoom viewer (shared/ui/media-lightbox) looks for — outside a viewer it is an attribute that
      // does nothing, so this viewer need not know whether zoom is enabled.
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
    // A playback tag that arrived as inline HTML (`<video src=… controls>`) — only as much of it gets through as the sanitize schema opened.
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

    // A block code fence takes its source directly from the `pre`, which is why the `code` mapping below handles inline code only.
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

    // Footnotes — the superscript link in the body plus the footnote section at the end of the document.
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

    // A collapsible block, which only ever arrives as inline HTML — an issue body's logs and stack traces land here.
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
        // The ORDER is the safety mechanism — raw turns the source HTML into a tree, and sanitize filters it afterwards.
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
