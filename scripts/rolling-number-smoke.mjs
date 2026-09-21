import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'navo-rolling-number-'))
let browser
try {
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { RollingNumber } from './src/renderer/src/RollingNumber';
        import { UsageDashboard } from './src/renderer/src/UsageDashboard';
        import './src/renderer/src/styles.css';
        window.pending = [];
        window.navo = { getUsageStats: () => new Promise((resolve, reject) => window.pending.push({resolve, reject})) };
        const root = createRoot(document.getElementById('root'));
        const onStats = () => {};
        window.showNumber = value => flushSync(() => root.render(<div className="activity-summary"><div><strong><RollingNumber value={value}/></strong></div></div>));
        window.showDashboard = () => flushSync(() => root.render(<UsageDashboard interval={100} onAccountStats={onStats} showTokenActivity={false} showUsageTrend />));
      `,
      resolveDir: resolve('.'),
      loader: 'tsx'
    },
    bundle: true,
    loader: { '.svg': 'dataurl' },
    jsx: 'automatic',
    outfile: join(directory, 'test.js')
  })
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: await readFile(join(directory, 'test.css'), 'utf8') })
  await page.addScriptTag({ content: await readFile(join(directory, 'test.js'), 'utf8') })
  const animations = () => page.evaluate(() => document.getAnimations().length)
  const value = () => page.locator('.rolling-number').first().getAttribute('aria-label')
  await page.evaluate(() => window.showNumber('999'))
  assert.equal(await animations(), 0, 'initial data should not animate')
  await page.evaluate(() => window.showNumber('1,000'))
  assert.equal(await value(), '1,000')
  assert.ok((await animations()) > 0, 'carry should scroll existing digits')
  await page.waitForFunction(() => document.getAnimations().length === 0)
  await page.evaluate(() => window.showNumber('1,000'))
  assert.equal(await animations(), 0, 'unchanged polling data should stay still')
  await page.evaluate(() => window.showNumber('USD 0.080695 + CNY 1.20'))
  assert.equal(await value(), 'USD 0.080695 + CNY 1.20')
  await page.waitForFunction(() => document.getAnimations().length === 0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.showNumber('USD 0.090695 + CNY 2.20'))
  assert.equal(await animations(), 0, 'respect reduced motion')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => window.showDashboard())
  await page.waitForFunction(() => window.pending.length === 1)
  await page.evaluate(() => {
    window.stats = {
      summary: {
        totalTokens: 2732747,
        input: 300000,
        output: 16000,
        cacheRead: 2415000,
        requests: 40,
        cost: 0.080695,
        interruptedRequests: 0,
        interruptionCounts: {},
        cacheHitRate: 0.9
      },
      byAccount: [],
      points: []
    }
    window.pending.shift().resolve(window.stats)
  })
  await page.waitForFunction(
    () =>
      document.querySelector('.usage-total .rolling-number')?.getAttribute('aria-label') ===
      '2,732,747'
  )
  await page.waitForFunction(() => window.pending.length === 1)
  assert.equal(await value(), '2,732,747', 'background refresh must retain the previous value')
  await page.evaluate(() => window.pending.shift().reject(new Error('offline')))
  await page.getByRole('alert').waitFor()
  assert.equal(await value(), '2,732,747', 'failed refresh must retain the previous value')
  await page.waitForFunction(() => window.pending.length === 1)
  await page.evaluate(() => {
    window.stats.summary.totalTokens = 2732800
    window.pending.shift().resolve({ ...window.stats })
  })
  await page.waitForFunction(
    () =>
      document.querySelector('.usage-total .rolling-number')?.getAttribute('aria-label') ===
      '2,732,800'
  )
  assert.ok((await animations()) > 0, 'new polling data should scroll')
  await page.waitForFunction(() => document.getAnimations().length === 0)
  await mkdir('artifacts/rolling-number', { recursive: true })
  await page.screenshot({ path: 'artifacts/rolling-number/dashboard.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log(
    'PASS: rolling digits, carry, stable refresh, failure recovery, formatting, reduced motion'
  )
} finally {
  await browser?.close()
  await rm(directory, { recursive: true, force: true })
}
