const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch()
  for (const [name, vp, mobile] of [['desk', { width: 1440, height: 1100 }, false], ['phone', { width: 390, height: 1400 }, true]]) {
    const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile })
    p.on('pageerror', (e) => console.log(name, 'pageerror', e.message))
    p.on('console', (m) => { if (m.type() === 'error') console.log(name, 'console', m.text().slice(0, 200)) })
    await p.goto('http://localhost:8000/')
    await p.waitForTimeout(15000)
    console.log(name, 'headline:', await p.locator('h1').first().innerText().catch(() => '-'))
    console.log(name, 'caption:', await p.locator('figcaption').first().innerText().catch(() => '-'))
    await p.screenshot({ path: `../probe-out/${name}.png` })
    await p.close()
  }
  await b.close()
})()
