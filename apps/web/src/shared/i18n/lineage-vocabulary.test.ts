import type { CampaignState } from '@everdict/contracts'
import { describe, expect, it } from 'vitest'

import en from '../../../messages/en.json'
import ko from '../../../messages/ko.json'
import { changeCampaignSchema, unmetReasonSchema } from '../../entities/change-campaign/model/schema'

// The lineage section draws ONE list from TWO grades, so `LineageCampaign.state` and `.outcome` are typed as
// free `string` (packages/application-control issue-lineage-service.ts) — the union is the two grades' enums
// added together, and nothing in the types says so. Moving those words into the catalog therefore introduced a
// failure the compiler could not see: `t(`state.${x}`)` for a value the catalog lacks renders the KEY PATH,
// `lineage.state.exam_inert`, and next-intl reports it to the browser console and nowhere else.
//
// That is what this file pins. The evaluated grade's list is asserted at COMPILE time against the contract
// enum, so adding a state there breaks the web typecheck rather than a screen; the change grade's is asserted
// at runtime from the web's own mirror.

type AssertAssignable<A extends B, B> = A
// If a new `CampaignState` is added to the contracts and not to BOTH catalogs, one of these stops compiling.
type _koCoversEvaluated = AssertAssignable<CampaignState, keyof typeof ko.lineage.state>
type _enCoversEvaluated = AssertAssignable<CampaignState, keyof typeof en.lineage.state>
export type __lineageStateCoverage = [_koCoversEvaluated, _enCoversEvaluated]

// The two words the lineage service derives for an evaluated round (`verdict.comparable ? …`). They are
// computed there rather than stored, so there is no enum to import — the list is repeated here WITH its
// source, and the round-trip is the assertion below.
const EVALUATED_OUTCOMES = ['judged', 'not_comparable']
const CHANGE_OUTCOMES = ['adopted', 'rejected']

describe('the lineage catalog covers every word the lineage can emit', () => {
  for (const [locale, catalog] of [
    ['ko', ko],
    ['en', en],
  ] as const) {
    it(`${locale} names every state a campaign of either grade can end in`, () => {
      const changeStates = changeCampaignSchema.shape.state.options
      // An empty corpus is not a pass: if the mirror ever stops exposing its options, this file must fail
      // rather than certify a catalog against nothing.
      expect(changeStates.length).toBeGreaterThan(0)
      for (const state of changeStates) expect(Object.keys(catalog.lineage.state)).toContain(state)
    })

    it(`${locale} names every round outcome`, () => {
      for (const outcome of [...CHANGE_OUTCOMES, ...EVALUATED_OUTCOMES])
        expect(Object.keys(catalog.lineage.outcome)).toContain(outcome)
    })

    it(`${locale} names every judgement answer and how`, () => {
      // The answers are a union on `answer` now (an unmet criterion carries its reason), so the vocabulary is
      // read from each branch's discriminator rather than from one shared `shape`.
      const branches =
        changeCampaignSchema.shape.rounds.unwrap().element.shape.judgement.shape.answers.element.options
      expect(branches.length).toBeGreaterThan(0)
      for (const branch of branches) {
        expect(Object.keys(catalog.lineage.answer)).toContain(branch.shape.answer.value)
        expect(Object.keys(catalog.lineage.how)).toEqual(
          expect.arrayContaining([...branch.shape.how.options])
        )
      }
    })

    // A criterion says what it judges, and an unmet one says why not. Both are words the screen prints, so
    // both need the catalog — the same trap the states were in: a lookup the compiler does not constrain is a
    // partial function, and next-intl renders the missing key path into the page.
    it(`${locale} names every reason a criterion can be unmet for`, () => {
      const reasons = unmetReasonSchema.options
      expect(reasons.length).toBeGreaterThan(0)
      for (const reason of reasons) expect(Object.keys(catalog.lineage.unmetReason)).toContain(reason)
    })

    it(`${locale} names every kind a criterion can judge`, () => {
      const kinds = changeCampaignSchema.shape.criteria.element.shape.judges.options.map(
        (branch) => branch.shape.kind.value
      )
      expect(kinds.length).toBeGreaterThan(0)
      for (const kind of kinds) expect(Object.keys(catalog.lineage.judges)).toContain(kind)
    })
  }
})
