import { cn } from '@/shared/lib/utils'

// A Linear-style toggle — on/off on a settings row is a SWITCH. A button reading "on" does not say whether that is its *current state* or *what
// pressing it will do*, so the moment several sit on one screen they all have to be read again. On a switch, the POSITION is the state.
//
// A switch is a control applied IMMEDIATELY — a switch waiting for a save button creates a state that looks on while not being on.
// The caller calls the server action straight from `onCheckedChange` and reports a failure as a toast.
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full p-px transition-colors duration-150 ease-[var(--ease-out-cubic)] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default disabled:opacity-45',
        checked ? 'bg-primary' : 'bg-muted-foreground/35'
      )}
    >
      <span
        className={cn(
          'size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(8,9,10,0.35)] transition-transform duration-150 ease-[var(--ease-out-cubic)]',
          checked ? 'translate-x-3' : 'translate-x-0'
        )}
      />
    </button>
  )
}
