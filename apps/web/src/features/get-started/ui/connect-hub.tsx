import type { ReactNode } from 'react'
import { Laptop, Puzzle, Terminal } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { DownloadPanel } from '@/features/download-desktop'
import type { DesktopRelease } from '@/features/download-desktop/api/releases'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { CodeBlock } from '@/shared/ui/code-block'
import { Link } from '@/shared/ui/link'

// The coding agent connection hub — it switches between Desktop / Claude Code / Codex as path-based tabs (/connect/<tab>).
// Making the tabs routes lets each item in the sidebar (the RESOURCES group) show its own active state, and each tab renders straight from the server.
// Command snippets are CODE, so they stay English regardless of locale; only the mcpUrl (the public control plane's …/mcp) is injected as a real value.
export type ConnectTab = 'desktop' | 'claude-code' | 'codex'
export const CONNECT_TABS: ConnectTab[] = ['desktop', 'claude-code', 'codex']

const TAB_ICON: Record<ConnectTab, typeof Laptop> = {
  desktop: Laptop,
  'claude-code': Puzzle,
  codex: Terminal,
}

// A numbered installation step — a title and body plus an optional code block. Presentation only (the strings are resolved with t() by the parent).
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

  // The t.rich chunks — the "create an API key" link inside the body, and inline code formatting.
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
