'use client'

import { useState } from 'react'
import { Boxes, Plus, Sparkles, Wrench, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { SecretPicker } from '@/features/pick-secret'
import type { AgentDefault, AgentSpec, CapabilityRef } from '@/entities/agent-spec'
import { Badge } from '@/shared/ui/badge'
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
  defaults,
  canWrite,
  configId,
}: {
  agent?: AgentSpec
  secretNames: string[]
  modelIds: string[]
  defaults: AgentDefault[]
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
  // 스토어에서 채택한 capabilities(불변버전 pin). 여기선 검토 + 제거만; 새 채택은 스토어에서. 저장 시 반드시 보존해야 한다.
  const [capabilities, setCapabilities] = useState<CapabilityRef[]>(agent?.capabilities ?? [])
  // 워크스페이스가 끈 first-party 기본 도구(id). 기본 도구셋은 채택 없이 붙지만 여기서 끌 수 있다. 저장 시 반드시 보존.
  const [disabledDefaults, setDisabledDefaults] = useState<string[]>(agent?.disabledDefaults ?? [])
  const toggleDefault = (id: string, enabled: boolean) =>
    setDisabledDefaults((ids) =>
      enabled ? ids.filter((x) => x !== id) : [...new Set([...ids, id])]
    )
  const [pending, setPending] = useState(false)

  const patchServer = (index: number, patch: Partial<ServerRow>) =>
    setServers((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const addServer = () =>
    setServers((rows) => [...rows, { name: '', url: '', authSecret: '', write: false }])
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
      // 채택한 capabilities 는 이 폼에서 안 만들지만(스토어에서 채택) 반드시 보존해야 한다 — 빠뜨리면 저장 시 전부 사라진다.
      capabilities,
      // 기본 도구 opt-out — 빠뜨리면 저장 시 꺼둔 기본 도구가 되살아난다(capabilities 와 동일 보존 규칙).
      disabledDefaults,
      // 도구 상세에서 이어 둔 시크릿 리매핑(기본 제공·미채택 발행물) — 빠뜨리면 저장 시 전부 풀린다(동일 보존 규칙).
      toolSecretBindings: agent?.toolSecretBindings ?? {},
      tags: agent?.tags ?? [],
    }
    void (async () => {
      setPending(true)
      try {
        const r = await saveAgentAction(configId, body)
        if (r.ok) {
          toast.success(
            r.created ? t('savedVersion', { version: r.version ?? '' }) : t('savedNoChange')
          )
        } else {
          toast.error(r.error ?? t('saveError'))
        }
      } finally {
        setPending(false)
      }
    })()
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
                    hint={
                      <span className="text-[13px] text-muted-foreground">
                        {t('serverAuthSecretHint')}
                      </span>
                    }
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
                  <p className="text-[12px] text-amber-600 dark:text-amber-500">
                    {t('serverWriteWarn')}
                  </p>
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

      {/* Adopted capabilities — 스토어에서 채택한 도구/스킬(불변버전 pin). 새 채택은 스토어에서, 여기선 검토 + 제거. */}
      <section className="space-y-3">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Boxes className="size-4 text-primary" />
            {t('adoptedCapabilities')}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('adoptedCapabilitiesHint')}</p>
        </div>
        {capabilities.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
            {t('noAdopted')}
          </p>
        ) : (
          <div className="space-y-2">
            {capabilities.map((c) => (
              <div
                key={`${c.source}/${c.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13px] font-medium">{c.id}</span>
                    <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
                      {c.version}
                    </code>
                    {c.enableWrite && <Badge tone="outline">{t('capabilityWrite')}</Badge>}
                  </div>
                  <div className="text-[11.5px] text-muted-foreground">
                    {t('capabilityFrom', { source: c.source })}
                  </div>
                </div>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      setCapabilities((cs) =>
                        cs.filter((x) => !(x.source === c.source && x.id === c.id))
                      )
                    }
                    aria-label={t('removeCapability')}
                  >
                    <X />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Built-in default tools — Everdict-authored tools the agent gets out of the box; toggle one off here (disabledDefaults). */}
      {defaults.length > 0 && (
        <section className="space-y-3">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Wrench className="size-4 text-primary" />
              {t('builtinTools')}
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">{t('builtinToolsHint')}</p>
          </div>
          <div className="space-y-2">
            {defaults.map((d) => {
              const enabled = !disabledDefaults.includes(d.id)
              return (
                <label
                  key={d.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[13px] font-medium">{d.name}</span>
                      {d.requires && (
                        <Badge tone="outline">
                          {t('builtinRequires', { integration: d.requires })}
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11.5px] text-muted-foreground">{d.description}</div>
                  </div>
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={enabled}
                    disabled={!canWrite}
                    onChange={(e) => toggleDefault(d.id, e.target.checked)}
                    aria-label={d.name}
                  />
                </label>
              )
            })}
          </div>
        </section>
      )}

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
