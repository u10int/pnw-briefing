import { mrms3dEntry } from "../web/src/lib/mrms3d"
async function main() {
  const t0 = Date.now()
  const e = await mrms3dEntry(Date.now() - 20 * 3600e3, { west: -130, south: 41.5, east: -116.5, north: 51 })
  if (!e) { console.log("no entry"); return }
  console.log("entry", e.nx, e.ny, e.nz, e.lat, e.lon, e.times.length, e.times.slice(-3), (Date.now() - t0) + "ms")
  const v = e.vars.dbz
  const data = await v.make!()
  const step = e.times.length - 1
  const t1 = Date.now()
  await v.lazy!.load(step)
  console.log("frame loaded", (Date.now() - t1) + "ms", v.lazy!.ready(step))
  const per = e.nx * e.ny * e.nz, nxy = e.nx * e.ny
  for (let k = 0; k < e.nz; k++) {
    let n = 0, n30 = 0, mx = 0
    for (let i = 0; i < nxy; i++) { const b = data[step * per + k * nxy + i]; if (b > 0) n++; if (b >= Math.round(30 / 75 * 254)) n30++; if (b > mx) mx = b }
    console.log(`z ${(k * 0.5).toFixed(1)} km: echo ${(100 * n / nxy).toFixed(1)}%  >=30dBZ ${(100 * n30 / nxy).toFixed(2)}%  max ${(mx / 254 * 75).toFixed(0)} dBZ`)
  }
}
main()
