import { describe, expect, it } from 'vitest'

import { harnessSpecSchema } from './schema'

// 하네스 상세는 스펙을 `.parse()` 한 뒤에야 그려진다 — 계약이 보내는 kind 하나가 이 미러에 없으면 화면 전체가
// "불러오지 못했습니다" 한 줄로 죽는다. 라이브에서 `trace.kind: "file"` 하네스가 정확히 그렇게 열리지 않았다.
const spec = (trace: Record<string, unknown>) => ({
  kind: 'command' as const,
  id: 'hermes-index-full-traced',
  version: '0.19.3',
  command: 'agent run',
  trace,
})

describe('harness spec mirror', () => {
  it('accepts a command that reports its own trace to a file', () => {
    const parsed = harnessSpecSchema.parse(spec({ kind: 'file', path: 'everdict-trace.json' }))

    expect(parsed.trace).toEqual({ kind: 'file', path: 'everdict-trace.json' })
  })

  it.each(['none', 'otel', 'mlflow', 'langfuse', 'langsmith', 'phoenix'])(
    'accepts the %s trace kind the control plane can register',
    (kind) => {
      expect(harnessSpecSchema.parse(spec({ kind })).trace?.kind).toBe(kind)
    }
  )

  it('still refuses a kind nobody can register', () => {
    expect(() => harnessSpecSchema.parse(spec({ kind: 'carrier-pigeon' }))).toThrow()
  })
})
