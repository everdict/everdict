'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { ArrowRight, CircleCheck, GitCompare, History, Loader2, Plus, Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { VersionTagsEditor } from '@/features/version-tags'
import {
  isBuiltInCapability,
  type Capability,
  type CapabilitySpecDiff,
  type CapabilityVersions,
} from '@/entities/capability'
import type { AdoptedEnvironment } from '@/entities/environment-adoption'
import { fmtDateTime } from '@/shared/lib/format'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'
import { SkillDocs } from '@/shared/ui/skill-docs'

import { adoptCapabilityAction, unadoptCapabilityAction } from '../api/adopt-capability'
import {
  adoptEnvironmentAction,
  unadoptEnvironmentAction,
  verifyAdoptedEnvironmentAction,
} from '../api/adopt-environment'
import {
  diffCapabilityVersionsAction,
  loadCapabilityVersionAction,
  loadCapabilityVersionsAction,
} from '../api/capability-versions'
import { importSkillAction } from '../api/import-skill'
import {
  IMG_CLASS_TONE,
  offersWrite,
  requiredSecretsOf,
  TYPE_ICON,
  VIS_ICON,
  type RequiredSecret,
  type StoreVariant,
} from '../lib/capability-display'
import { CodeTryPanel } from './code-try-panel'

