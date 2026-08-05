'use client'

import { useEffect, useState } from 'react'

// mermaid.render 는 임시 DOM id 를 요구한다 — React useId 는 CSS 셀렉터 불가 문자가 섞이므로 전역 순번 사용.
let renderSeq = 0

// ```mermaid 펜스 소스를 SVG 다이어그램으로 렌더하는 뷰어. 라이브러리는 동적 import(별도 청크)라 다이어그램이
// 실제로 화면에 나올 때만 로드된다. 테마는 html.dark 를 관찰해 라이트/다크를 따라가고(토글 시 재렌더), 파싱
// 실패(문법 오류·작성 중 스트리밍)는 조용히 원문 코드 블록으로 폴백한다. SVG 주입은 dangerouslySetInnerHTML
// 이지만 mermaid 가 securityLevel 'strict'(기본)로 라벨을 새니타이즈한 자체 생성물이라 원문 HTML 이 아니다.
export function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)
  const [dark, setDark] = useState(false)

  // 부모 앱의 테마 권위는 html.dark 클래스 하나 — 그것만 관찰한다(자체 prefers-color-scheme 계산 금지).
  useEffect(() => {
    const el = document.documentElement
    const sync = () => setDark(el.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
        })
        // render 는 실패 시 임시 요소를 남길 수 있어 parse 로 먼저 검증(파싱만, DOM 부수효과 없음).
        await mermaid.parse(chart)
        const { svg: rendered } = await mermaid.render(`everdict-mermaid-${renderSeq++}`, chart)
        if (!cancelled) {
          setSvg(rendered)
          setFailed(false)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chart, dark])

  // 로딩 중/실패 = 원문 코드 블록(펜스 기본 표현과 동일) — 렌더 성공 시에만 다이어그램으로 교체.
  // data-mermaid 는 두 상태에 다 붙는다: "이 펜스는 다이어그램으로 갔다"가 서버 출력만 봐도 보여야
  // 렌더 성공 여부(브라우저에서만 갈리는 것)와 배선 여부(여기서 갈리는 것)를 따로 확인할 수 있다.
  if (failed || svg === '') {
    return (
      <pre
        data-mermaid=""
        className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed text-foreground"
      >
        <code>{chart}</code>
      </pre>
    )
  }
  return (
    <div
      data-mermaid=""
      className="overflow-x-auto rounded-md border border-border bg-muted/20 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
