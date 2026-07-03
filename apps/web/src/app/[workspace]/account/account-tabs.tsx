'use client'

import { useState } from 'react'

import { LeaveWorkspaceButton } from '@/features/leave-workspace'
import { ApiKeysManager } from '@/features/manage-api-keys'
import { ConnectionsManager } from '@/features/manage-connections'
import { RunnersManager } from '@/features/manage-runners'
import { ProfileForm } from '@/features/update-profile'
import type { ApiKeyMeta } from '@/entities/api-key'
import type { ConnectionMeta, ProviderInfo } from '@/entities/connection'
import type { RunnerMeta } from '@/entities/runner'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

// principal.ts(server-only) 를 클라이언트로 끌어오지 않으려 필요한 모양만 로컬로 미러.
interface AccountWorkspace {
  name: string
  role: string
}
interface AccountProfile {
  name?: string
  avatarUrl?: string
}
interface AccountPrincipal {
  subject: string
  workspace: string
  roles: string[]
  via: 'oidc' | 'api-key'
  email?: string
  workspaces?: AccountWorkspace[]
  profile?: AccountProfile
}

// 유저 설정 섹션 전환 — 프로필(수정) + 워크스페이스 나가기 · 연결된 계정(개인 소유 OAuth) · API 키.
// 연결은 워크스페이스가 아닌 개인 소유라 워크스페이스 설정이 아니라 여기(계정)에 둔다. (데이터/권한은 서버에서 내려받음)
export function AccountTabs({
  principal,
  connections,
  providers,
  canManageIntegrations,
  runners,
  keys,
  keysError,
  canReadKeys,
  canWriteKeys,
  initialTab,
  connected,
  connectError,
}: {
  principal: AccountPrincipal
  connections: ConnectionMeta[]
  providers: ProviderInfo[]
  canManageIntegrations: boolean // settings:write — 미설정 self-hosted 통합 설정 딥링크 노출 여부
  runners: RunnerMeta[]
  keys: ApiKeyMeta[]
  keysError?: string
  canReadKeys: boolean
  canWriteKeys: boolean
  initialTab?: string // ?tab=… (OAuth 콜백 복귀 시 연결 탭으로)
  connected?: string // ?connected=<provider>
  connectError?: string // ?error=<reason>
}) {
  const tabKeys = ['profile', 'connections', 'runners', 'keys']
  const defaultTab = initialTab && tabKeys.includes(initialTab) ? initialTab : 'profile'

  // 보고 있던 탭이 새로고침에도 유지되도록 ?tab= 에 동기화한다. 서버 컴포넌트가 이 값을
  // 다시 initialTab 으로 읽어 같은 탭으로 초기화한다(서버 재요청 없이 history.replaceState 로만 URL 갱신).
  const [tab, setTab] = useState(defaultTab)
  const onTabChange = (v: string) => {
    setTab(v)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', v)
    // OAuth 콜백 1회성 파라미터는 수동 탭 전환 시 정리(새로고침에 성공/오류 콜아웃이 되살아나지 않게).
    url.searchParams.delete('connected')
    url.searchParams.delete('error')
    window.history.replaceState(null, '', url)
  }

  return (
    <Tabs value={tab} onValueChange={onTabChange} className="space-y-5">
      <TabsList>
        <TabsTrigger value="profile">프로필</TabsTrigger>
        <TabsTrigger value="connections">연결된 계정</TabsTrigger>
        <TabsTrigger value="runners">연결된 러너</TabsTrigger>
        <TabsTrigger value="keys">API 키</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <div className="max-w-2xl space-y-5">
          <ProfileForm
            email={principal.email}
            name={principal.profile?.name}
            avatarUrl={principal.profile?.avatarUrl}
          />

          {/* 워크스페이스 나가기 — 활성 워크스페이스 기준(api-key 세션은 숨김) */}
          {principal.via === 'oidc' && principal.workspace && <LeaveWorkspaceButton />}
        </div>
      </TabsContent>

      <TabsContent value="connections">
        <ConnectionsManager
          connections={connections}
          providers={providers}
          workspace={principal.workspace}
          canManageIntegrations={canManageIntegrations}
          {...(connected !== undefined ? { connected } : {})}
          {...(connectError !== undefined ? { error: connectError } : {})}
        />
      </TabsContent>

      <TabsContent value="runners">
        <RunnersManager runners={runners} downloadHref={`/${principal.workspace}/download`} />
      </TabsContent>

      <TabsContent value="keys">
        {!canReadKeys ? (
          <EmptyState
            title="API 키를 볼 권한이 없어요."
            hint="워크스페이스 관리자에게 문의해보세요."
          />
        ) : keysError ? (
          <Callout tone="danger">키를 불러오지 못했어요: {keysError}</Callout>
        ) : (
          <ApiKeysManager keys={keys} canWrite={canWriteKeys} />
        )}
      </TabsContent>
    </Tabs>
  )
}