// The store detail — everything about one capability drilled into from a list row (meta · the version line · the spec body · add/remove from the workspace).
// A detail is always a ROUTE and never a dialog: you have to experiment on and edit this entry with the infra/conversation panel on the
// right, which a modal covering half the screen makes impossible, and which cannot be shared as an address either.
//
// A list row is read-only, and **putting it into and taking it out of the workspace happens only here** — an environment (inventory), a
// skill (a library copy) and a tool (an agent adoption) are stored in different places under different permissions, but to the user it is one action, so there is one wording.
export function CapabilityDetailView({
  capability,
  variant,
  author,
  currentWorkspace,
  currentSubject,
  isAdmin,
  inWorkspace,
  adoptedEnv,
  canAdopt,
  canImportEnvironment,
  canImportSkill,
  secretNames,
}: {
  capability: Capability
  variant: StoreVariant
  author: { name: string; avatarUrl?: string }
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  inWorkspace: boolean
  // The inventory entry for this environment when the workspace has one — for its pull verification state (and the re-verify button).
  adoptedEnv?: AdoptedEnvironment
  canAdopt: boolean
  canImportEnvironment: boolean
  canImportSkill: boolean
  secretNames: string[]
}) {
  const t = useTranslations('capabilityStore')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)
  // The binding dialog, which appears only when there are required secrets or a write option (otherwise it is added directly).
  const [adopting, setAdopting] = useState(false)
  // The record the detail shows — the newest (the one the route carried) or a past version chosen in the version switcher.
  const [shown, setShown] = useState<Capability>(capability)
  useEffect(() => setShown(capability), [capability])

  const TypeIcon = TYPE_ICON[capability.spec.type]
  const VisIcon = VIS_ICON[capability.visibility]
  const managed = isBuiltInCapability(capability)
  const isEnv = capability.spec.type === 'environment'
  const isSkill = capability.spec.type === 'skill'
  // An environment goes to the workspace inventory (settings:write), a skill to the skill library (skills:write), everything else to my agent
  // (agents:write) — different places and different permissions, but to the user it is one action, so there is one wording.
  const canChange = isEnv ? canImportEnvironment : isSkill ? canImportSkill : canAdopt
  // A skill cannot be removed here: what was imported is a COPY of our workspace skill rather than a reference, so deleting it is deleting
  // that skill under Settings › Agent › Skills (a store cannot recall somebody else's edits).
  const canRemoveHere = canChange && !isSkill
  // Re-importing a skill WE published only makes one more copy under the same name — the original Skill is already in the library
  // (publishing hands others something to copy; it does not add anything to my own library).
  const ownPublication = isSkill && capability.tenant === currentWorkspace
  const verify = adoptedEnv?.verify

  // Add/remove is a server action that revalidates the related lists, and this page re-reads its own state (present/absent) with a router refresh.
  const startAdopt = () => {
    if (requiredSecretsOf(capability).length > 0 || offersWrite(capability)) setAdopting(true)
    else adopt({}, false)
  }
  const adopt = (secretBindings: Record<string, string>, enableWrite: boolean) =>
    void (async () => {
      setPending(true)
      try {
        const r = await adoptCapabilityAction({
          source: capability.tenant,
          id: capability.id,
          version: capability.version,
          secretBindings,
          enableWrite,
        })
        if (r.ok) {
          toast.success(t('added', { name: capability.name }))
          refresh()
        } else {
          toast.error(r.error ?? t('addError'))
        }
        setAdopting(false)
      } finally {
        setPending(false)
      }
    })()
  const unadopt = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await unadoptCapabilityAction(capability.tenant, capability.id)
        if (r.ok) {
          toast.success(t('removedFromWorkspace', { name: capability.name }))
          refresh()
        } else toast.error(r.error ?? t('addError'))
      } finally {
        setPending(false)
      }
    })()

  // Adding a skill makes a **copy** rather than pinning a reference. From that moment it is a workspace skill under Settings › Agent › Skills,
  // and it is edited and version-stamped there (the only path by which an everdict-managed skill enters a workspace).
  const importSkill = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await importSkillAction({
          source: capability.tenant,
          id: capability.id,
          version: capability.version,
        })
        if (r.ok) {
          toast.success(t('skillCopied', { name: capability.name }))
          refresh()
        } else toast.error(r.error ?? t('addError'))
      } finally {
        setPending(false)
      }
    })()

  // Environment add/remove — put into the workspace inventory, verifying pullability on the way in (warn, not block).
  const importEnv = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await adoptEnvironmentAction({
          source: capability.tenant,
          id: capability.id,
          version: capability.version,
        })
        if (!r.ok) {
          toast.error(r.error ?? t('importError'))
          return
        }
        if (r.environment.verify?.pullable === false)
          toast.warning(t('importedNotPullable', { name: capability.name }))
        else toast.success(t('imported', { name: capability.name }))
        refresh()
      } finally {
        setPending(false)
      }
    })()
  const removeEnv = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await unadoptEnvironmentAction(capability.tenant, capability.id)
        if (!r.ok) toast.error(r.error ?? t('unimportError'))
        else {
          toast.success(t('unimported', { name: capability.name }))
          refresh()
        }
      } finally {
        setPending(false)
      }
    })()
  const reverifyEnv = (e: AdoptedEnvironment) =>
    void (async () => {
      setPending(true)
      try {
        const r = await verifyAdoptedEnvironmentAction(e.source, e.id)
        if (!r.ok) toast.error(r.error ?? t('reverifyError'))
        else {
          if (r.environment.verify?.pullable === false)
            toast.warning(t('importedNotPullable', { name: e.name ?? e.id }))
          else toast.success(t('reverified'))
          refresh()
        }
      } finally {
        setPending(false)
      }
    })()

  return (
    <div className="space-y-6">
      {/* The meta strip — kind · managed · visibility (my publications) · version · author. The DECISION (add/remove) is on the right. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          <Badge tone="outline" className="gap-1">
            <TypeIcon className="size-3" />
            {t(`type_${capability.spec.type}`)}
          </Badge>
          {managed && (
            <Badge tone="info" className="gap-1">
              <Sparkles className="size-3" />
              {t('managed')}
            </Badge>
          )}
          {variant === 'mine' && (
            <Badge
              tone={capability.visibility === 'private' ? 'outline' : 'info'}
              className="gap-1"
            >
              <VisIcon className="size-3" />
              {t(`vis_${capability.visibility}`)}
            </Badge>
          )}
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
            {capability.version}
          </code>
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={author.name} url={author.avatarUrl} size="sm" className="rounded-full" />
            {t('createdBy', { name: author.name })}
          </span>
          <span>{fmtDateTime(capability.createdAt)}</span>
          {capability.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] ring-1 ring-inset ring-border"
            >
              #{tag}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {inWorkspace ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-success">
              <CircleCheck className="size-4" />
              {isSkill ? t('detailSkillCopied') : t('detailInWorkspace')}
            </span>
          ) : ownPublication ? (
            <span className="text-[12px] text-muted-foreground">{t('skillOwnPublication')}</span>
          ) : isSkill ? (
            // A skill alone has a different outcome — no reference is attached; a copy WE can edit appears. It sits as a line beside the button
            // rather than in an InfoTip because it is a fact you need before you press it.
            <span className="text-[12px] text-muted-foreground">{t('skillCopyHint')}</span>
          ) : null}
          {inWorkspace
            ? canRemoveHere && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={isEnv ? removeEnv : unadopt}
                >
                  {t('removeFromWorkspace')}
                </Button>
              )
            : canChange &&
              !ownPublication && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={isEnv ? importEnv : isSkill ? importSkill : startAdopt}
                >
                  <Plus />
                  {t('addToWorkspace')}
                </Button>
              )}
        </div>
      </div>

      {managed && <p className="text-[12.5px] text-muted-foreground">{t('managedHint')}</p>}

      {/* The pull state of an environment in the inventory — including why it cannot be pulled, and re-verified on the spot. */}
      {isEnv && inWorkspace && verify && (
        <div className="flex items-center gap-3">
          <Badge tone={verify.pullable ? 'success' : 'warning'}>
            {verify.pullable
              ? t('importedBadge')
              : t(
                  verify.reason === 'auth'
                    ? 'verifyAuth'
                    : verify.reason === 'not-found'
                      ? 'verifyNotFound'
                      : 'verifyUnreachable'
                )}
          </Badge>
          {canImportEnvironment && adoptedEnv && (
            <button
              type="button"
              className="text-[12px] font-[510] text-link transition-colors hover:text-foreground"
              disabled={pending}
              onClick={() => reverifyEnv(adoptedEnv)}
            >
              {t('reverify')}
            </button>
          )}
        </div>
      )}

      <CapabilitySpecPanel
        capability={capability}
        shown={shown}
        currentWorkspace={currentWorkspace}
        currentSubject={currentSubject}
        isAdmin={isAdmin}
        onShowVersion={setShown}
      />

      {adopting && (
        <AdoptDialog
          capability={capability}
          secretNames={secretNames}
          pending={pending}
          onClose={() => setAdopting(false)}
          onAdopt={adopt}
        />
      )}
    </div>
  )
}

