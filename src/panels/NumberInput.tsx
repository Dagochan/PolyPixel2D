import { useState, type KeyboardEvent } from 'react'

/** Formats a committed number for display: rounds away float noise, trims trailing zeros. */
function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '0'
  return String(Math.round(v * 1000) / 1000)
}

/** A `<input type="number">` that only parses/clamps/commits on blur or Enter, instead of on every
 *  keystroke. A plain controlled `<input>` bound straight to a store value fights the user mid-type:
 *  once the store clamps or rounds, React immediately writes that back over whatever's still being
 *  typed, so you can't clear the field to type a new value, can't type a number that's temporarily
 *  out of range on the way to a valid one, and Enter never blurs. This keeps an uncommitted draft
 *  string while focused and only calls `onCommit` once the user is done editing (Enter also blurs,
 *  matching typical form UX). */
export default function NumberInput({
  value,
  onCommit,
  min,
  max,
  step,
  disabled,
  className,
  title,
}: {
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  title?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    const parsed = parseFloat(draft ?? '')
    if (Number.isFinite(parsed)) {
      let clamped = parsed
      if (min !== undefined) clamped = Math.max(min, clamped)
      if (max !== undefined) clamped = Math.min(max, clamped)
      onCommit(clamped)
    }
    setDraft(null)
  }

  return (
    <input
      type="number"
      className={className}
      title={title}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft ?? formatNumber(value)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(formatNumber(value))}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}
