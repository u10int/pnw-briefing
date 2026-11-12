import * as React from "react"
import { Check, Link as LinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { issuedLabel } from "@/lib/format"
import type { Briefing } from "@/types"

const InteractiveMap = React.lazy(() => import("@/sections/InteractiveMap").then((m) => ({ default: m.InteractiveMap })))

/**
 * The interactive map on a page of its own (map.html): the briefing's map with nothing around it
 * but a slim header. Its settings, time and view live in the address, so a link opens the same map.
 */
export default function MapPage() {
  const [data, setData] = React.useState<Briefing | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    fetch("data/briefing.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`briefing.json returned ${r.status}`))))
      .then((d: Briefing) => setData(d))
      .catch((e) => setError(String(e.message ?? e)))
  }, [])

  const copy = () => {
    const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1800) }
    navigator.clipboard?.writeText(location.href).then(done, () => window.prompt("Copy this link:", location.href))
  }

  if (error) return <p className="p-8 text-muted-foreground">The map data could not be loaded: {error}.</p>
  if (!data) return <p className="p-8 text-muted-foreground">Loading the map…</p>
  return (
    <TooltipProvider delayDuration={100}>
      <header className="border-b bg-card">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2.5 max-sm:px-3">
          <div className="min-w-0">
            <span className="font-semibold">Forecast map</span>
            <span className="ml-2.5 text-[13px] text-muted-foreground">{data.meta.title}, issued {issuedLabel(data.meta.issued)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? <Check aria-hidden /> : <LinkIcon aria-hidden />}{copied ? "Copied" : "Copy link"}
            </Button>
            <Button variant="ghost" size="sm" asChild><a href="./">Full briefing</a></Button>
          </div>
        </div>
      </header>
      <main>
        <React.Suspense fallback={<p className="p-8 text-muted-foreground">Loading the map…</p>}>
          <InteractiveMap data={data} standalone />
        </React.Suspense>
      </main>
    </TooltipProvider>
  )
}
