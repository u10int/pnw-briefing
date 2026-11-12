import * as React from "react"
import { CircleHelp } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * A small help icon that shows the longer explanation behind a heading or label: on hover or focus
 * with a mouse, and a tap toggles it on a touch screen (which has no hover).
 */
export function InfoTip({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`About ${label}`} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          className={`inline-flex shrink-0 rounded-full align-middle text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${className}`}>
          <CircleHelp className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent collisionPadding={12} className="max-w-[320px] text-left text-xs leading-snug text-pretty">{children}</TooltipContent>
    </Tooltip>
  )
}
