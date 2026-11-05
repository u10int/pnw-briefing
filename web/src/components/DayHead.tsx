const PT = "America/Los_Angeles"

/** A day column heading: the weekday, with the month/day under it ("Thu" over "11/5").
 *  Takes a YYYY-MM-DD calendar day, or a time in ms (read in Pacific time). */
export function DayHead({ day, className = "" }: { day: string | number; className?: string }) {
  const t = typeof day === "number" ? new Date(day) : new Date(`${day.slice(0, 10)}T12:00:00`)
  const tz = typeof day === "number" ? { timeZone: PT } : {}
  const wd = t.toLocaleDateString("en-US", { weekday: "short", ...tz })
  const md = t.toLocaleDateString("en-US", { month: "numeric", day: "numeric", ...tz })
  return <>{wd}<span className={`block font-normal text-muted-foreground tabular-nums ${className}`}>{md}</span></>
}
