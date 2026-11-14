const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch()
  const shots = [
    ['hrrr-dark', 'vm=HRRR&vf=cloud&vp=1&dk=1&c=-123.4,46.0,5.6,60,-15'],
    ['flat-dark', 'dk=1&3d=0&c=-122.8,46.6,6.0,0,0'],
  ]
  for (const [name, q] of shots) {
    const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
    p.on('pageerror', (e) => console.log(name, 'pageerror', e.message))
    p.on('console', (m) => { if (m.type() === 'error') console.log(name, 'console', m.text().slice(0, 200)) })
    await p.goto(`http://localhost:8000/map.html?m=hourly&${q.includes('3d=0') ? '' : '3d=1&'}${q}`)
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
