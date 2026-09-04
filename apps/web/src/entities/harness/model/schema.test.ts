import { describe, expect, it } from 'vitest'

import { harnessSpecSchema } from './schema'

// A harness detail is drawn only after `.parse()`ing the spec — one kind the contract sends that is missing from this mirror kills the whole
// screen as a one-line "could not load". In production a `trace.kind: "file"` harness failed to open in exactly that way.
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
