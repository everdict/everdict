import { describe, expect, it } from 'vitest'


import { ALL_NAV_ITEMS, ALL_SIDEBAR_ROWS, isNavItemActive } from './nav-config'

// 사이드바가 지금 어디인지 말하는 방법은 활성 행 하나다. 두 행이 동시에 켜지면 그 말은 거짓이 된다 —
// 이 파일은 그 불변식을 나브 설정 전체에 대해 진술한다(항목이 늘어나도 같이 검사된다).
const activeRows = (pathname: string, workspace = 'acme') =>
  ALL_SIDEBAR_ROWS.filter((item) => isNavItemActive(item, pathname, workspace)).map(
    (item) => item.labelKey
  )

describe('sidebar active state — at most one row owns a path', () => {
  it('lights exactly the row you are on', () => {
    expect(activeRows('/acme')).toEqual(['overview'])
    expect(activeRows('/acme/projects')).toEqual(['projects'])
    expect(activeRows('/acme/projects/p1')).toEqual(['projects'])
    expect(activeRows('/acme/teams')).toEqual(['teams'])
  })

  it('does not light the overview on every page — it owns the workspace root alone', () => {
    expect(activeRows('/acme/store/mine')).toEqual(['store'])
  })

  // 평가 자원은 워크스페이스 축이다 — 한동안 팀 아래에만 있어서 사이드바에 행이 아예 없었고, 그러면
  // "이 제품에 그런 게 있다"는 사실 자체가 화면에서 사라진다.
  it('gives every evaluation collection a workspace row of its own', () => {
    for (const collection of ['harnesses', 'datasets', 'judges', 'scorecards']) {
      expect(activeRows(`/acme/${collection}`)).toEqual([collection])
    }
  })

  // Regression: the nav points at a COLLECTION (`/scorecards`) while one of them lives at the SINGULAR address
  // (`/scorecard/{id}`). A plain prefix test therefore lit no row at all on a detail page — the row went dark
  // exactly when the reader had drilled into it.
  it('keeps the collection’s row lit when you open ONE of them', () => {
    expect(activeRows('/acme/project/p1')).toEqual(['projects'])
    expect(activeRows('/acme/initiative/i1')).toEqual(['initiatives'])
    expect(activeRows('/acme/view/v1')).toEqual(['views'])
    expect(activeRows('/acme/skill/s1')).toEqual(['skills'])
    // …and still through the decorative title slug an issue link carries.
    expect(
      isNavItemActive({ href: '/issues' }, '/acme/issue/ENG-12/the-judge-drops-cost-scores', 'acme')
    ).toBe(true)
    // The evaluation collections have a workspace-wide row again, so one of them lights its collection too.
    expect(activeRows('/acme/scorecard/sc-1')).toEqual(['scorecards'])
    expect(activeRows('/acme/harness/h1')).toEqual(['harnesses'])
    expect(activeRows('/acme/dataset/d1')).toEqual(['datasets'])
    expect(activeRows('/acme/judge/j1')).toEqual(['judges'])
    // A resource with NO workspace-wide row (the all-issues list is palette-only) still lights nothing — a
    // detail address must not invent an owner the collection never had.
    expect(activeRows('/acme/issue/ENG-12')).toEqual([])
  })

  // 에이전트 저작 표면이 아직 얇아서 사이드바 행을 내리기로 했다 — 그렇다고 주소가 사라진 것은 아니다.
  // 행은 없고 팔레트에는 남는다는 이 두 진술이 같이 서 있어야, 다음 사람이 한쪽만 되돌리지 않는다.
  it('keeps the agent fleet out of the sidebar while leaving it reachable from the palette', () => {
    expect(activeRows('/acme/agents')).toEqual([])
    expect(ALL_NAV_ITEMS.map((item) => item.href)).toContain('/agents')
  })

  it('scopes the answer to the workspace in the URL', () => {
    expect(activeRows('/other/projects')).toEqual([])
  })
})