// The spec body — the version panel (list, switcher, tags, diff) plus the full per-kind spec (mcp/code/skill/environment), read-only.
function CapabilitySpecPanel({
  capability,
  shown,
  currentWorkspace,
  currentSubject,
  isAdmin,
  onShowVersion,
}: {
  capability: Capability
  shown: Capability
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  onShowVersion: (record: Capability) => void
}) {
  const t = useTranslations('capabilityStore')
  // A cross-tenant public/subset entry passes its owner workspace as `source` to read versions. Omitted for one of my own workspace.
  const source = capability.tenant !== currentWorkspace ? capability.tenant : undefined
  const builtin = isBuiltInCapability(capability)
  // Version tag editing = owned by my workspace AND creator-or-admin of the version (the server enforces finally). Built-in and cross-tenant are read-only.
  const canManageVersions =
    !builtin && source === undefined && (capability.createdBy === currentSubject || isAdmin)
  const s = shown.spec
  const secrets = s.type === 'mcp' || s.type === 'code' ? s.requiredSecrets : []
  return (
    <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-3 text-[12.5px]">
      {!builtin && (
        <CapabilityVersionsPanel
          id={capability.id}
          source={source}
          latestVersion={capability.version}
          shownVersion={shown.version}
          canManage={canManageVersions}
          onShowVersion={onShowVersion}
        />
      )}
      {s.type === 'mcp' && (
        <>
          <div className="space-y-0.5">
            <p className="text-[11px] font-[510] text-muted-foreground">
              {t(s.image ? 'mcpImage' : 'mcpUrl')}
            </p>
            <code className="block break-all font-mono text-foreground">
              {s.image ? `${s.image}${s.args.length > 0 ? ` ${s.args.join(' ')}` : ''}` : s.url}
            </code>
          </div>
          {s.provides.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {s.provides.map((p) => (
                <Badge key={p} tone="neutral">
                  {p}
                </Badge>
              ))}
            </div>
          )}
          {s.write && <Badge tone="warning">{t('mcpWrite')}</Badge>}
        </>
      )}
      {s.type === 'code' && (
        <>
          <div className="flex flex-wrap gap-1">
            <Badge tone="outline">{s.language}</Badge>
            <Badge tone={s.isReadOnly ? 'success' : 'warning'}>
              {t(s.isReadOnly ? 'codeReadOnly' : 'codeWrites')}
            </Badge>
          </div>
          <CodeEditor
            value={s.code}
            language={s.language}
            readOnly
            minHeight="120px"
            maxHeight="320px"
            aria-label={t('code')}
          />
          {Object.keys(s.parametersSchema).length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[11px] font-[510] text-muted-foreground">{t('params')}</p>
              <pre className="max-h-40 overflow-auto rounded-md bg-secondary/50 p-2 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(s.parametersSchema, null, 2)}
              </pre>
            </div>
          )}
          {s.examples.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-[510] text-muted-foreground">{t('examplesLabel')}</p>
              {s.examples.map((e, i) => (
                <div key={i} className="text-[12px] text-muted-foreground">
                  {e.name && <span className="font-[510] text-foreground">{e.name}: </span>}
                  <code className="break-all font-mono">{JSON.stringify(e.input)}</code>
                  {e.note ? ` — ${e.note}` : ''}
                </div>
              ))}
            </div>
          )}
          {/* Run it directly from an example — nothing is adopted on a reading of the code alone (another workspace's code only in an isolated runtime; the server judges). */}
          <CodeTryPanel
            showCheck={false}
            buildTarget={() => ({
              ref: { source: shown.tenant, id: shown.id, version: shown.version },
            })}
            initialInput={s.examples[0] ? JSON.stringify(s.examples[0].input, null, 2) : '{}'}
          />
        </>
      )}
      {s.type === 'skill' && (
        // The multi-document skill viewer (SKILL.md plus attached-file tabs) — sharing the same viewer as the skill management detail.
        <SkillDocs instructions={s.instructions} files={s.files} />
      )}
      {s.type === 'environment' && (
        <div className="space-y-3">
          {/* The image ref, the viewer's classification of it, and the benchmark/OS summary */}
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="min-w-0 truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
              {s.image}
            </code>
            {shown.imageClass && (
              <Badge tone={IMG_CLASS_TONE[shown.imageClass]}>
                {t(`imgClass_${shown.imageClass}`)}
              </Badge>
            )}
            {s.contents?.benchmark && <Badge tone="outline">{s.contents.benchmark}</Badge>}
            {s.contents?.os && (
              <Badge tone="outline">
                {s.contents.os}
                {s.contents.arch ? `/${s.contents.arch}` : ''}
              </Badge>
            )}
          </div>
          <div>
            <p className="text-[11px] font-[510] text-muted-foreground">{t('envInstructions')}</p>
            {/* `instructions` is a markdown document — rendered rather than shown raw */}
            <Markdown content={s.instructions} className="mt-1 text-[12.5px] leading-relaxed" />
          </div>
          {s.preset && (
            <div>
              <p className="text-[11px] font-[510] text-muted-foreground">{t('envPreset')}</p>
              <pre className="mt-1 overflow-x-auto font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                {JSON.stringify(s.preset, null, 2)}
              </pre>
            </div>
          )}
          {s.contents && s.contents.packages.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {s.contents.packages.map((p) => (
                <Badge key={p} tone="neutral">
                  {p}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
      {secrets.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[11px] font-[510] text-muted-foreground">{t('requiredSecrets')}</p>
          {secrets.map((secret) => (
            <div key={secret.name} className="text-muted-foreground">
              <span className="font-mono text-foreground">{secret.name}</span>
              {secret.description ? ` — ${secret.description}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// The version management panel (parity with the registry entities) — version list, switcher, version tags, structural diff. Even with the detail
// being a route, the version list is read ON DEMAND rather than as a page prop (data needed only the moment the switcher picks). Owned by my
// workspace and creator/admin means tag editing (canManage), otherwise read-only. `source` = the cross-tenant public/subset owner (omitted for mine).
function CapabilityVersionsPanel({
  id,
  source,
  latestVersion,
  shownVersion,
  canManage,
  onShowVersion,
}: {
  id: string
  source?: string
  latestVersion: string
  shownVersion: string
  canManage: boolean
  onShowVersion: (record: Capability) => void
}) {
  const t = useTranslations('capabilityStore')
  const [data, setData] = useState<CapabilityVersions | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [switching, startSwitch] = useTransition()
  const [base, setBase] = useState('')
  const [candidate, setCandidate] = useState('')
  const [diff, setDiff] = useState<CapabilitySpecDiff | null>(null)
  const [diffing, startDiff] = useTransition()
  const [diffError, setDiffError] = useState<string>()

  const reload = useCallback(() => {
    setLoading(true)
    loadCapabilityVersionsAction(id, source).then((r) => {
      if (r.ok) {
        setData(r.data)
        setError(undefined)
      } else {
        setError(r.error)
      }
      setLoading(false)
    })
  }, [id, source])
  useEffect(() => {
    reload()
  }, [reload])

  // The switcher — load the chosen version's whole record and swap the detail spec.
  const showVersion = (version: string) => {
    if (version === shownVersion) return
    startSwitch(async () => {
      const r = await loadCapabilityVersionAction(id, version, source)
      if (r.ok) onShowVersion(r.data)
      else setError(r.error)
    })
  }

  const runDiff = () => {
    if (!base || !candidate) return
    startDiff(async () => {
      const r = await diffCapabilityVersionsAction(id, base, candidate, source)
      if (r.ok) {
        setDiff(r.data)
        setDiffError(undefined)
      } else {
        setDiff(null)
        setDiffError(r.error)
      }
    })
  }

  if (loading) return <p className="text-[11px] text-muted-foreground">{t('versionsLoading')}</p>
  if (error) return <p className="text-[11px] text-[var(--color-danger)]">{error}</p>
  if (!data || data.versions.length === 0) return null

  const descending = [...data.versions].reverse() // newest first

  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-[510] text-muted-foreground">
          <History className="size-3.5" />
          {t('versionsLabel')}
        </span>
        <Combobox
          options={descending.map((v) => ({
            value: v,
            label: v === latestVersion ? `${v} · ${t('latest')}` : v,
            ...((data.versionTags[v]?.length ?? 0) > 0
              ? { hint: data.versionTags[v]?.join(' · ') }
              : {}),
          }))}
          value={shownVersion}
          onChange={showVersion}
          disabled={switching}
          className="w-[200px]"
          aria-label={t('versionsLabel')}
        />
        {switching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {(canManage || (data.versionTags[shownVersion]?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-faint">{t('versionTagsLabel')}</span>
          <VersionTagsEditor
            entity="capability"
            id={id}
            version={shownVersion}
            tags={data.versionTags[shownVersion] ?? []}
            canEdit={canManage}
            onSaved={reload}
          />
        </div>
      )}

      {data.versions.length > 1 && (
        <div className="space-y-1.5 border-t border-border/60 pt-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <GitCompare className="size-3.5 text-muted-foreground" />
            <VersionSelect
              versions={descending}
              value={base}
              placeholder={t('diffBase')}
              onChange={setBase}
            />
            <ArrowRight className="size-3 text-faint" />
            <VersionSelect
              versions={descending}
              value={candidate}
              placeholder={t('diffCandidate')}
              onChange={setCandidate}
            />
            <button
              type="button"
              disabled={!base || !candidate || diffing}
              onClick={runDiff}
              className="rounded border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {t('diffCompare')}
            </button>
            {diffing && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          {diffError && <p className="text-[11px] text-[var(--color-danger)]">{diffError}</p>}
          {diff && <CapabilityDiffView diff={diff} />}
        </div>
      )}
    </div>
  )
}

function VersionSelect({
  versions,
  value,
  placeholder,
  onChange,
}: {
  versions: string[]
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  return (
    <Combobox
      options={versions.map((v) => ({ value: v, label: v }))}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className="w-[120px]"
      aria-label={placeholder}
    />
  )
}

// The structural diff render — before → after per field path, with added/removed/changed tones. A typeChanged (kind restructure) hint.
function CapabilityDiffView({ diff }: { diff: CapabilitySpecDiff }) {
  const t = useTranslations('capabilityStore')
  if (diff.changes.length === 0)
    return <p className="text-[11px] text-muted-foreground">{t('diffNoChanges')}</p>
  const label = (change: CapabilitySpecDiff['changes'][number]['change']) =>
    change === 'added' ? t('diffAdded') : change === 'removed' ? t('diffRemoved') : t('diffChanged')
  const tone = (change: CapabilitySpecDiff['changes'][number]['change']) =>
    change === 'added' ? 'success' : change === 'removed' ? 'danger' : 'warning'
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {t('diffSummary', {
          added: diff.summary.added,
          removed: diff.summary.removed,
          changed: diff.summary.changed,
        })}
        {diff.typeChanged ? ` · ${t('diffTypeChanged')}` : ''}
      </p>
      <div className="space-y-1">
        {diff.changes.map((ch) => (
          <div
            key={ch.path}
            className="rounded border border-border/60 bg-secondary/30 p-1.5 text-[11px]"
          >
            <div className="flex items-center gap-1.5">
              <Badge tone={tone(ch.change)}>{label(ch.change)}</Badge>
              <code className="break-all font-mono text-foreground">{ch.path}</code>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
              <span className="break-all line-through decoration-[var(--color-danger)]/50">
                {ch.before}
              </span>
              <ArrowRight className="size-3 shrink-0 text-faint" />
              <span className="break-all text-foreground">{ch.after}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// The add dialog — bind the required secrets to my own workspace secret NAMES plus the write opt-in. Then add the pin to the agent.
function AdoptDialog({
  capability,
  secretNames,
  pending,
  onClose,
  onAdopt,
}: {
  capability: Capability
  secretNames: string[]
  pending: boolean
  onClose: () => void
  onAdopt: (secretBindings: Record<string, string>, enableWrite: boolean) => void
}) {
  const t = useTranslations('capabilityStore')
  const required: RequiredSecret[] = requiredSecretsOf(capability)
  const write = offersWrite(capability)
  const [bindings, setBindings] = useState<Record<string, string>>(
    Object.fromEntries(required.map((s) => [s.name, s.name]))
  )
  const [enableWrite, setEnableWrite] = useState(false)

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <div>
          <h3 className="text-sm font-medium">{t('addTitle', { name: capability.name })}</h3>
          {capability.spec.type === 'code' && (
            <p className="mt-1 text-[12px] text-muted-foreground">{t('addCodeNote')}</p>
          )}
        </div>
        {required.length > 0 && (
          <div className="space-y-2">
            <Label>{t('bindSecrets')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('bindSecretsHint')}</p>
            {required.map((s) => (
              <div key={s.name} className="space-y-1">
                <div className="text-[12px]">
                  <span className="font-mono">{s.name}</span>
                  {s.description ? (
                    <span className="text-muted-foreground"> — {s.description}</span>
                  ) : null}
                </div>
                <Input
                  list="cap-secret-names"
                  value={bindings[s.name] ?? ''}
                  onChange={(e) => setBindings((b) => ({ ...b, [s.name]: e.target.value }))}
                  placeholder={s.name}
                  className="font-mono text-[12px]"
                />
              </div>
            ))}
            <datalist id="cap-secret-names">
              {secretNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
        )}
        {write && (
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="accent-primary"
              checked={enableWrite}
              onChange={(e) => setEnableWrite(e.target.checked)}
            />
            <span>{t('enableWrite')}</span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => onAdopt(bindings, enableWrite)}>
            {pending ? t('saving') : t('addToWorkspace')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
