/// <reference lib="webworker" />
import { type Bbox, decodeMrms } from "./mrms-decode"

/** Fetch and decode MRMS files off the main thread: { id, url, box, factor } → { id, ...grid }. */
self.onmessage = async (ev: MessageEvent<{ id: number; url: string; box: Bbox; factor: number }>) => {
  const { id, url, box, factor } = ev.data
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} for ${url}`)
    const g = await decodeMrms(await res.arrayBuffer(), box, factor)
    ;(self as unknown as Worker).postMessage({ id, ...g }, [g.data.buffer])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id, error: String(e) })
  }
}
