'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { BuildFromSourceWizard } from './build-from-source-wizard'
import {
  ImportBenchmarkForm,
  type BenchmarkCatalogItem,
  type RecipeItem,
} from './import-benchmark-form'

// "Add benchmark" entry point — two modes:
//  · Build from source (default): a guided wizard (source→preview/field-detect→mapping→create in one shot). The primary path for a new benchmark.
//  · Catalog·recipe: import from an existing first-party catalog / a registered recipe.
export function AddBenchmark({
  benchmarks,
  recipes,
  existingDatasets = [],
  preselectRecipe,
  hfTokenScope,
}: {
  benchmarks: BenchmarkCatalogItem[]
  recipes: RecipeItem[]
  existingDatasets?: { id: string; versions: string[] }[]
  preselectRecipe?: string
  hfTokenScope?: 'user' | 'workspace' // scope of the available HF_TOKEN secret (absent = not held — gated notice)
}) {
  const t = useTranslations('importBenchmark')
  // Entering from a recipe detail via "make into a dataset" (?recipe=) starts in import mode + preselects that recipe.
  const [mode, setMode] = useState<'build' | 'import'>(preselectRecipe ? 'import' : 'build')
  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border bg-secondary/40 p-0.5">
        {(
          [
            ['build', t('modeBuild')],
            ['import', t('modeImport')],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] transition-colors',
              mode === m
                ? 'bg-card font-[510] text-foreground shadow-raise'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'build' ? (
        <BuildFromSourceWizard
          existingDatasets={existingDatasets}
          {...(hfTokenScope ? { hfTokenScope } : {})}
        />
      ) : (
        <ImportBenchmarkForm
          benchmarks={benchmarks}
          recipes={recipes}
          existingDatasets={existingDatasets}
          preselect={preselectRecipe ? `recipe:${preselectRecipe}` : undefined}
        />
      )}
    </div>
  )
}
