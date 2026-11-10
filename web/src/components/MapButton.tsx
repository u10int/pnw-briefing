import { MapIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { type MapRequest, openOnMap } from "@/lib/maplink"

/** A card's link to the map: opens the Map tab on the layer that shows what the card is about. */
export function MapButton({ req, label }: { req: MapRequest; label: string }) {
  return (
    <Button variant="outline" size="sm" onClick={() => openOnMap(req)}>
      <MapIcon className="size-4" />{label}
    </Button>
  )
}
