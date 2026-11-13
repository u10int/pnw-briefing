const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch()
  const shots = [
    ['radar-volume', 'vm=MRMS%20radar&vf=dbz&vp=0&c=-124.4,46.4,5.25,58,-18'],
    ['radar-max', 'vm=MRMS%20radar&vf=dbz&rm=max&vp=0&c=-124.4,46.4,5.25,58,-18'],
    ['radar-scan', 'vm=MRMS%20radar&vf=dbz&sc=y&scp=0.5&vp=0&c=-124.4,46.4,5.25,58,-18'],
    ['gfs-oro', 'vm=GFS&vf=oro&tr=1&vp=0&vw=0&c=-122.4,46.6,6.2,64,55'],
    ['gfs-sunset', 't=2026-11-14T00:00Z&vm=GFS&vf=cloud&vp=0&c=-124.4,46.4,5.25,58,-18'],
    ['gfs-wbz', 'vm=GFS&vf=wbz&tr=1&vp=1&vw=0&c=-122.4,46.6,6.2,64,55'],
  ]
  for (const [name, q] of shots) {
    const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
    p.on('pageerror', (e) => console.log(name, 'pageerror', e.message))
    p.on('console', (m) => { if (m.type() === 'error') console.log(name, 'console', m.text().slice(0, 200)) })
    await p.goto(`http://localhost:8000/map.html?m=hourly&3d=1&${q}`)
    await p.waitForTimeout(25000)
    await p.getByRole('button', { name: /^Legend/ }).first().click().catch(() => {})
    // hover across the middle of the map and report readouts
    const outs = []
    for (const [x, y] of [[700, 450], [800, 400], [900, 500], [650, 380]]) {
      await p.mouse.move(x, y); await p.waitForTimeout(600)
      outs.push(await p.locator('div.pointer-events-none.absolute.z-10').first().innerText().catch(() => '-'))
    }
    console.log(name, 'hover:', JSON.stringify(outs))
    console.log(name, 'title:', await p.locator('div.pointer-events-none.absolute.top-2').first().innerText().catch(() => '-'))
    await p.mouse.move(5, 890)
    await p.waitForTimeout(800)
    await p.screenshot({ path: `../probe-out/${name}.png`, clip: { x: 180, y: 25, width: 1220, height: 875 } })
    await p.close()
  }
  await b.close()
})()
