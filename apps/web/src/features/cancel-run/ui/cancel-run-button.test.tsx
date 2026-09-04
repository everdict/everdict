import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'
import { CancelRunButton } from './cancel-run-button'

vi.mock('@/shared/lib/use-refresh', () => ({ useRefresh: () => () => undefined }))
vi.mock('../api/cancel-run', () => ({ cancelRunAction: async () => ({ ok: true }) }))

const at = (status: string) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <CancelRunButton id="run-1" status={status} />
    </NextIntlClientProvider>
  )

// A control that only ever answers 409 teaches people the page lies, so the button is bound to the states
// the control plane can still act on. Census: `/runs/:id/cancel` had no web caller at all — a run that will
// not finish could be watched and not stopped.
// docs/architecture/web-runtime-gap-census-spec.md
describe('CancelRunButton', () => {
  it.each(['queued', 'running', 'suspended'])('offers to stop a run that is still %s', (status) => {
    expect(at(status)).toContain(en.runsPage.cancel)
  })

  it.each(['succeeded', 'failed', 'cancelled'])('renders nothing once the run has settled (%s)', (status) => {
    expect(at(status)).toBe('')
  })
})
