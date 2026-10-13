#!/usr/bin/env node
/**
 * QA screenshot helper — captures the running Electron renderer over the Chrome
 * DevTools Protocol. The app must already be running with a debugging port:
 *
 *   npx electron . --remote-debugging-port=9222
 *   node scripts/qa-shot.mjs --port 9222 --out docs/qa/shots --names home,chat
 *
 * It optionally clicks nothing; instead it steps through the app's own nav by
 * evaluating expressions supplied with `--steps` (a JSON array) so a caller can
 * drive real screens without Playwright.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const i = argv.indexOf(name)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : fallback
}

const port = Number(value('--port', 9222))
const out = value('--out', 'docs/qa/shots')
const steps = JSON.parse(value('--steps', '[{"name":"view","setup":null}]'))
const width = Number(value('--width', 1440))
const height = Number(value('--height', 900))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  const deadline = Date.now() + 30000
  let last = 'no target'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
      last = `${list.length} targets`
    } catch (e) {
      last = e.message
    }
    await sleep(500)
  }
  throw new Error(`no renderer on port ${port}: ${last}`)
}

function connect(url) {
  const ws = new WebSocket(url)
  let id = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  const ready = new Promise((res) => ws.addEventListener('open', res))
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const pid = id++
      pending.set(pid, { resolve, reject })
      ws.send(JSON.stringify({ id: pid, method, params: params ?? {} }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw')
    return r.result?.value
  }
  return { ready, send, evaluate, close: () => ws.close() }
}

const target = await findTarget()
const cdp = connect(target.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false
})

mkdirSync(resolve(out), { recursive: true })
for (const step of steps) {
  if (step.setup) {
    await cdp.evaluate(step.setup)
    await sleep(step.wait ?? 700)
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = resolve(out, `${step.name}.png`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`wrote ${file}`)
}
cdp.close()
process.exit(0)
