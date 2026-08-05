import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import en from '../../../../messages/en.json'
import type { TodoItemView } from '../lib/transcript'
import { TodoList } from './todo-list'

// The checklist is persisted transcript state (the last write_todos snapshot), not live progress. It used to
// animate the in_progress item unconditionally, so a stopped/interrupted turn kept a spinner turning forever —
// the conversation read as still working. These lock the invariant: the spinner and the present-continuous
// label exist only while the turn is actually running (`active`); halted, the step goes static and imperative.

const TODOS: TodoItemView[] = [
  {
    content: 'Summarize the failures',
    activeForm: 'Summarizing the failures',
    status: 'in_progress',
  },
  { content: 'File the issue', activeForm: 'Filing the issue', status: 'pending' },
]

const render = (active: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <TodoList todos={TODOS} active={active} />
    </NextIntlClientProvider>
  )

describe('TodoList liveness', () => {
  it('animates the in_progress item while the turn is live', () => {
    const html = render(true)
    expect(html).toContain('animate-spin')
    expect(html).toContain('Summarizing the failures')
  })

  it('stops animating once the turn is no longer running', () => {
    const html = render(false)
    expect(html).not.toContain('animate-spin')
    expect(html).toContain('Summarize the failures')
    expect(html).not.toContain('Summarizing the failures')
  })
})
