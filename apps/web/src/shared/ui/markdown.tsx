import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Dependency-free lightweight markdown viewer — parses text into React elements (no dangerouslySetInnerHTML → XSS-safe).
// Supports: headings(#~######) · code fences(```) · blockquotes(>) · lists(-/*/+·1.) · horizontal rules · paragraphs (line breaks preserved) /
// inline: `code` · **bold** · *italic* · [text](url). Advanced syntax like tables·nested lists is surfaced as raw source.

// Inline parsing — by priority (code > bold > link > italic), substitute the earliest token first, handling nesting recursively.
function parseInline(text: string, key: string): ReactNode[] {
  const rules: { re: RegExp; make: (m: RegExpExecArray, k: string) => ReactNode }[] = [
    {
      re: /`([^`]+)`/,
      make: (m, k) => (
        <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {m[1]}
        </code>
      ),
    },
    {
      re: /\*\*([^*]+)\*\*/,
      make: (m, k) => (
        <strong key={k} className="font-[600] text-foreground">
          {parseInline(m[1], k)}
        </strong>
      ),
    },
    {
      re: /\[([^\]]+)\]\(([^)\s]+)\)/,
      make: (m, k) => (
        <a
          key={k}
          href={m[2]}
          target="_blank"
          rel="noreferrer"
          className="text-link underline underline-offset-2"
        >
          {m[1]}
        </a>
      ),
    },
    {
      re: /\*([^*\n]+)\*/,
      make: (m, k) => <em key={k}>{parseInline(m[1], k)}</em>,
    },
  ]

  const nodes: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest.length > 0) {
    let best: {
      idx: number
      m: RegExpExecArray
      make: (m: RegExpExecArray, k: string) => ReactNode
    } | null = null
    for (const r of rules) {
      const m = r.re.exec(rest)
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, m, make: r.make }
    }
    if (!best) {
      nodes.push(rest)
      break
    }
    if (best.idx > 0) nodes.push(rest.slice(0, best.idx))
    nodes.push(best.make(best.m, `${key}-${n++}`))
    rest = rest.slice(best.idx + best.m[0].length)
  }
  return nodes
}

const HEADING: Record<number, string> = {
  1: 'text-[16px] font-[600]',
  2: 'text-[15px] font-[600]',
  3: 'text-[14px] font-[560]',
  4: 'text-[13px] font-[560]',
  5: 'text-[13px] font-[560]',
  6: 'text-[13px] font-[560]',
}

function isBlockStart(l: string): boolean {
  return (
    /^```/.test(l.trim()) ||
    /^#{1,6}\s/.test(l) ||
    /^\s*[-*+]\s+/.test(l) ||
    /^\s*\d+\.\s+/.test(l) ||
    /^>\s?/.test(l) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l.trim())
  )
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line.trim())) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed text-foreground"
        >
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push(
        <p key={key++} className={cn('text-foreground', HEADING[h[1].length])}>
          {parseInline(h[2], `h${key}`)}
        </p>
      )
      i++
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push(<hr key={key++} className="border-border" />)
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={key++} className="border-l-2 border-border pl-3 text-muted-foreground">
          {parseInline(buf.join(' '), `q${key}`)}
        </blockquote>
      )
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="list-disc space-y-1 pl-5 text-muted-foreground">
          {items.map((it, j) => (
            <li key={j}>{parseInline(it, `ul${key}-${j}`)}</li>
          ))}
        </ul>
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++} className="list-decimal space-y-1 pl-5 text-muted-foreground">
          {items.map((it, j) => (
            <li key={j}>{parseInline(it, `ol${key}-${j}`)}</li>
          ))}
        </ol>
      )
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph — up to the next blank line/block start (line breaks within the paragraph are preserved).
    const buf: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i])
      i++
    }
    blocks.push(
      <p key={key++} className="whitespace-pre-wrap break-words text-muted-foreground">
        {parseInline(buf.join('\n'), `p${key}`)}
      </p>
    )
  }

  return <div className={cn('space-y-3 text-[13px] leading-relaxed', className)}>{blocks}</div>
}
