import type { N } from "@/types"

// Dates arrive as YYYY-MM-DD local calendar days; anchor at noon so no timezone shifts the day.
const d = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`)

// Built by hand: Intl orders weekday+day as "6 Fri" in some engines; we want "Fri 6".
export const dayShort = (iso: string) =>
  `${d(iso).toLocaleDateString("en-US", { weekday: "short" })} ${d(iso).getDate()}`
export const dayMonth = (iso: string) =>
  d(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
export const dayLong = (iso: string) =>
  d(iso).toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" })

/** "Sat 11/7" */
export const dayMD = (iso: string) =>
  `${d(iso).toLocaleDateString("en-US", { weekday: "short" })} ${d(iso).getMonth() + 1}/${d(iso).getDate()}`

/** "Sat 11/7", or "Sat 11/7 – Sun 11/8". */
export function dateRange(a: string, b: string) {
  if (a.slice(0, 10) === b.slice(0, 10)) return dayMD(a)
  return `${dayMD(a)} – ${dayMD(b)}`
}

export const issuedLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "America/Los_Angeles", timeZoneName: "short",
  })

export const inch = (v: N, digits = 1) => (v == null ? "–" : v.toFixed(digits))

export function peak(v: number, unit: string) {
  return unit === "°F" || unit === "mph" ? `${Math.round(v)} ${unit}` : `${v.toFixed(1)} ${unit}`
}

/** Sequential blue for precipitation amounts, light -> dark. Returns background and text colours. */
const BLUES = ["#f3f7fd", "#dbe8f9", "#bcd3f4", "#94b9ee", "#6a9de6", "#3f80dc", "#2a6bc5", "#1f55a3", "#16417f", "#0f2d5c"]
export function blueCell(v: N, max: number) {
  if (v == null) return { background: "transparent", color: "var(--muted-foreground)" }
  const t = Math.max(0, Math.min(1, v / (max || 1)))
  const i = Math.min(BLUES.length - 1, Math.round(t * (BLUES.length - 1)))
  return { background: BLUES[i], color: i >= 5 ? "#fff" : "var(--foreground)" }
}

/** Sequential red for hazard agreement (0–1). */
const REDS = ["#fdf0ef", "#fbd9d6", "#f6b3ad", "#ee867d", "#e25a4f", "#c8322a", "#962019"]
export function redCell(v: number) {
  if (!v || v < 0.1) return { background: "transparent", color: "transparent" }
  const i = Math.min(REDS.length - 1, Math.floor(v * REDS.length))
  return { background: REDS[i], color: i >= 4 ? "#fff" : "var(--foreground)" }
}

export function median(xs: N[]): number | null {
  const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
export const minOf = (xs: N[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.min(...v) : null }
export const maxOf = (xs: N[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.max(...v) : null }
