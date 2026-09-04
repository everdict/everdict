'use client'

import { useMemo, useState } from 'react'
import { Boxes, ChevronDown, ChevronRight, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type {
  Capability,
  CapabilitySpec,
  CapabilityVisibility,
  ImageVerify,
} from '@/entities/capability'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'

import { saveCapabilityAction } from '../api/manage-capabilities'
import { listImageTagsAction, verifyImageAction } from '../api/wizard-tools'
import { pullReasonLabel, withDigest } from '../lib/pull-reason'
import { VisibilityPicker, WorkspacePicker } from './reach-controls'

type EnvironmentSpec = Extract<CapabilitySpec, { type: 'environment' }>
type EnvironmentPreset = NonNullable<EnvironmentSpec['preset']>

const splitCsv = (s: string): string[] =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)

// The environment-specific register/edit dialog — rather than the shared four-kind wizard, its sections follow an environment's authoring
// journey: basics → image → composition → the agent contract (the heart — a scaffold that elicits the result path and entry point, with a preview)
// → wiring presets (advanced, collapsed) → sharing (new defaults to workspace — team sharing is why this screen exists).
export function EnvironmentEditor({
  capability,
  myWorkspaces,
  imageRegistries,
  ownerId,
  canPublishPublic,
  onClose,
}: {
  capability: Capability | null
  myWorkspaces: { id: string; name: string }[]
  imageRegistries: { name: string; host: string }[]
  ownerId: string
  canPublishPublic: boolean
  onClose: () => void
}) {
  const t = useTranslations('capabilityStore')
  const isNew = capability === null
  const env = capability?.spec.type === 'environment' ? capability.spec : undefined

  const [id, setId] = useState(capability?.id ?? '')
  const [name, setName] = useState(capability?.name ?? '')
  const [description, setDescription] = useState(capability?.description ?? '')
  const [tags, setTags] = useState((capability?.tags ?? []).join(', '))
  // A new one defaults to workspace: "let the team use it" is this surface's purpose, so unlike the store wizard (private default) sharing is the default.
  const [visibility, setVisibility] = useState<CapabilityVisibility>(
    capability?.visibility ?? 'workspace'
  )
  const [sharedWith, setSharedWith] = useState<string[]>(capability?.sharedWith ?? [])

  const [image, setImage] = useState(env?.image ?? '')
  const [benchmark, setBenchmark] = useState(env?.contents?.benchmark ?? '')
  const [packages, setPackages] = useState((env?.contents?.packages ?? []).join(', '))
  const [os, setOs] = useState(env?.contents?.os ?? '')
  const [arch, setArch] = useState(env?.contents?.arch ?? '')
  const [instructions, setInstructions] = useState(env?.instructions ?? '')
  const [preset, setPreset] = useState(env?.preset ? JSON.stringify(env.preset, null, 2) : '')
  // Presets are ADVANCED — expanded to start only when there are any (topology vocabulary is not pushed at an author who has none).
  const [presetOpen, setPresetOpen] = useState(env?.preset !== undefined)
  const [previewing, setPreviewing] = useState(false)

  // The image tag helper — reads the workspace registry's repository tags and assembles the ref.
  const [tagRegistry, setTagRegistry] = useState(imageRegistries[0]?.name ?? '')
  const [tagRepo, setTagRepo] = useState('')
  const [tagLoading, setTagLoading] = useState(false)
  const [imageTags, setImageTags] = useState<string[] | null>(null)
  // A real pull verification — the static classification warnings attached at save (imageWarnings) only ask "is the host a registered
  // registry", while this asks the registry for the manifest itself (can the image I just pushed really be pulled, and its digest).
  const [verify, setVerify] = useState<ImageVerify | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [pending, setPending] = useState(false)

  // A changed ref makes the previous verification a lie — it is discarded immediately (applying the digest pin is the exception: it is that same verified image).
  const changeImage = (next: string) => {
    setImage(next)
    setVerify(null)
  }
  const runVerify = () => {
    setVerifying(true)
    setVerify(null)
    void verifyImageAction(image.trim()).then((r) => {
      setVerifying(false)
      if (r.ok && r.result !== undefined) setVerify(r.result)
      else toast.error(r.error ?? t('envVerifyError'))
    })
  }
  const verifiedDigest = verify?.digest
  const canPinDigest =
    verify?.pullable === true && verifiedDigest !== undefined && !image.includes('@')

  // Live feedback on the preset JSON — validity is shown WHILE typing rather than waiting for the save (correcting the old failure-at-save-time UX).
  const presetError = useMemo(() => {
    const raw = preset.trim()
    if (raw.length === 0) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return t('presetInvalid')
      return null
    } catch {
      return t('presetInvalid')
    }
  }, [preset, t])

  const runListTags = () => {
    setTagLoading(true)
    setImageTags(null)
    void listImageTagsAction(tagRepo.trim(), tagRegistry || undefined).then((r) => {
      setTagLoading(false)
      if (r.ok && r.tags) setImageTags(r.tags)
      else toast.error(r.error ?? t('tagsError'))
    })
  }
  const pickTag = (tag: string) => {
    const host = imageRegistries.find((reg) => reg.name === tagRegistry)?.host
    changeImage(`${host ? `${host}/` : ''}${tagRepo.trim()}:${tag}`)
  }

  const buildSpec = (): EnvironmentSpec | { error: string } => {
    let parsedPreset: EnvironmentPreset | undefined
    const rawPreset = preset.trim()
    if (rawPreset.length > 0) {
      if (presetError !== null) return { error: presetError }
      const parsed: unknown = JSON.parse(rawPreset)
      parsedPreset = parsed as EnvironmentPreset
    }
    const packageList = splitCsv(packages)
    const hasContents =
      packageList.length > 0 ||
      benchmark.trim().length > 0 ||
      os.trim().length > 0 ||
      arch.trim().length > 0
    return {
      type: 'environment',
      image: image.trim(),
      ...(hasContents
        ? {
            contents: {
              packages: packageList,
              ...(benchmark.trim() ? { benchmark: benchmark.trim() } : {}),
              ...(os.trim() ? { os: os.trim() } : {}),
              ...(arch.trim() ? { arch: arch.trim() } : {}),
            },
          }
        : {}),
      ...(parsedPreset !== undefined ? { preset: parsedPreset } : {}),
      instructions,
    }
  }

  const save = () =>
    void (async () => {
      setPending(true)
      try {
        const spec = buildSpec()
        if ('error' in spec) {
          toast.error(spec.error)
          return
        }
        const r = await saveCapabilityAction(isNew ? id.trim() : capability.id, {
          name: name.trim(),
          description: description.trim(),
          spec,
          ...(isNew ? { visibility, sharedWith: visibility === 'subset' ? sharedWith : [] } : {}),
          tags: splitCsv(tags),
        })
        if (r.ok) {
          toast.success(
            isNew ? t('published', { name: name.trim() }) : t('saved', { name: name.trim() })
          )
          // Image classification warnings (warn, not block) — the registration succeeds; only pull guarantees and reproducibility are flagged.
          for (const w of r.result?.imageWarnings ?? [])
            toast.warning(
              t(`imageWarning_${w.class === 'mutable-tag' ? 'mutableTag' : 'noPull'}`, {
                image: w.image,
              })
            )
          onClose()
        } else {
          toast.error(r.error ?? t('saveError'))
        }
      } finally {
        setPending(false)
      }
    })()

  const canSave =
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    (isNew ? id.trim().length > 0 : true) &&
    image.trim().length > 0 &&
    instructions.trim().length > 0 &&
    presetError === null

  const section = (title: string, hint?: string) => (
    <div>
      <h4 className="text-[13px] font-medium">{title}</h4>
      {hint !== undefined && <p className="mt-0.5 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  )

  return (
    <Dialog open onClose={onClose} align="top" className="max-w-2xl">
      <div className="max-h-[85vh] space-y-6 overflow-y-auto p-6">
        <h3 className="text-sm font-medium">
          {isNew ? t('envEditorNewTitle') : t('envEditorEditTitle')}
        </h3>

        {/* ── Basics ────────────────────────────────────────────── */}
        <section className="space-y-3">
          {section(t('envSectionIdentity'))}
          {isNew && (
            <div className="space-y-1">
              <Label htmlFor="env-id">{t('id')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('idHint')}</p>
              <Input
                id="env-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="officeqa-env"
                className="font-mono text-[13px]"
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="env-name">{t('name')}</Label>
              <Input
                id="env-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="text-[13px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="env-tags">{t('tags')}</Label>
              <Input
                id="env-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="text-[13px]"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="env-description">{t('descriptionLabel')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('descriptionHint')}</p>
            <Input
              id="env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </section>

        {/* ── Image ─────────────────────────────────────────────── */}
        <section className="space-y-3">
          {section(t('envSectionImage'))}
          <div className="space-y-1">
            <Label htmlFor="env-image">{t('envImage')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('envImageHint')}</p>
            <Input
              id="env-image"
              value={image}
              onChange={(e) => changeImage(e.target.value)}
              placeholder="ghcr.io/acme/officeqa-env@sha256:…"
              className="font-mono text-[13px]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={verifying || image.trim().length === 0}
              onClick={runVerify}
            >
              {verifying ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {t('envVerify')}
            </Button>
            {verify !== null &&
              (verify.pullable ? (
                <Badge tone="success">{t('pullableBadge')}</Badge>
              ) : (
                <Badge tone="warning">{pullReasonLabel(t, verify.reason)}</Badge>
              ))}
            {verifiedDigest !== undefined && (
              <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                {verifiedDigest.slice(0, 19)}…
              </span>
            )}
            {canPinDigest && verifiedDigest !== undefined && (
              // This swaps in the digest OF THAT VERIFIED IMAGE, so the verification result is kept (setImage rather than changeImage).
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setImage(withDigest(image.trim(), verifiedDigest))}
              >
                {t('envPinDigest')}
              </Button>
            )}
          </div>
          {imageRegistries.length > 0 && (
            <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
              <div className="flex flex-wrap items-end gap-2">
                {imageRegistries.length > 1 && (
                  <div className="space-y-1">
                    <Label htmlFor="env-tag-registry">{t('tagRegistry')}</Label>
                    <Combobox
                      id="env-tag-registry"
                      options={imageRegistries.map((reg) => ({
                        value: reg.name,
                        label: reg.name,
                      }))}
                      value={tagRegistry}
                      onChange={setTagRegistry}
                      className="w-[160px]"
                      aria-label={t('tagRegistry')}
                    />
                  </div>
                )}
                <div className="min-w-[10rem] flex-1 space-y-1">
                  <Label htmlFor="env-tag-repo">{t('tagRepo')}</Label>
                  <Input
                    id="env-tag-repo"
                    value={tagRepo}
                    onChange={(e) => setTagRepo(e.target.value)}
                    placeholder="acme/officeqa-env"
                    className="font-mono text-[12px]"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={tagLoading || tagRepo.trim().length === 0}
                  onClick={runListTags}
                >
                  {tagLoading ? <Loader2 className="animate-spin" /> : <Boxes />}
                  {t('listTags')}
                </Button>
              </div>
              {imageTags !== null &&
                (imageTags.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">{t('tagsNone')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {imageTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => pickTag(tag)}
                        className="rounded-md px-2 py-0.5 font-mono text-[11.5px] text-muted-foreground ring-1 ring-inset ring-border transition-colors hover:bg-primary/10 hover:text-primary hover:ring-primary/30"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </section>

        {/* ── Composition ───────────────────────────────────────── */}
        <section className="space-y-3">
          {section(t('envSectionContents'))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="env-benchmark">{t('envBenchmark')}</Label>
              <Input
                id="env-benchmark"
                value={benchmark}
                onChange={(e) => setBenchmark(e.target.value)}
                placeholder="officeqa"
                className="text-[13px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="env-packages">{t('envPackages')}</Label>
              <Input
                id="env-packages"
                value={packages}
                onChange={(e) => setPackages(e.target.value)}
                placeholder="libreoffice, python3.12"
                className="text-[13px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="env-os">{t('envOs')}</Label>
              <Input
                id="env-os"
                value={os}
                onChange={(e) => setOs(e.target.value)}
                placeholder="linux"
                className="text-[13px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="env-arch">{t('envArch')}</Label>
              <Input
                id="env-arch"
                value={arch}
                onChange={(e) => setArch(e.target.value)}
                placeholder="amd64"
                className="text-[13px]"
              />
            </div>
          </div>
        </section>

        {/* ── The agent contract — this asset's core content ─────── */}
        <section className="space-y-3">
          {section(t('envSectionContract'), t('envSectionContractHint'))}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="env-instructions">{t('envInstructions')}</Label>
              <div className="flex items-center gap-1.5">
                {instructions.trim().length === 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setInstructions(t('envScaffold'))}
                  >
                    {t('envScaffoldInsert')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={instructions.trim().length === 0}
                  onClick={() => setPreviewing((v) => !v)}
                >
                  {previewing ? t('envPreviewHide') : t('envPreviewShow')}
                </Button>
              </div>
            </div>
            {previewing ? (
              <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
                <Markdown content={instructions} className="text-[12.5px] leading-relaxed" />
              </div>
            ) : (
              <Textarea
                id="env-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={10}
                className="font-mono text-[13px]"
              />
            )}
            <p className="text-[12px] text-muted-foreground">{t('envInstructionsHint')}</p>
          </div>
        </section>

        {/* ── Wiring presets (advanced, collapsed) ──────────────── */}
        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setPresetOpen((v) => !v)}
            aria-expanded={presetOpen}
            className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {presetOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            {t('envSectionPreset')}
            <span className="font-normal text-faint">· {t('envPresetAdvanced')}</span>
          </button>
          {presetOpen && (
            <div className="space-y-1">
              <p className="text-[12px] text-muted-foreground">{t('envPresetHint')}</p>
              <Textarea
                id="env-preset"
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                rows={6}
                placeholder={'{ "service": { "port": 8000 }, "dependencies": [] }'}
                className={cn(
                  'font-mono text-[12px]',
                  presetError !== null && 'border-destructive/60'
                )}
              />
              {presetError !== null && (
                <p className="text-[12px] text-destructive">{presetError}</p>
              )}
            </div>
          )}
        </section>

        {/* ── Sharing (new only — editing changes reach from the row menu) ── */}
        {isNew && (
          <section className="space-y-3">
            {section(t('visibility'), t('envReachDefaultHint'))}
            <VisibilityPicker
              value={visibility}
              onChange={setVisibility}
              t={t}
              disablePublic={!canPublishPublic}
            />
            {visibility === 'public' && !canPublishPublic && (
              <p className="text-[12px] text-muted-foreground">{t('publicAdminOnly')}</p>
            )}
            {visibility === 'subset' && (
              <div className="space-y-1">
                <Label>{t('sharedWith')}</Label>
                <p className="text-[12px] text-muted-foreground">{t('sharedWithHint')}</p>
                <WorkspacePicker
                  workspaces={myWorkspaces}
                  ownerId={ownerId}
                  value={sharedWith}
                  onChange={setSharedWith}
                  emptyHint={t('sharedWithEmpty')}
                />
              </div>
            )}
          </section>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={pending || !canSave}>
            {pending ? t('saving') : isNew ? t('envRegister') : t('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
