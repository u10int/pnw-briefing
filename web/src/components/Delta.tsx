import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

/** Change in inches, with direction carried by icon and sign as well as colour. */
export function Delta({ value, digits = 1, className, unit = "in", tone = "wet", flatBelow = 0.02, prefix = "" }: {
  value: number | null | undefined; digits?: number; className?: string; unit?: string
  /** colours for up/down: wetter/drier (precip, snow), warmer/cooler (temperature) or neutral */
  tone?: "wet" | "warm" | "neutral"; flatBelow?: number; prefix?: string
}) {
  if (value == null) return <span className={cn("text-muted-foreground", className)}> – </span>
  // Under 0.02 in is noise; small changes keep two decimals so "0.3 → 0.4" never reads as "no change".
  const flat = Math.abs(value) < flatBelow
  const d = digits > 0 && Math.abs(value) < 0.1 ? 2 : digits
  const up = tone === "warm" ? "text-[#c0392b]" : tone === "neutral" ? "text-foreground" : "text-[var(--wetter)]"
  const down = tone === "warm" ? "text-[#2c6fbb]" : tone === "neutral" ? "text-foreground" : "text-[var(--drier)]"
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular-nums whitespace-nowrap",
      flat ? "text-muted-foreground" : value > 0 ? up : down, className)}>
      <Icon className="size-3.5" aria-hidden />
      {prefix}{flat ? "no change" : `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(d)}${unit.startsWith("°") ? "" : " "}${unit}`}
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
