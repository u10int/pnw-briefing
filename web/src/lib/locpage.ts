/** Each forecast location has a page of its own at location/<slug>/ (written at build time, one
 *  small HTML file per location, all loading the same app). These are the slugs and links. */

/** "Snoqualmie Pass" → "snoqualmie-pass"; accents dropped ("Côte" → "cote"). */
export function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/** The location page's address, relative to the site root (or to a dated archive copy). */
export const locationPath = (name: string) => `location/${slugify(name)}/`

/** The slug this page was opened for: the path's location/<slug>/, or ?p= (the dev server, and
 *  location.html at the root). */
export function slugFromAddress(): string | null {
  const m = location.pathname.match(/\/location\/([^/]+)\/?$/)
  if (m) return decodeURIComponent(m[1])
  const p = new URLSearchParams(location.search).get("p")
  return p ? slugify(p) : null
}
