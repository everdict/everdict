'use client'

import { useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

import { GithubAppManager, type GithubAppNotice } from '@/features/manage-github-app'
import { ImageRegistryManager } from '@/features/manage-image-registry'
import { MattermostManager } from '@/features/manage-mattermost'
import { TraceSinkManager } from '@/features/manage-trace-sink'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import type { TraceSinkConfig } from '@/entities/trace-sink'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

export type IntegrationKey = 'github' | 'mattermost' | 'trace-sink' | 'image-registry'

// 통합 탭 — 네 매니저를 전부 펼쳐 쌓던 스택 대신, 통합별 한 줄 요약(연결 상태 배지) 리스트에서
// "관리"로 해당 통합만 드릴인한다. GitHub App 설치 콜백 직후(githubAppNotice)나 ?app= 딥링크가
// 있으면 그 통합 상세를 바로 연다.
export function IntegrationsPanel({
  githubApp,
  githubAppNotice,
  mattermost,
  traceSinks,
  imageRegistries,
  canWrite,
  secretNames,
  initialActive,
}: {
  githubApp: GithubAppView
  githubAppNotice?: GithubAppNotice
  mattermost?: MattermostConfig
  traceSinks: TraceSinkConfig[]
  imageRegistries: ImageRegistryConfig[]
  canWrite: boolean
  secretNames: string[]
  initialActive?: IntegrationKey
}) {
  const [active, setActive] = useState<IntegrationKey | undefined>(
    initialActive ?? (githubAppNotice ? 'github' : undefined)
  )

  const rows: { key: IntegrationKey; label: string; hint: string; status: ReactNode }[] = [
    {
      key: 'github',
      label: 'GitHub',
      hint: '조직 설치·선택 저장소로 비공개 클론/CI 를 연동해요.',
      status:
        githubApp.installations.length > 0 ? (
          <Badge tone="success">연결됨 · {githubApp.installations.length}개 조직</Badge>
        ) : (
          <Badge tone="outline">연결 안 됨</Badge>
        ),
    },
    {
      key: 'mattermost',
      label: 'Mattermost',
      hint: '완료·회귀 알림과 /assay 슬래시커맨드를 보내요.',
      status: mattermost ? (
        <Badge tone="success">연결됨 · {mattermost.host}</Badge>
      ) : (
        <Badge tone="outline">연결 안 됨</Badge>
      ),
    },
    {
      key: 'trace-sink',
      label: '트레이스 싱크',
      hint: '채점 상세를 관측 플랫폼에 적재해요(하니스별 선택).',
      status:
        traceSinks.length > 0 ? (
          <Badge tone="success">{traceSinks.length}개 등록</Badge>
        ) : (
          <Badge tone="outline">등록 안 됨</Badge>
        ),
    },
    {
      key: 'image-registry',
      label: '이미지 레지스트리',
      hint: '이미지 분류 기준이자 assay image push 대상이에요.',
      status:
        imageRegistries.length > 0 ? (
          <Badge tone="success">{imageRegistries.length}개 등록</Badge>
        ) : (
          <Badge tone="outline">등록 안 됨</Badge>
        ),
    },
  ]

  // 기본 뷰 — Linear settings-list 한 장에 통합별 요약 행.
  if (!active) {
    return (
      <SettingsList>
        {rows.map((r) => (
          <SettingsRow
            key={r.key}
            label={
              <span className="inline-flex flex-wrap items-center gap-2">
                {r.label}
                {r.status}
              </span>
            }
            hint={r.hint}
          >
            <Button variant="secondary" size="xs" onClick={() => setActive(r.key)}>
              관리
            </Button>
          </SettingsRow>
        ))}
      </SettingsList>
    )
  }

  // 드릴인 뷰 — 뒤로가기 + 해당 통합의 매니저만.
  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={() => setActive(undefined)}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        통합
      </button>
      {active === 'github' && (
        <GithubAppManager
          view={githubApp}
          canWrite={canWrite}
          secretNames={secretNames}
          {...(githubAppNotice !== undefined ? { notice: githubAppNotice } : {})}
        />
      )}
      {active === 'mattermost' && (
        <MattermostManager
          canWrite={canWrite}
          secretNames={secretNames}
          {...(mattermost !== undefined ? { config: mattermost } : {})}
        />
      )}
      {active === 'trace-sink' && (
        <TraceSinkManager sinks={traceSinks} canWrite={canWrite} secretNames={secretNames} />
      )}
      {active === 'image-registry' && (
        <ImageRegistryManager
          registries={imageRegistries}
          canWrite={canWrite}
          secretNames={secretNames}
        />
      )}
    </div>
  )
}
