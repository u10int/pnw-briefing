const BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com/"
const PRODUCT = "CONUS/MergedReflectivityQCComposite_00.50"
/** File keys for a UTC day, with their valid times (the composite, or another product's folder). */
export async function listDay(day: string, product = PRODUCT): Promise<{ t: number; key: string }[]> {
  const out: { t: number; key: string }[] = []
  let token = ""
  for (let page = 0; page < 3; page++) {
    const url = `${BUCKET}?list-type=2&prefix=${product}/${day.replace(/-/g, "")}/${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`
    const xml = await (await fetch(url, { cache: "no-cache" })).text()
    for (const m of xml.matchAll(/<Key>([^<]+_(\d{8})-(\d{6})\.grib2\.gz)<\/Key>/g)) {
      const [, key, d, hms] = m
      out.push({ key, t: Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +hms.slice(0, 2), +hms.slice(2, 4), +hms.slice(4, 6)) })
    }
    const next = xml.match(/<NextContinuationToken>([^<]+)</)
    if (!next) break
    token = next[1]
  }
  return out
}

