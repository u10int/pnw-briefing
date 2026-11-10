import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Briefing, ExtremeVar } from "@/types"
import { MapButton } from "@/components/MapButton"
import type { MapRequest } from "@/lib/maplink"

interface MapTab { id: string; label: string; src: string | null; alt: string; note: string }

const EXTREMES: { v: ExtremeVar; label: string; what: string; note: string }[] = [
  { v: "tmax", label: "High temp", what: "Highest 2 m temperature",
    note: "From each model's 3-hourly (regional) or 6-hourly (global) output, so a peak between output times can read a degree or two low." },
  { v: "tmin", label: "Low temp", what: "Lowest 2 m temperature",
    note: "From each model's 3-hourly (regional) or 6-hourly (global) output, so a low between output times can read a degree or two high." },
  { v: "wind", label: "Wind", what: "Strongest sustained 10 m wind",
    note: "Sustained wind at 10 m at each output time; gusts are on their own tab." },
  { v: "gust", label: "Gusts", what: "Strongest wind gust",
    note: "Each model's own gust field; ECMWF's is the peak since the previous output, the others are at the output time. AIFS has no gust field." },
]

/** Map tabs for the window extremes, for the 48-hour ("short") or full-range ("long") card. */
export function extremeTabs(data: Briefing, horizon: "short" | "long", over: string): MapTab[] {
  return EXTREMES.map((e) => ({
    id: e.v, label: e.label, src: data.maps[`${e.v}_${horizon}`] ?? null,
    alt: `${e.what} over ${over}, by model`,
    note: `${e.what} over ${over}. ${e.note}`,
  }))
}

/** One card per horizon; tabs switch between the precipitation and snowfall small multiples. */
export function MapCard({ title, description, tabs, map }: { title: string; description: string; tabs: MapTab[]; map?: { req: MapRequest; label: string } }) {
  const available = tabs.filter((t) => t.src)
  if (!available.length) {
    return (
      <Card>
        <CardHeader><CardTitle>{title}</CardTitle><CardDescription>No gridded model arrived for this window.</CardDescription></CardHeader>
      </Card>
    )
  }
  return (
    <Card>
      <Tabs defaultValue={available[0].id} className="gap-4">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          {(map || (available.length > 1 && available.length <= 3)) && (
            <CardAction className="flex flex-wrap gap-2">
              {map && <MapButton req={map.req} label={map.label} />}
              {available.length > 1 && available.length <= 3 && (
                <TabsList>
                  {available.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
                </TabsList>
              )}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {available.length > 3 && (
            <div className="overflow-x-auto">
              <TabsList>
                {available.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
              </TabsList>
            </div>
          )}
          {available.map((t) => (
            <TabsContent key={t.id} value={t.id} className="space-y-3">
              {(() => {
                const src = t.src!.startsWith("data:") ? t.src! : `data/${t.src}`
                return (
                  <a href={src} target="_blank" rel="noopener" title="Open full size" className="block">
                    <img src={src} alt={t.alt} className="w-full rounded-md" loading="lazy" />
                  </a>
                )
              })()}
              <p className="text-sm text-muted-foreground">{t.note}</p>
            </TabsContent>
          ))}
        </CardContent>
      </Tabs>
    </Card>
  )
}
