'use client'

import { Plus, Sparkles, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import type { AgentSpec } from '@/entities/agent-spec'
import { SecretPicker } from '@/features/pick-secret'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { saveAgentAction } from '../api/manage-agent'

// 편집 중인 MCP 서버 행(로컬 상태). 저장 시 name/url 이 빈 행은 걸러진다.
interface ServerRow {
  name: string
  url: string
  authSecret: string
  write: boolean
}

// Workspace › Agent — 워크스페이스 대화형 에이전트 고도화 폼: instructions(시스템 프롬프트 컨텍스트) + MCP 도구서버(옵트인 쓰기)
// + model 오버라이드. 하나의 "default" 에이전트를 편집(버전 없는 업서트). 이미 만들어진 에이전트 프레임워크에 워크스페이스별
// 컨텍스트/도구를 꽂는 표면(클러드코드의 CLAUDE.md + MCP 를 워크스페이스 단위로).
export function AgentManager({
  agent,
  secretNames,
  modelIds,
  canWrite,
  configId,
}: {
  agent?: AgentSpec
  secretNames: string[]
  modelIds: string[]
  canWrite: boolean
  configId: string
}) {
  const t = useTranslations('agentManager')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [model, setModel] = useState(agent?.model ?? '')
  const [servers, setServers] = useState<ServerRow[]>(
    (agent?.mcpServers ?? []).map((s) => ({
      name: s.name,
      url: s.url,
      authSecret: s.authSecret ?? '',
      write: s.write,
    }))
  )
  const [pending, startTransition] = useTransition()

  const patchServer = (index: number, patch: Partial<ServerRow>) =>
    setServers((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const addServer = () => setServers((rows) => [...rows, { name: '', url: '', authSecret: '', write: false }])
  const removeServer = (index: number) => setServers((rows) => rows.filter((_, i) => i !== index))

  const modelOptions = [
    { value: '', label: t('modelDefault') },
    ...modelIds.map((id) => ({ value: id })),
  ]

  const save = () => {
    // 전체 스펙 업서트 — id/version 없이 나머지를 보낸다. name/url 이 있는 서버만 남긴다(빈 행 무시). description/tags 는 보존.
    const body = {
      ...(agent?.description ? { description: agent.description } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      ...(model ? { model } : {}),
      mcpServers: servers
        .filter((s) => s.name.trim().length > 0 && s.url.trim().length > 0)
        .map((s) => ({
          name: s.name.trim(),
          url: s.url.trim(),
          ...(s.authSecret ? { authSecret: s.authSecret } : {}),
          write: s.write,
        })),
      tags: agent?.tags ?? [],
    }
    startTransition(async () => {
      const r = await saveAgentAction(configId, body)
      if (r.ok) {
        toast.success(r.created ? t('savedVersion', { version: r.version ?? '' }) : t('savedNoChange'))
      } else {
        toast.error(r.error ?? t('saveError'))
      }
    })
  }

  return (
    <div className="space-y-8">
      {/* Instructions — appended to the agent's base system prompt (persona + tool protocol stay fixed). */}
      <section className="space-y-2">
        <Label htmlFor="agent-instructions">{t('instructions')}</Label>
        <p className="text-[13px] text-muted-foreground">{t('instructionsHint')}</p>
        <Textarea
          id="agent-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={8}
          disabled={!canWrite}
          placeholder={t('instructionsPlaceholder')}
          className="font-mono text-[13px]"
        />
      </section>

      {/* Model override — which registered model powers this workspace's agent (else the server default). */}
      <section className="space-y-2">
        <Label htmlFor="agent-model">{t('model')}</Label>
        <p className="text-[13px] text-muted-foreground">{t('modelHint')}</p>
        <Combobox
          id="agent-model"
          value={model}
          onChange={setModel}
          options={modelOptions}
          disabled={!canWrite}
          placeholder={t('modelDefault')}
          className="max-w-sm"
        />
      </section>

      {/* Workspace MCP tool servers — connected alongside the built-in read-only tools (write opt-in per server). */}
      <section className="space-y-3">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4 text-primary" />
            {t('mcpServers')}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('mcpServersHint')}</p>
        </div>

        {servers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
            {t('noServers')}
          </p>
        ) : (
          <div className="space-y-3">
            {servers.map((server, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional (add/remove by index) with no stable id
              <div key={index} className="space-y-3 rounded-lg border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`server-name-${index}`}>{t('serverName')}</Label>
                    <Input
                      id={`server-name-${index}`}
                      value={server.name}
                      onChange={(e) => patchServer(index, { name: e.target.value })}
                      disabled={!canWrite}
                      placeholder={t('serverNamePlaceholder')}
                    />
                  </div>
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeServer(index)}
                      aria-label={t('removeServer')}
                      className="mt-6"
                    >
                      <X />
                    </Button>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`server-url-${index}`}>{t('serverUrl')}</Label>
                  <Input
                    id={`server-url-${index}`}
                    value={server.url}
                    onChange={(e) => patchServer(index, { url: e.target.value })}
                    disabled={!canWrite}
                    placeholder="https://mcp.example.com/mcp"
                    className="font-mono text-[13px]"
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('serverAuthSecret')}</Label>
                  <SecretPicker
                    value={server.authSecret}
                    onChange={(name) => patchServer(index, { authSecret: name })}
                    names={secretNames}
                    scope="workspace"
                    aria-label={t('serverAuthSecret')}
                    hint={<span className="text-[13px] text-muted-foreground">{t('serverAuthSecretHint')}</span>}
                  />
                </div>
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={server.write}
                    disabled={!canWrite}
                    onChange={(e) => patchServer(index, { write: e.target.checked })}
                  />
                  <span>{t('serverWrite')}</span>
                </label>
                {server.write && (
                  <p className="text-[12px] text-amber-600 dark:text-amber-500">{t('serverWriteWarn')}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {canWrite && (
          <Button variant="secondary" size="sm" onClick={addServer}>
            <Plus />
            {t('addServer')}
          </Button>
        )}
      </section>

      {canWrite && (
        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button onClick={save} disabled={pending}>
            {pending ? t('saving') : t('save')}
          </Button>
        </div>
      )}
    </div>
  )
}
