'use client'

import { useState } from 'react'

import { LeaveWorkspaceButton } from '@/features/leave-workspace'
import { ApiKeysManager } from '@/features/manage-api-keys'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { ProfileForm } from '@/features/update-profile'
import type { ApiKeyMeta } from '@/entities/api-key'
import type { SecretMeta } from '@/entities/secret'
import { Callout } from '@/shared/ui/callout'
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

// 유저 설정 섹션 전환 — 프로필(수정) + 워크스페이스 나가기 · 개인 시크릿 · API 키.
// (외부 계정 연결은 워크스페이스 소유 GitHub App/Mattermost 로 대체 — 설정 › 통합에서 관리)
export function AccountTabs({
  principal,
  personalSecrets,
  keys,
  keysError,
  initialTab,
}: {
  principal: AccountPrincipal
  personalSecrets: SecretMeta[]
  keys: ApiKeyMeta[]
  keysError?: string
  initialTab?: string // ?tab=…
}) {
  // 러너는 계정이 아니라 런타임 페이지(실행 대상 표면)로 이동 — 실행 인프라와 한 화면에서 관리.
  const tabKeys = ['profile', 'secrets', 'keys']
  const defaultTab = initialTab && tabKeys.includes(initialTab) ? initialTab : 'profile'

  // 보고 있던 탭이 새로고침에도 유지되도록 ?tab= 에 동기화한다(서버 재요청 없이 history.replaceState 로만 URL 갱신).
  const [tab, setTab] = useState(defaultTab)
  const onTabChange = (v: string) => {
    setTab(v)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', v)
    window.history.replaceState(null, '', url)
  }

  return (
    <Tabs value={tab} onValueChange={onTabChange} className="space-y-5">
      <TabsList>
        <TabsTrigger value="profile">프로필</TabsTrigger>
        <TabsTrigger value="secrets">시크릿</TabsTrigger>
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

      <TabsContent value="secrets">
        {/* 개인 시크릿 — 셀프 관리(admin 불필요). 다른 멤버는 못 봄. 하니스 env 에서 "내 개인" 참조. */}
        <SecretsManager variant="personal" secrets={personalSecrets} canWrite />
      </TabsContent>

      <TabsContent value="keys">
        {/* 개인 API 키 — 셀프 관리(admin 불필요). 키는 내 권한으로 동작한다. */}
        {keysError ? (
          <Callout tone="danger">키를 불러오지 못했어요: {keysError}</Callout>
        ) : (
          <ApiKeysManager keys={keys} canWrite />
        )}
      </TabsContent>
    </Tabs>
  )
}
