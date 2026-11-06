import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

/** Change in inches, with direction carried by icon and sign as well as colour. */
export function Delta({ value, digits = 1, className, unit = "in" }: { value: number | null | undefined; digits?: number; className?: string; unit?: string }) {
  if (value == null) return <span className={cn("text-muted-foreground", className)}> – </span>
  // Under 0.02 in is noise; small changes keep two decimals so "0.3 → 0.4" never reads as "no change".
  const flat = Math.abs(value) < 0.02
  const d = Math.abs(value) < 0.1 ? 2 : digits
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular-nums whitespace-nowrap",
      flat ? "text-muted-foreground" : value > 0 ? "text-[var(--wetter)]" : "text-[var(--drier)]", className)}>
      <Icon className="size-3.5" aria-hidden />
      {flat ? "no change" : `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(d)} ${unit}`}
    </span>
  )
}

/** Percent of normal as text, e.g. "180% of normal". */
export function PctNormal({ pct, className }: { pct: number | null | undefined; className?: string }) {
  if (pct == null) return null
  return (
    <span className={cn("tabular-nums whitespace-nowrap", className)} style={{ color: pctColor(pct) }}>
      {Math.round(pct)}% of normal
    </span>
  )
}

/** Brown (dry) to neutral to teal-blue (wet), centred on 100%. */
export function pctColor(pct: number) {
  if (pct < 50) return "#8c510a"
  if (pct < 80) return "#a6702e"
  if (pct <= 120) return "var(--muted-foreground)"
  if (pct <= 200) return "#1f7a7a"
  return "#0b5563"
}
