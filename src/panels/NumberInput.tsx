import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

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
 *  matching typical form UX).
 *
 *  The native spinner arrows (and Up/Down while focused) are the one exception: per the HTML spec,
 *  those fire a native `change` event immediately, without waiting for blur — unlike typing, which
 *  only fires `change` on blur (React's `onChange` prop is actually wired to the native `input`
 *  event for both cases, so it can't tell them apart). Listening for the native `change` event
 *  directly lets the stepper commit instantly, which is what a discrete +/- click should feel like,
 *  while free-form typing still stays in the draft until the user's done. */
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
  const inputRef = useRef<HTMLInputElement>(null)
  // refs so the native `change` listener (attached once) always sees the latest props/draft
  // without needing to re-subscribe every render
  const minRef = useRef(min)
  minRef.current = min
  const maxRef = useRef(max)
  maxRef.current = max
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const commitFrom = (raw: string) => {
    const parsed = parseFloat(raw)
    if (Number.isFinite(parsed)) {
      let clamped = parsed
      if (minRef.current !== undefined) clamped = Math.max(minRef.current, clamped)
      if (maxRef.current !== undefined) clamped = Math.min(maxRef.current, clamped)
      onCommitRef.current(clamped)
    }
    setDraft(null)
  }

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const handleNativeChange = (e: Event) => commitFrom((e.target as HTMLInputElement).value)
    el.addEventListener('change', handleNativeChange)
    return () => el.removeEventListener('change', handleNativeChange)
  }, [])

  return (
    <input
      ref={inputRef}
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
      onBlur={(e) => commitFrom(draft ?? e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}
