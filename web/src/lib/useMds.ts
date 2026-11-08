import * as React from "react"

import type { Md } from "./spcmd"
import type { Briefing } from "@/types"

/** Current SPC mesoscale discussions over the map area, fetched live and refreshed every 10
 *  minutes; [] when there are none, null until the first answer (or when SPC can't be reached). */
export function useMds(data: Briefing, on = true): Md[] | null {
  const [mds, setMds] = React.useState<Md[] | null>(null)
  React.useEffect(() => {
    if (!on) return
    let stop = false
    const d = data.domain
    const load = () => import("./spcmd")
      .then((m) => m.currentMds({ west: d.lon_min, south: d.lat_min, east: d.lon_max, north: d.lat_max }))
      .then((x) => { if (!stop) setMds(x) })
      .catch(() => {})
    load()
    const id = setInterval(load, 10 * 60e3)
    return () => { stop = true; clearInterval(id) }
  }, [on])
  return mds
}
