import type { Incident } from "@/types"

/** An incident still worth listing as active. The NIFC feed keeps fires until they're declared
 *  out and touches every record's update time, so "updated" says nothing; fires being reported on
 *  carry a containment figure, while the many leftover small ones have none and old discovery
 *  dates. Active: a wildfire or complex under 100% contained, with a containment figure or
 *  discovered in the last 30 days. */
export function isActive(r: Incident, now = Date.now()) {
  if (r.type === "Prescribed fire" || (r.contained ?? 0) >= 100) return false
  if (r.contained != null) return true
  return !!r.discovered && now - Date.parse(r.discovered) < 30 * 864e5
}
