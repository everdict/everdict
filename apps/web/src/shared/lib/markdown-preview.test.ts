import { describe, expect, it } from 'vitest'

import { markdownPreview } from './markdown-preview'

describe('markdownPreview — a list row shows the sentence, not the syntax', () => {
  it('strips headings, list markers and link syntax down to the words', () => {
    const body = '## What it means\n- p95 under 2s\n- [runbook](https://example.com)'
    expect(markdownPreview(body)).toBe('What it means p95 under 2s runbook')
  })

  it('drops code blocks and keeps inline code readable', () => {
    expect(markdownPreview('Run `pnpm test`\n\n```ts\nconst x = 1\n```\nthen ship')).toBe(
      'Run pnpm test then ship'
    )
  })

  it('keeps emphasis text and collapses the blank lines a paragraph break leaves', () => {
    expect(markdownPreview('**Goal**: _fewer_ retries\n\n\nby Q3')).toBe(
      'Goal: fewer retries by Q3'
    )
  })
})
