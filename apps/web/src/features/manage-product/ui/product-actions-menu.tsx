'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { productsHref } from '@/entities/product'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

import { deleteProductAction } from '../api/products'

// The ⋯ menu in the product header — editing goes to the routed edit screen, and deletion goes through a confirmation (which SAYS that the
// releases and the version ledger disappear with it).
// `productRef` — a slug or an id. The reference is taken verbatim so the edit address uses the same spelling as the detail address
// (the control plane resolves both to the same record).
export function ProductActionsMenu({
  workspace,
  productRef,
}: {
  workspace: string
  productRef: string
}) {
  const t = useTranslations('productPage')
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

  function remove() {
    void (async () => {
      setPending(true)
      try {
        const r = await deleteProductAction(productRef)
        if (!r.ok) {
          toast.error(r.error ?? t('deleteError'))
          return
        }
        setConfirming(false)
        router.push(productsHref(workspace))
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <>
      <DropdownMenu
        align="end"
        trigger={({ toggle, open }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('actions')}
            aria-expanded={open}
            onClick={toggle}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      >
        <DropdownItem
          icon={<Pencil className="size-3.5" />}
          onSelect={() =>
            router.push(`/${workspace}/product/${encodeURIComponent(productRef)}/edit`)
          }
        >
          {t('edit')}
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem
          icon={<Trash2 className="size-3.5" />}
          tone="danger"
          onSelect={() => setConfirming(true)}
        >
          {t('delete')}
        </DropdownItem>
      </DropdownMenu>

      <Dialog open={confirming} onClose={() => setConfirming(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">{t('deleteTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('deleteBody')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('deleteKeep')}
            </Button>
            <Button variant="destructive" size="sm" onClick={remove} disabled={pending}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('deleteConfirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
