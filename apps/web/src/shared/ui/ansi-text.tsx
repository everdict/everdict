'use client'

import { useMemo, type CSSProperties } from 'react'

import { parseAnsi, type AnsiStyle } from '@/shared/lib/ansi'

// The atom that draws raw process output as it is — every place that moves "what a terminal emitted" onto the screen (container logs, shell
// output, a file execution result) goes through it. The CONTAINER (<pre>/<div>, scrolling, height limits) stays the caller's and this is
// responsible only for the body: stripping the ANSI control sequences so no box glyphs remain, while keeping the colour and emphasis.
export function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text), [text])
  return (
    <>
      {spans.map((span, i) => (
        <span key={i} style={cssFor(span.style)}>
          {span.text}
        </span>
      ))}
    </>
  )
}

// `dim` uses OPACITY rather than a separate colour — keeping one palette while still making a log's faint parts faint.
function cssFor(style: AnsiStyle): CSSProperties {
  return {
    ...(style.fg !== undefined ? { color: style.fg } : {}),
    ...(style.bg !== undefined ? { backgroundColor: style.bg } : {}),
    ...(style.bold === true ? { fontWeight: 600 } : {}),
    ...(style.dim === true ? { opacity: 0.65 } : {}),
    ...(style.italic === true ? { fontStyle: 'italic' } : {}),
    ...(style.underline === true ? { textDecoration: 'underline' } : {}),
  }
}
