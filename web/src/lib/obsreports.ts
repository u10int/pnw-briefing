import type { ObsReport, ObsReports } from "@/types"

/** The reports still within `reportHours` of their event at the time the page is looked at. */
export function liveReports(o: ObsReports | null | undefined, now = Date.now()): ObsReport[] {
  if (!o) return []
  const keep = (o.reportHours ?? 48) * 3600e3
  return o.reports.filter((r) => r.time && now - Date.parse(r.time) <= keep)
}
