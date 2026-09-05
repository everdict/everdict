import { describe, expect, it } from 'vitest'

import en from '../../../../messages/en.json'
import ko from '../../../../messages/ko.json'
import { AGENT_CHAT_MISSIONS, AGENT_REFERENCE_TYPES } from './schema'

// The conversation entry vocabulary (missions · reference types) has to be 1:1 with both locales' catalogs. Add one and forget the wording and
// the screen prints the key PATH verbatim — the `issue` reference type was actually standing in the @-picker with no label — and the type system
// does not catch it (a catalog is JSON). So the catalog is checked from the vocabulary side.
const CATALOGS: Record<string, Record<string, unknown>> = { ko: ko.agentChat, en: en.agentChat }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

for (const [locale, catalog] of Object.entries(CATALOGS)) {
  describe(`agent chat catalog — ${locale}`, () => {
    it('frames every mission with a title, a body and suggestions', () => {
      const missions = catalog.missions
      expect(isRecord(missions)).toBe(true)
      if (!isRecord(missions)) return
      for (const mission of AGENT_CHAT_MISSIONS) {
        const block = missions[mission]
        expect(isRecord(block), `${locale}: missions.${mission}`).toBe(true)
        if (!isRecord(block)) continue
        expect(nonEmptyText(block.title), `${locale}: missions.${mission}.title`).toBe(true)
        expect(nonEmptyText(block.body), `${locale}: missions.${mission}.body`).toBe(true)
        const suggestions = block.suggestions
        expect(Array.isArray(suggestions), `${locale}: missions.${mission}.suggestions`).toBe(true)
        if (!Array.isArray(suggestions)) continue
        expect(suggestions.length).toBeGreaterThan(0)
        expect(suggestions.every(nonEmptyText)).toBe(true)
      }
    })

    it('names every reference type the chip can render', () => {
      const refType = catalog.refType
      expect(isRecord(refType)).toBe(true)
      if (!isRecord(refType)) return
      for (const type of AGENT_REFERENCE_TYPES) {
        expect(nonEmptyText(refType[type]), `${locale}: refType.${type}`).toBe(true)
      }
    })
  })
}
