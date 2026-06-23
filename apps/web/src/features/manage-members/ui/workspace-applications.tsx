import type { ConnectionMeta } from '@/entities/connection'
import { Avatar } from '@/shared/ui/avatar'

// 멤버 탭의 "애플리케이션" 그룹 — 이 워크스페이스에서 만들어진 외부 계정 연결(OAuth)을 표시만 한다(읽기 전용 로스터).
// 연결은 개인 소유라 연결/해제 관리는 각자 계정(account)의 "연결된 계정" 탭에서 한다(여기는 워크스페이스가 자기 앱을 한눈에 보는 뷰).
const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  'github-enterprise': 'GitHub Enterprise',
  mattermost: 'Mattermost',
}
const providerLabel = (id: string): string => PROVIDER_LABEL[id] ?? id

export function WorkspaceApplications({ connections }: { connections: ConnectionMeta[] }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-[13px] font-[560] text-foreground">
          애플리케이션
          <span className="text-[12px] font-normal text-faint">{connections.length}</span>
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          이 워크스페이스에서 만들어진 외부 계정 연결(GitHub·Mattermost 등). 연결은 개인 소유라
          연결·해제는 각자 <span className="font-[510] text-foreground">계정</span>의 연결된 계정
          탭에서 관리합니다.
        </p>
      </div>

      {connections.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">연결된 애플리케이션이 없습니다.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card shadow-raise">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name={providerLabel(c.provider)} size="lg" />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-[510] text-foreground">
                    {providerLabel(c.provider)}
                    <span className="ml-2 font-mono text-[12px] text-muted-foreground">
                      {c.accountLabel}
                    </span>
                  </div>
                  <div className="truncate text-[12px] text-faint">
                    {c.host && <span>{c.host} · </span>}
                    {new Date(c.connectedAt).toLocaleDateString('ko-KR')}
                  </div>
                </div>
              </div>
              <span className="text-[12px] text-faint">연결됨</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
