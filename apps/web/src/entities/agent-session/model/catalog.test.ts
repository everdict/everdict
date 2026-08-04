import { describe, expect, it } from 'vitest'

import en from '../../../../messages/en.json'
import ko from '../../../../messages/ko.json'
import { AGENT_CHAT_MISSIONS, AGENT_REFERENCE_TYPES } from './schema'

// 대화 진입의 어휘(임무 · 참조 타입)는 두 로케일의 카탈로그와 1:1 이어야 한다. 하나를 늘리고 문구를 빼먹으면
// 화면에는 키 경로가 그대로 찍히는데 — `issue` 참조 타입이 실제로 라벨 없이 @-피커에 올라와 있었다 — 그건
// 타입이 잡아 주지 않는다(카탈로그는 JSON 이다). 그래서 어휘 쪽에서 카탈로그를 검사한다.
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
