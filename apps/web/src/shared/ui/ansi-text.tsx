'use client'

import { useMemo, type CSSProperties } from 'react'

import { parseAnsi, type AnsiStyle } from '@/shared/lib/ansi'

// raw 프로세스 출력을 그대로 그리는 원자 — 컨테이너 로그·셸 출력·파일 실행 결과처럼 "터미널이 뱉은 것"을
// 화면에 옮기는 자리는 전부 이걸 거친다. 컨테이너(<pre>/<div>·스크롤·높이 제한)는 호출부가 계속 소유하고
// 여기서는 본문만 책임진다: ANSI 제어 시퀀스를 걷어 내 상자 글리프를 없애고, 색·강조는 살려서 그린다.
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

// dim 은 별도 색 대신 불투명도로 — 팔레트를 한 벌만 유지하면서도 로그가 흐린 부분을 그대로 흐리게 만든다.
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
