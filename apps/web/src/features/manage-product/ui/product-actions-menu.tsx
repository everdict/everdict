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

// 프로덕트 헤더의 ⋯ 메뉴 — 수정은 라우팅된 편집 화면으로, 삭제는 확인을 거쳐서(릴리즈와 버전 원장이 함께
// 사라진다는 사실을 말하고 지운다).
// `productRef` — 슬러그 또는 id. 편집 주소가 상세 주소와 같은 철자를 쓰도록 참조 그대로 받는다
// (컨트롤 플레인은 둘 다 같은 레코드로 해석한다).
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
