'use client'

import { ApiKeysManager } from '@/features/manage-api-keys'
import { LeaveWorkspaceButton } from '@/features/leave-workspace'
import { ProfileForm } from '@/features/update-profile'
import type { ApiKeyMeta } from '@/entities/api-key'
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
  username?: string
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

function Prop({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className={`mt-1 truncate text-[13px] text-foreground${mono ? ' font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  )
}

// 유저 설정 섹션 전환 — 프로필(수정) + 워크스페이스 나가기 · API 키. (데이터/권한은 서버에서 내려받음)
export function AccountTabs({
  principal,
  workspaceName,
  keys,
  keysError,
  canReadKeys,
  canWriteKeys,
}: {
  principal: AccountPrincipal
  workspaceName: string
  keys: ApiKeyMeta[]
  keysError?: string
  canReadKeys: boolean
  canWriteKeys: boolean
}) {
  return (
    <Tabs defaultValue="profile" className="space-y-5">
      <TabsList>
        <TabsTrigger value="profile">프로필</TabsTrigger>
        <TabsTrigger value="keys">API 키</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <div className="space-y-5">
          <ProfileForm
            email={principal.email}
            name={principal.profile?.name}
            username={principal.profile?.username}
            avatarUrl={principal.profile?.avatarUrl}
          />

          {/* 신원 메타(읽기전용) — subject/인증방식/활성 워크스페이스/역할 */}
          <dl className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4 shadow-raise sm:grid-cols-4">
            <Prop label="subject" value={principal.subject} mono />
            <Prop label="인증 방식" value={principal.via === 'oidc' ? 'Keycloak (OIDC)' : 'API 키'} />
            <Prop label="활성 워크스페이스" value={principal.workspace || '—'} mono />
            <Prop label="역할" value={principal.roles.join(', ') || '—'} />
          </dl>

          {/* 워크스페이스 나가기 — 활성 워크스페이스 기준(api-key 세션은 숨김) */}
          {principal.via === 'oidc' && principal.workspace && (
            <LeaveWorkspaceButton workspaceName={workspaceName} />
          )}
        </div>
      </TabsContent>

      <TabsContent value="keys">
        {!canReadKeys ? (
          <EmptyState
            title="API 키 조회 권한이 없습니다."
            hint="admin 역할이 필요합니다(keys:read)."
          />
        ) : keysError ? (
          <Callout tone="danger">키 조회 실패: {keysError}</Callout>
        ) : (
          <ApiKeysManager keys={keys} canWrite={canWriteKeys} />
        )}
      </TabsContent>
    </Tabs>
  )
}
