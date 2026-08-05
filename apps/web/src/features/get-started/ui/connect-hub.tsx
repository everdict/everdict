import type { ReactNode } from 'react'
import { Laptop, Puzzle, Terminal } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { DownloadPanel } from '@/features/download-desktop'
import type { DesktopRelease } from '@/features/download-desktop/api/releases'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { CodeBlock } from '@/shared/ui/code-block'
import { Link } from '@/shared/ui/link'

// 코딩 에이전트 연결 허브 — 데스크탑 / Claude Code / Codex 를 경로 기반 탭(/connect/<tab>)으로 전환한다.
// 탭을 라우트로 두면 사이드바(RESOURCES 그룹)의 개별 항목이 각자 활성 표시되고, 각 탭은 서버에서 그대로 렌더된다.
// 커맨드 스니펫은 코드이므로 로케일과 무관하게 영어 그대로; mcpUrl(공개 컨트롤플레인 …/mcp)만 실제 값으로 주입한다.
export type ConnectTab = 'desktop' | 'claude-code' | 'codex'
export const CONNECT_TABS: ConnectTab[] = ['desktop', 'claude-code', 'codex']

const TAB_ICON: Record<ConnectTab, typeof Laptop> = {
  desktop: Laptop,
  'claude-code': Puzzle,
  codex: Terminal,
}

// 번호가 붙은 설치 스텝 — 제목/본문 + (선택) 코드 블록. 프레젠테이션 전용(문자열은 상위에서 t()로 해석).
function Step({
  n,
  title,
  body,
  children,
}: {
  n: number
  title: string
  body?: ReactNode
  children?: ReactNode
}) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-[560] text-muted-foreground ring-1 ring-inset ring-border">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <h3 className="text-[13px] font-[560] text-foreground">{title}</h3>
          {body ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">{body}</p>
          ) : null}
        </div>
        {children}
      </div>
    </li>
  )
}

export async function ConnectHub({
  workspace,
  activeTab,
  mcpUrl,
  release,
  fallbackUrl,
}: {
  workspace: string
  activeTab: ConnectTab
  mcpUrl: string
  release: DesktopRelease | null
  fallbackUrl?: string
}) {
  const t = await getTranslations('connectPage')
  const copyLabel = t('copy')
  const apiKeysHref = `/${workspace}/settings/api-keys`

  const tabLabel: Record<ConnectTab, string> = {
    desktop: t('tabs.desktop'),
    'claude-code': t('tabs.claudeCode'),
    codex: t('tabs.codex'),
  }

  // t.rich 청크 — 본문 안의 "API 키 만들기" 링크와 인라인 코드 표기.
  const apiKeyLink = (chunks: ReactNode) => (
    <Link href={apiKeysHref} className="font-[510] text-primary underline-offset-2 hover:underline">
      {chunks}
    </Link>
  )
  const inlineCode = (chunks: ReactNode) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{chunks}</code>
  )

  return (
    <div className="space-y-6">
      <nav
        className="flex items-center gap-1 overflow-x-auto border-b border-border"
        aria-label={t('title')}
      >
        {CONNECT_TABS.map((tab) => {
          const active = tab === activeTab
          const Icon = TAB_ICON[tab]
          return (
            <Link
              key={tab}
              href={`/${workspace}/connect/${tab}`}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-[510] transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="size-4" strokeWidth={1.75} />
              {tabLabel[tab]}
            </Link>
          )
        })}
      </nav>

      {activeTab === 'desktop' && (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{t('desktop.intro')}</p>
          <DownloadPanel release={release} {...(fallbackUrl ? { fallbackUrl } : {})} />
        </div>
      )}

      {activeTab === 'claude-code' && (
        <div className="space-y-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{t('claude.intro')}</p>
          <ol className="space-y-5">
            <Step n={1} title={t('claude.step1Title')} body={t('claude.step1Body')}>
              <CodeBlock
                copyLabel={copyLabel}
                code={
                  '/plugin marketplace add everdict/everdict\n/plugin install everdict@everdict'
                }
              />
            </Step>
            <Step n={2} title={t('claude.step2Title')} body={t('claude.step2Body')}>
              <CodeBlock copyLabel={copyLabel} code={`export EVERDICT_MCP_URL="${mcpUrl}"`} />
            </Step>
            <Step
              n={3}
              title={t('claude.step3Title')}
              body={t.rich('claude.step3Body', { link: apiKeyLink })}
            >
              <CodeBlock
                copyLabel={copyLabel}
                code={`claude mcp add --transport http everdict "${mcpUrl}" \\\n  --header "Authorization: Bearer YOUR_API_KEY"`}
              />
            </Step>
            <Step n={4} title={t('claude.step4Title')} body={t('claude.step4Body')}>
              <CodeBlock copyLabel={copyLabel} code={'/everdict:setup\n/everdict:eval'} />
            </Step>
          </ol>
          <Callout tone="muted">{t('claude.authNote')}</Callout>
        </div>
      )}

      {activeTab === 'codex' && (
        <div className="space-y-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{t('codex.intro')}</p>
          <ol className="space-y-5">
            <Step
              n={1}
              title={t('codex.step1Title')}
              body={t.rich('codex.step1Body', { code: inlineCode })}
            >
              <CodeBlock
                copyLabel={copyLabel}
                code={`[mcp_servers.everdict]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${mcpUrl}"]`}
              />
            </Step>
            <Step
              n={2}
              title={t('codex.step2Title')}
              body={t.rich('codex.step2Body', { link: apiKeyLink })}
            >
              <CodeBlock
                copyLabel={copyLabel}
                code={`[mcp_servers.everdict]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${mcpUrl}", "--header", "Authorization: Bearer YOUR_API_KEY"]`}
              />
            </Step>
          </ol>
          <Callout tone="muted">{t('codex.authNote')}</Callout>
        </div>
      )}
    </div>
  )
}
