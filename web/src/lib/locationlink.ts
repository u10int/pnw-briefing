/** "Open this location" links: anything on the page can ask for a forecast location's detail
 *  panel; the page listens and opens it. */
const EVENT = "briefing:open-location"

export function openLocation(name: string) {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: name }))
}

export function onOpenLocation(fn: (name: string) => void) {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail)
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}
