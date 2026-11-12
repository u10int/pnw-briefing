import * as React from "react"
import { InfoTip } from "@/components/InfoTip"
import { cn } from "@/lib/utils"

// min-w-0: a card in a grid or flex row never grows past its track to fit one-line (truncated)
// text, which would push the page wider than a phone screen
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex min-w-0 flex-col gap-(--card-gap) rounded-xl border bg-card py-(--card-pad) text-card-foreground shadow-sm [--card-gap:--spacing(5)] [--card-pad:--spacing(5)] sm:[--card-gap:--spacing(6)] sm:[--card-pad:--spacing(6)]",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto] items-start gap-2 px-(--card-pad) @xl/card-header:has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-(--card-pad)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

/** A card's explanatory text: one short line, with the longer notes (`info`) behind a help icon at
 *  its end. Text without `about` that runs longer than a line is cut to it with a "More" toggle. */
function CardDescription({ className, children, full = false, info, ...props }: Omit<React.ComponentProps<"div">, "about"> & { full?: boolean; info?: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(false)
  const [long, setLong] = React.useState(false)
  const whole = full || info != null
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el || whole) return
    const check = () => { if (!open) setLong(el.scrollWidth > el.clientWidth + 1) }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [whole, open])
  return (
    <div data-slot="card-description" className={cn("min-w-0 text-sm text-muted-foreground", className)} {...props}>
      <div ref={ref} className={whole || open ? "" : "min-w-0 truncate"}>
        {children}{info != null && <>{" "}<InfoTip label="this card" className="-mt-0.5">{info}</InfoTip></>}
      </div>
      {!whole && (long || open) && (
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open}
          className="mt-0.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          {open ? "Less" : "More about this"}
        </button>
      )}
    </div>
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-1 mt-1 max-w-full self-start justify-self-start overflow-x-auto @xl/card-header:col-start-2 @xl/card-header:overflow-visible @xl/card-header:row-span-2 @xl/card-header:row-start-1 @xl/card-header:mt-0 @xl/card-header:justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-pad)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-(--card-pad) [.border-t]:pt-(--card-pad)", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
