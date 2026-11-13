import { decodeMrms, type Bbox } from "../web/src/lib/mrms-decode"
export { listDay } from "./list"
export async function decode(key: string, box: Bbox, factor: number) {
  const r = await fetch("https://noaa-mrms-pds.s3.amazonaws.com/" + key)
  if (!r.ok) throw new Error(`${r.status} ${key}`)
  return decodeMrms(await r.arrayBuffer(), box, factor)
}
