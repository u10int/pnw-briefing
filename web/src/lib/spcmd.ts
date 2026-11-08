/**
 * SPC mesoscale discussions, read live from spc.noaa.gov: the RSS feed lists the current ones; each
 * discussion's page holds its text, valid period and outline (the LAT...LON line). They last a few
 * hours, so they're fetched when the page opens rather than stored with a briefing.
 */

export interface Md {
  number: string; url: string; image: string
  areas: string; concerning: string; watch: string | null
  start: string | null; end: string | null
  summary: string; text: string
  polygon: [number, number][]                 // [lon, lat], closed
}

const RSS = "https://www.spc.noaa.gov/products/spcmdrss.xml"

/** "Valid 080037Z - 080230Z" (day of month, hour, minute) as ISO times near `now`. */
function validTimes(s: string, now = new Date()): [string | null, string | null] {
  const m = s.match(/Valid\s+(\d{2})(\d{2})(\d{2})Z\s*-\s*(\d{2})(\d{2})(\d{2})Z/)
  if (!m) return [null, null]
  const at = (d: string, h: string, mi: string) => {
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +d, +h, +mi))
    // around a month boundary the day can belong to the previous or next month
    if (t.getTime() - now.getTime() > 15 * 864e5) t.setUTCMonth(t.getUTCMonth() - 1)
    else if (now.getTime() - t.getTime() > 15 * 864e5) t.setUTCMonth(t.getUTCMonth() + 1)
    return t.toISOString()
  }
  return [at(m[1], m[2], m[3]), at(m[4], m[5], m[6])]
}

/** The LAT...LON block: 8-digit pairs DDddDDDdd, longitudes west, under 50° meaning 100 + that. */
export function mdPolygon(text: string): [number, number][] {
  const m = text.match(/LAT\.\.\.LON\s+([\d\s]+)/)
  if (!m) return []
  return (m[1].match(/\d{8}/g) ?? []).map((g) => {
    const lat = +g.slice(0, 4) / 100
    let lon = +g.slice(4) / 100
    if (lon < 50) lon += 100
    return [-lon, lat] as [number, number]
  })
}

const field = (text: string, name: string) => text.match(new RegExp(`${name}\\.\\.\\.([^\\n]+(?:\\n {3}\\S[^\\n]*)*)`))?.[1].replace(/\s+/g, " ").trim() ?? ""

export function parseMd(number: string, url: string, html: string, now = new Date()): Md {
  const pre = (html.match(/<pre>([\s\S]*?)<\/pre>/i)?.[1] ?? html).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  const [start, end] = validTimes(pre, now)
  const summary = pre.match(/SUMMARY\.\.\.([\s\S]*?)\n\s*\n/)?.[1].replace(/\s+/g, " ").trim() ?? ""
  const watch = pre.match(/Probability of Watch Issuance\.\.\.(\d+) percent/)?.[1] ?? null
  return {
    number, url, image: url.replace(/md(\d+)\.html$/, "mcd$1.png"),
    areas: field(pre, "Areas affected"), concerning: field(pre, "Concerning"), watch,
    start, end, summary, text: pre.trim(), polygon: mdPolygon(pre),
  }
}

/** Current discussions whose outline reaches the box and that haven't expired. */
export async function currentMds(box: { west: number; south: number; east: number; north: number }, now = new Date()): Promise<Md[]> {
  const rss = await (await fetch(RSS, { cache: "no-cache" })).text()
  const items = [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: m[1].match(/<title>([^<]+)/)?.[1] ?? "", link: m[1].match(/<link>([^<]+)/)?.[1] ?? "",
  })).filter((x) => /md\d+\.html$/.test(x.link))
  const mds = await Promise.all(items.map(async (x) => {
    try {
      const html = await (await fetch(x.link)).text()
      return parseMd(x.title.replace(/^SPC MD\s*/, ""), x.link, html, now)
    } catch { return null }
  }))
  return mds.filter((m): m is Md => !!m && m.polygon.length > 2
    && (!m.end || Date.parse(m.end) > now.getTime())
    && m.polygon.some(([lon, lat]) => lon >= box.west - 1 && lon <= box.east + 1 && lat >= box.south - 1 && lat <= box.north + 1))
}
