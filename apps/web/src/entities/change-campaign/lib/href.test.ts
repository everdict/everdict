import { describe, expect, it } from 'vitest'

import { changeCampaignHref } from './href'

describe('changeCampaignHref', () => {
  it('addresses one campaign under the workspace', () => {
    expect(changeCampaignHref('acme', 'cc-1')).toBe('/acme/change-campaign/cc-1')
  })

  // The read encodes; if the link does not, the two disagree about which campaign the address names.
  it('escapes an id that could otherwise change the shape of the path', () => {
    expect(changeCampaignHref('acme', 'a/b?c')).toBe('/acme/change-campaign/a%2Fb%3Fc')
  })
})
