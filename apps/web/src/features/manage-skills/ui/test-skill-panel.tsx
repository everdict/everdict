'use client'

import { useState } from 'react'
import { BookOpen, FlaskConical, Play, Wrench } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { SkillFile, SkillTryMessage } from '@/entities/skill'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Textarea } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'

import { trySkillAction } from '../api/manage-skills'

// The skill test-drive panel — it runs one REAL agent turn against the (possibly unsaved) skill plus a sample request and shows the transcript.
// It verifies BEFORE saving whether the skill actually works (was it loaded through use_skill, was the procedure followed, was the answer good). Stateless — nothing is left in a session.
export function TestSkillPanel({
  skill,
}: {
  skill: { name: string; description: string; instructions: string; files?: SkillFile[] }
}) {
  const t = useTranslations('skillsManager')
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<SkillTryMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const run = () =>
    void (async () => {
      setPending(true)
      try {
        setError(null)
        setMessages(null)
        const r = await trySkillAction(skill, prompt)
        if (r.ok && r.result) setMessages(r.result.messages)
        else setError(r.error ?? t('testError'))
      } finally {
        setPending(false)
      }
    })()

  const canRun =
    skill.name.trim().length > 0 &&
    skill.instructions.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !pending

  // Only the agent's own turns (content + tool calls); tool-result messages are intermediate and hidden.
  const turns = (messages ?? []).filter(
    (m) => m.role === 'assistant' && (m.content.length > 0 || m.toolCalls?.length)
  )

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-center gap-1.5 text-[13px] font-medium">
        <FlaskConical className="size-4 text-primary" />
        {t('testTitle')}
      </div>
      <p className="text-[12px] text-muted-foreground">{t('testHint')}</p>
      <div className="flex items-start gap-2">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder={t('testPlaceholder')}
          className="flex-1"
        />
        <Button size="sm" onClick={run} disabled={!canRun} className="mt-0.5">
          <Play />
          {pending ? t('testing') : t('runTest')}
        </Button>
      </div>

      {error !== null && <Callout tone="danger">{error}</Callout>}

      {messages !== null && (
        <div className="space-y-3 rounded-md border border-border bg-background p-3">
          {turns.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{t('testEmpty')}</p>
          ) : (
            turns.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: transcript turns are positional and immutable once rendered
              <div key={i} className="space-y-1.5">
                {m.toolCalls?.map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tool calls are positional within a turn
                  <div
                    key={j}
                    className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
                  >
                    {c.name === 'use_skill' ? (
                      <BookOpen className="size-3.5 text-primary" />
                    ) : (
                      <Wrench className="size-3.5" />
                    )}
                    <span className="font-mono">
                      {c.name === 'use_skill'
                        ? t('usedSkill', { skill: skillArg(c.arguments) })
                        : c.name}
                    </span>
                  </div>
                ))}
                {m.content.length > 0 && (
                  <Markdown content={m.content} className="text-[13px] leading-relaxed" />
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// Extracts the skill name from a use_skill({skill:"name"}) argument (for display). On a parse failure the raw text is abbreviated.
function skillArg(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as { skill?: unknown }
    if (typeof parsed.skill === 'string') return parsed.skill
  } catch {
    // fall through
  }
  return argsJson.slice(0, 40)
}
