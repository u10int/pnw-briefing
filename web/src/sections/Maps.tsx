import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface MapTab { id: string; label: string; src: string | null; alt: string; note: string }

/** One card per horizon; tabs switch between the precipitation and snowfall small multiples. */
export function MapCard({ title, description, tabs }: { title: string; description: string; tabs: MapTab[] }) {
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
          {available.length > 1 && (
            <CardAction>
              <TabsList>
                {available.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
              </TabsList>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
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
