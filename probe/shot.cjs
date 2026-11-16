const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] })
  const shots = [
    ['hourly', 'http://localhost:8000/map.html?m=hourly&l=waves&c=-125.5,46.5,5.6,0,0'],
    ['period', 'http://localhost:8000/map.html?m=hourly&l=wper&c=-125.5,46.5,5.6,0,0'],
    ['totals', 'http://localhost:8000/map.html?v=waves&c=-125.5,46.5,5.6,0,0'],
    ['index', 'http://localhost:8000/'],
  ]
  for (const [name, url] of shots) {
    const p = await b.newPage({ viewport: { width: 1300, height: 850 }, deviceScaleFactor: 1 })
    p.on('pageerror', (e) => console.log(name, 'pageerror', e.message))
    p.on('console', (m) => { if (m.type() === 'error') console.log(name, 'console', m.text().slice(0, 200)) })
    await p.goto(url)
    await p.waitForTimeout(20000)
    if (name !== 'index') {
      const box = await p.locator('canvas').first().boundingBox()
      if (box) { await p.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5); await p.waitForTimeout(1500) }
    }
    console.log(name, 'url now', p.url())
    await p.screenshot({ path: `../probe-out/${name}.png` })
    await p.close()
  }
  await b.close()
})()
