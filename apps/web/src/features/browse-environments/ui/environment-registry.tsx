import { getTranslations } from 'next-intl/server'

import { VersionTagsEditor } from '@/features/version-tags'

import type { EnvironmentList } from '../api/browse-environments'

// The registry beside the adopted images, because they are two halves of one question and splitting them
// across pages would make a reader learn which page holds which noun. Read-only apart from the tags: a
// version's CONTENT is immutable, and tags are the one thing that can be added to a version that exists.
export async function EnvironmentRegistry({
  list,
  error,
  canTag,
}: {
  list?: EnvironmentList
  error?: string
  canTag: boolean
}) {
  const t = await getTranslations('settingsEnvironments')

  // Unread is not empty. Saying "no environments" over a failed read tells a member the registry is bare
  // when it may be full — and the registry is what a batch's sealed world resolves against.
  if (error !== undefined) return <p className="text-[12px] text-destructive">{t('registryUnread', { error })}</p>
  if (list === undefined || list.environments.length === 0)
    return <p className="text-[12px] text-muted-foreground">{t('registryEmpty')}</p>

  return (
    <ul className="divide-y divide-border/60 rounded-md border border-border/60">
      {list.environments.map((env) => {
        const latest = env.versions[env.versions.length - 1] ?? ''
        return (
          <li key={env.id} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
            <span className="shrink-0 font-mono text-[12.5px] font-[510]">{env.id}</span>
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {t('versionCount', { n: env.versions.length })}
            </span>
            {latest !== '' && <span className="shrink-0 font-mono text-[11px] text-faint">{latest}</span>}
            {latest !== '' && (
              <VersionTagsEditor
                entity="environment"
                id={env.id}
                version={latest}
                tags={env.versionTags?.[latest] ?? []}
                canEdit={canTag}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
