const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch()
  const shots = [
    ['seattle', '/location/seattle/', { width: 1400, height: 2600 }, false],
    ['pass', '/location/snoqualmie-pass/', { width: 1400, height: 2600 }, false],
    ['coast', '/location/aberdeen/', { width: 1400, height: 1400 }, false],
    ['phone', '/location/seattle/', { width: 390, height: 2600 }, true],
    ['index', '/location/', { width: 1200, height: 900 }, false],
  ]
  for (const [name, path, vp, mobile] of shots) {
    const p = await b.newPage({ viewport: vp, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile })
    p.on('pageerror', (e) => console.log(name, 'pageerror', e.message))
    p.on('console', (m) => { if (m.type() === 'error') console.log(name, 'console', m.text().slice(0, 200)) })
    await p.goto('http://localhost:8000' + path)
    await p.waitForTimeout(6000)
    if (name === 'seattle') {
      const btn = p.locator('button[aria-expanded]').first()
      if (await btn.count()) { await btn.click(); await p.waitForTimeout(500) }
    }
    console.log(name, 'title', await p.title())
    await p.screenshot({ path: `OUT/${name}.png`, fullPage: true })
    await p.close()
  }
  await b.close()
})()
