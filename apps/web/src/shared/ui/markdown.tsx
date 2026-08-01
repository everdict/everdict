import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

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

// hast className 은 string | number | (string|number)[] 이라 문자열 목록으로 정규화해서 본다.
function classNames(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/)
  if (Array.isArray(value)) return value.filter((c): c is string => typeof c === 'string')
  return []
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
}: {
  content: string
  className?: string
  mermaid?: boolean
}) {
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

    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-link underline underline-offset-2"
      >
        {children}
      </a>
    ),
    img: ({ src, alt, title }) => {
      // 본문의 이미지는 임의 원격 URL 이라 next/image 의 도메인 화이트리스트를 통과할 수 없다 — 원본 태그로 그린다.
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={typeof src === 'string' ? src : undefined}
          alt={alt ?? ''}
          title={title}
          className="max-w-full rounded-md border border-border"
        />
      )
    },

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
  }

  return (
    <div className={cn('space-y-3 text-[13px] leading-relaxed', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // 순서가 곧 안전장치다 — raw 가 원문 HTML 을 트리로 만들고, sanitize 가 그 뒤에서 걸러낸다.
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
