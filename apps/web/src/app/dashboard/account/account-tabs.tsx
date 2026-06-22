'use client'

import { ApiKeysManager } from '@/features/manage-api-keys'
import type { ApiKeyMeta } from '@/entities/api-key'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { ThemeToggle } from '@/shared/ui/theme-toggle'

// principal.ts(server-only) 를 클라이언트로 끌어오지 않으려 필요한 모양만 로컬로 미러.
interface AccountWorkspace {
  name: string
  role: string
}
interface AccountPrincipal {
  subject: string
  workspace: string
  roles: string[]
  via: 'oidc' | 'api-key'
  workspaces?: AccountWorkspace[]
}

function Prop({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd
        className={`mt-1 truncate text-[13px] text-foreground${mono ? ' font-mono' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
}

// 유저 설정 섹션 전환 — 프로필 · 테마 · API 키. (데이터/권한은 서버에서 내려받아 표시만)
export function AccountTabs({
  principal,
  keys,
  keysError,
  canReadKeys,
  canWriteKeys,
}: {
  principal: AccountPrincipal
  keys: ApiKeyMeta[]
  keysError?: string
  canReadKeys: boolean
  canWriteKeys: boolean
}) {
  return (
    <Tabs defaultValue="profile" className="space-y-5">
      <TabsList>
        <TabsTrigger value="profile">프로필</TabsTrigger>
        <TabsTrigger value="appearance">테마</TabsTrigger>
        <TabsTrigger value="keys">API 키</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4 shadow-raise sm:grid-cols-4">
            <Prop label="subject" value={principal.subject} mono />
            <Prop
              label="인증 방식"
              value={principal.via === 'oidc' ? 'Keycloak (OIDC)' : 'API 키'}
            />
            <Prop label="활성 워크스페이스" value={principal.workspace || '—'} mono />
            <Prop label="역할" value={principal.roles.join(', ') || '—'} />
          </dl>
          {principal.workspaces && principal.workspaces.length > 0 && (
            <p className="text-[13px] text-muted-foreground">
              <span className="text-faint">내 워크스페이스 · </span>
              {principal.workspaces.map((w) => `${w.name} (${w.role})`).join(', ')}
            </p>
          )}
        </div>
      </TabsContent>

      <TabsContent value="appearance">
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4 text-[13px] text-muted-foreground shadow-raise">
          <ThemeToggle />
          <span>라이트/다크 모드 전환(이 브라우저에 저장).</span>
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
