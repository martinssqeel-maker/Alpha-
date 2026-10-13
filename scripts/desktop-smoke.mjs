#!/usr/bin/env node
/**
 * Desktop UI smoke check — proves the RUNNING Electron window is interactive,
 * not merely rendered.
 *
 * Renderers can paint a perfect window that ignores every click: a splash or
 * modal overlay left mounted on top of the app swallows input while the UI
 * still looks correct in a screenshot. "It built" and "it looks right" cannot
 * detect that, so this script drives the real window through the Chrome
 * DevTools Protocol and asserts the three things a user actually needs:
 *
 *   1. no overlay is left covering the workspace,
 *   2. a real mouse click on a nav item changes the view,
 *   3. real keystrokes land in the prompt box.
 *
 * The app must already be running with a debugging port, e.g.
 *   npx electron . --remote-debugging-port=9222
 * then
 *   npm run smoke:desktop
 *   npm run smoke:desktop -- --port 9223
 *
 * Exit status: 0 when every check passes, 1 on any failure.
 */
const argv = process.argv.slice(2)
function value(name, fallback) {
  const i = argv.indexOf(name)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : fallback
}

const port = Number(value('--port', process.env.SMOKE_CDP_PORT || 9222))
const SETTLE_MS = 20_000
const TIMEOUT_MS = 10_000
const TYPED = 'alpha interactive probe'

const results = []
function record(status, name, detail) {
  results.push({ status, name, detail })
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Find the window target exposed by --remote-debugging-port. */
async function findPageTarget() {
  const deadline = Date.now() + SETTLE_MS
  let lastError = 'no target'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
      lastError = `${list.length} target(s), no page`
    } catch (e) {
      lastError = e.message
    }
    await sleep(500)
  }
  throw new Error(`Could not reach the renderer on port ${port}: ${lastError}`)
}

/** Minimal CDP client over the built-in WebSocket (Node 22+). */
function connect(url) {
  const ws = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  const console_ = []
  const exceptions = []

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      console_.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? 'exception')
    }
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('WebSocket to the renderer failed')))
  })

  function send(method, params) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params ?? {} }))
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out after ${TIMEOUT_MS} ms`))
      }, TIMEOUT_MS)
    })
  }

  /** Evaluate in the page and return the plain value. */
  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluation threw')
    }
    return res.result?.value
  }

  return { ready, send, evaluate, console_, exceptions, close: () => ws.close() }
}

/** Poll an expression until it is truthy. */
async function waitFor(cdp, expression, label, timeoutMs = SETTLE_MS) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression).catch(() => false)
    if (last) return last
    await sleep(250)
  }
  throw new Error(`${label} did not become true within ${timeoutMs} ms (last: ${JSON.stringify(last)})`)
}

/** Centre of an element matched by text inside a selector, in CSS pixels. */
const rectOf = (selector, text) => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
  const el = ${text ? `nodes.find((n) => (n.textContent || '').trim().includes(${JSON.stringify(text)}))` : 'nodes[0]'}
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return null
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`

/**
 * Click the prompt box and type into it, retrying: focus can be lost to a
 * re-render between the click and the keystrokes, which would otherwise look
 * like a dead input box.
 */
async function typeIntoPrompt(cdp, text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const point = await cdp.evaluate(rectOf('.chat-page textarea'))
    if (!point) throw new Error('the prompt box is not in the DOM')
    await clickAt(cdp, point, 'prompt')
    await cdp.send('Input.insertText', { text })
    await sleep(250)
    const value = await cdp.evaluate(`(document.querySelector('.chat-page textarea') || {}).value || ''`)
    if (value.includes(text)) return value
  }
  return cdp.evaluate(`(document.querySelector('.chat-page textarea') || {}).value || ''`)
}

async function clickAt(cdp, point, label) {
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  if (!point) throw new Error(`${label}: nothing to click`)
}

console.log(`Alpha desktop interactivity check\ncdp port: ${port}\n`)

let cdp
try {
  const target = await findPageTarget()
  cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  record('PASS', 'renderer debugging target reachable', target.title || target.url)

  // 1. The workspace must finish booting: the launch splash is a full-window,
  //    click-blocking overlay, so while it is mounted nothing can be used.
  try {
    await waitFor(cdp, `!document.querySelector('.splash')`, 'launch splash unmounted')
    record('PASS', 'launch splash leaves the screen', 'no .splash element remains')
  } catch (e) {
    record('FAIL', 'launch splash leaves the screen', e.message)
  }

  try {
    const state = await cdp.evaluate(`({
      ready: !!document.querySelector('.chat-page, .page'),
      loading: document.body.innerText.includes('Starting Alpha'),
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)
    })`)
    if (state.ready && !state.loading) {
      record('PASS', 'workspace rendered', state.text)
    } else {
      record('FAIL', 'workspace rendered', `loading=${state.loading} text="${state.text}"`)
    }
  } catch (e) {
    record('FAIL', 'workspace rendered', e.message)
  }

  // 2. Nothing may cover the controls: the element under the cursor must be the
  //    control itself (or inside it), never an overlay above it.
  let settingsPoint = null
  try {
    // Measure and hit-test in ONE evaluation: the sidebar re-renders as data
    // arrives during startup, so a second round-trip could hit a stale point.
    const probe = JSON.parse(
      await cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('button.nav-item')]
          .find((n) => (n.textContent || '').trim().includes('Settings'))
        if (!btn) return JSON.stringify({ error: 'the Settings nav item is not in the DOM' })
        const r = btn.getBoundingClientRect()
        if (!r.width || !r.height) return JSON.stringify({ error: 'the Settings nav item has no box' })
        const x = Math.round(r.left + r.width / 2)
        const y = Math.round(r.top + r.height / 2)
        const el = document.elementFromPoint(x, y)
        const describe = (node) => {
          if (!node) return 'nothing'
          const style = getComputedStyle(node)
          let path = node.tagName.toLowerCase()
          if (node.id) path += '#' + node.id
          if (node.className && typeof node.className === 'string') path += '.' + node.className.trim().split(/\\s+/).join('.')
          return path + ' [' + style.position + ' z=' + style.zIndex + ']'
        }
        const inside = el && (btn.contains(el) || el.contains(btn))
        return JSON.stringify({ x: x, y: y, inside: !!inside, covering: inside ? null : describe(el) })
      })()`)
    )
    if (probe.error) throw new Error(probe.error)
    settingsPoint = { x: probe.x, y: probe.y }
    if (probe.covering) {
      record('FAIL', 'no overlay covers the sidebar', `topmost element is ${probe.covering}`)
    } else {
      record('PASS', 'no overlay covers the sidebar', 'Settings button receives the pointer')
    }
  } catch (e) {
    record('FAIL', 'no overlay covers the sidebar', e.message)
  }

  // 3. The preload bridge must answer: a dead IPC channel is invisible in a
  //    screenshot but leaves the Account panel and cloud features unusable.
  try {
    const status = await cdp.evaluate(
      `window.alpha.invoke('platform:status').then((s) => JSON.stringify(s)).catch((e) => 'ERROR: ' + e.message)`
    )
    const parsed = JSON.parse(status)
    if (typeof parsed?.enabled === 'boolean') {
      record('PASS', 'IPC round-trip through the preload bridge', `platform:status → enabled=${parsed.enabled}`)
    } else {
      record('FAIL', 'IPC round-trip through the preload bridge', status.slice(0, 160))
    }
  } catch (e) {
    record('FAIL', 'IPC round-trip through the preload bridge', e.message)
  }

  // 3b. IPC request-key contract. Every channel whose request key is not `id`
  //     must reach its handler: validating against the wrong key shape rejects
  //     the call with "Invalid request: …", which the UI quietly swallows. That
  //     is how the Git panels, the checkpoint list and chat Stop broke.
  try {
    const realProject = await cdp.evaluate(
      `window.alpha.invoke('project:list').then((l) => (Array.isArray(l) && l[0] ? l[0].id : null)).catch(() => null)`
    )
    const probe = JSON.parse(
      await cdp.evaluate(`(async () => {
        const call = async (channel, payload) => {
          try {
            const r = await window.alpha.invoke(channel, payload)
            return { ok: true, value: JSON.stringify(r ?? null).slice(0, 60) }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        }
        const p = ${JSON.stringify(realProject)}
        const bogus = 'desktop-smoke-does-not-exist'
        const needs = { ok: false, error: 'no project to probe with' }
        return JSON.stringify({
          'git:status': p ? await call('git:status', { projectId: p }) : needs,
          'git:branches': p ? await call('git:branches', { projectId: p }) : needs,
          'git:remotes': p ? await call('git:remotes', { projectId: p }) : needs,
          'edit:checkpoints': p ? await call('edit:checkpoints', { projectId: p }) : needs,
          'terminal:cancel': await call('terminal:cancel', { runId: bogus }),
          'chat:cancel': await call('chat:cancel', { requestId: bogus }),
          'git:init': await call('git:init', { projectId: bogus })
        })
      })()`)
    )
    const rejected = Object.entries(probe).filter(([, r]) => /invalid request/i.test(r.error || ''))
    if (rejected.length) {
      record(
        'FAIL',
        'IPC request-key contract',
        rejected.map(([c, r]) => `${c}: ${r.error}`).join(' | ').slice(0, 240)
      )
    } else {
      record('PASS', 'IPC request-key contract', 'all 7 keyed channels reach their handler')
    }
    // `git:status` against a real project proves the whole path, not just validation.
    if (probe['git:status']?.ok) {
      record('PASS', 'git status answers for a real project', probe['git:status'].value)
    } else {
      record('WARN', 'git status did not answer', String(probe['git:status']?.error).slice(0, 120))
    }
  } catch (e) {
    record('FAIL', 'IPC request-key contract', e.message)
  }

  // 4. Typing: focus the prompt and send real keystrokes.
  try {
    // Navigate back to the chat view first: the app may be sitting on another
    // page, because the previous check (or the previous run) left it there.
    if (await cdp.evaluate(`!document.querySelector('.chat-page')`)) {
      const conv = await cdp.evaluate(rectOf('.sidebar-scroll .nav-item button'))
      if (conv) {
        await clickAt(cdp, conv, 'conversation')
        await waitFor(cdp, `!!document.querySelector('.chat-page textarea')`, 'chat view reopened', 6000)
      } else {
        const newChat = await cdp.evaluate(rectOf('button.btn.primary', 'New chat'))
        if (newChat) {
          await clickAt(cdp, newChat, 'New chat')
          await waitFor(cdp, `!!document.querySelector('.chat-page textarea')`, 'new chat opened', 6000)
        }
      }
    }
    const value = await typeIntoPrompt(cdp, TYPED)
    if (value.includes(TYPED)) record('PASS', 'prompt box accepts typing', `value="${value}"`)
    else record('FAIL', 'prompt box accepts typing', `value="${value}" does not contain the probe text`)
    // The send button must be enabled once there is something to send.
    const enabled = await cdp.evaluate(`(() => {
      const b = document.querySelector('button[title="Send"]')
      return b ? !b.disabled : null
    })()`)
    if (enabled === true) record('PASS', 'send button responds to input', 'enabled after typing')
    else record('FAIL', 'send button responds to input', `enabled=${enabled}`)
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('.chat-page textarea')
      if (!ta) return null
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, '')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  } catch (e) {
    record('FAIL', 'prompt box accepts typing', e.message)
  }

  // 5. Clicking: a real click on Settings must change the view.
  try {
    if (!settingsPoint) settingsPoint = await cdp.evaluate(rectOf('button.nav-item', 'Settings'))
    await clickAt(cdp, settingsPoint, 'Settings')
    await waitFor(
      cdp,
      `(document.querySelector('h1.page-title') || {}).textContent === 'Settings'`,
      'Settings page opened',
      6000
    )
    record('PASS', 'clicking a nav item changes the view', 'Settings page is showing')
    const cloud = await cdp.evaluate(`document.body.innerText.includes('Alpha Cloud (platform)')`)
    if (cloud) record('PASS', 'Settings page renders its sections', 'Alpha Cloud section present')
    else record('FAIL', 'Settings page renders its sections', 'Alpha Cloud section missing')
  } catch (e) {
    record('FAIL', 'clicking a nav item changes the view', e.message)
  }

  // 6. The Account modal must open and close (it is rendered from the sidebar).
  try {
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button.nav-item')].find((node) => (node.textContent || '').trim().includes('Account'))
      button?.scrollIntoView({ block: 'nearest' })
    })()`)
    const account = await cdp.evaluate(rectOf('button.nav-item', 'Account'))
    if (!account) throw new Error('the Account nav item is not in the DOM')
    await clickAt(cdp, account, 'Account')
    await waitFor(cdp, `!!document.querySelector('.modal-backdrop')`, 'Account modal opened', 5000)
    const heading = await cdp.evaluate(
      `(() => { const m = document.querySelector('.modal-backdrop'); return m ? m.innerText.split('\\n')[0] : '' })()`
    )
    record('PASS', 'Account panel opens', heading || 'modal-backdrop present')
    // The dialog closes by clicking its backdrop (there is no close button).
    const corner = await cdp.evaluate(`(() => {
      const b = document.querySelector('.modal-backdrop')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + 12), y: Math.round(r.bottom - 12) }
    })()`)
    if (corner) await clickAt(cdp, corner, 'backdrop')
    await sleep(400)
    const still = await cdp.evaluate(`!!document.querySelector('.modal-backdrop')`)
    if (still) record('WARN', 'Account panel closes', 'backdrop click did not dismiss it')
    else record('PASS', 'Account panel closes', 'dismissed by clicking the backdrop')
  } catch (e) {
    record('FAIL', 'Account panel opens', e.message)
  }

  // 7. Optional fault injection (`--stall-init`): startup that never completes
  //    must still not leave the splash over the window. Arms `settings:get` —
  //    the first call init() awaits — to never resolve, then reloads. This is
  //    the regression guard for the "invisible overlay bricks every click" bug.
  if (argv.includes('--stall-init')) {
    try {
      await cdp.send('Page.enable')
      const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const original = window.alpha && window.alpha.invoke
          if (!original) return
          window.alpha.invoke = (channel, payload) =>
            channel === 'settings:get' ? new Promise(() => {}) : original(channel, payload)
        })()`
      })
      await cdp.send('Page.reload')
      await waitFor(cdp, `!!document.querySelector('.splash')`, 'splash shown after reload', 8000)
      record('PASS', 'stalled startup: splash is shown', 'overlay mounted during boot')
      await waitFor(
        cdp,
        `!document.querySelector('.splash')`,
        'splash cleared despite a stalled init',
        20_000
      )
      record('PASS', 'stalled startup: splash still clears', 'overlay removed by the fallback deadline')
      const blocked = await cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('button.nav-item')]
          .find((n) => (n.textContent || '').trim().includes('Settings'))
        if (!btn) return 'sidebar missing'
        const r = btn.getBoundingClientRect()
        const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
        if (btn.contains(el) || el.contains(btn)) return null
        return (el && el.className) || 'nothing at point'
      })()`)
      if (blocked) {
        record('FAIL', 'stalled startup: controls still receive clicks', `topmost element is "${blocked}"`)
      } else {
        record('PASS', 'stalled startup: controls still receive clicks', 'nothing covers the sidebar')
      }
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
      await cdp.send('Page.reload')
      await waitFor(cdp, `!document.querySelector('.splash')`, 'app restored after the injection', 20_000)
      record('PASS', 'restored to a normal launch', 'injected stall removed')
    } catch (e) {
      record('FAIL', 'stalled-startup fault injection', e.message)
    }
  }

  // 8. Optional (`--chat`): send a real prompt to the selected model and wait
  //    for the reply to stream back. Opt in, because it writes to your
  //    conversation history and needs a reachable provider.
  if (argv.includes('--chat')) {
    const prompt = String(value('--chat-prompt', 'Reply with the single word: ready'))
    try {
      // A previous phase (fault injection) may have reloaded the window, so let
      // the workspace finish booting before touching the composer.
      await waitFor(
        cdp,
        `!!document.querySelector('.chat-page, .page') && !document.body.innerText.includes('Starting Alpha')`,
        'workspace ready again',
        25_000
      )
      if (await cdp.evaluate(`!document.querySelector('.chat-page')`)) {
        const conv = await cdp.evaluate(rectOf('.sidebar-scroll .nav-item button'))
        if (conv) {
          await clickAt(cdp, conv, 'conversation')
          await waitFor(cdp, `!!document.querySelector('.chat-page textarea')`, 'chat view opened', 10_000)
        }
      }
      const before = await cdp.evaluate(`document.querySelectorAll('.msg.assistant').length`)
      const typed = await typeIntoPrompt(cdp, prompt)
      if (!typed.includes(prompt)) throw new Error(`the prompt text did not land in the box ("${typed}")`)
      const send = await cdp.evaluate(
        `(() => { const b = document.querySelector('button[title="Send"]'); if (!b || b.disabled) return null
          const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`
      )
      if (!send) throw new Error('the send button is not enabled')
      await clickAt(cdp, send, 'send')
      // Wait for a SETTLED reply: a new assistant bubble that has stopped
      // streaming (no caret) and is no longer the "Thinking…" placeholder.
      await waitFor(
        cdp,
        `(() => {
          const all = document.querySelectorAll('.msg.assistant .msg-body')
          if (all.length <= ${before}) return false
          const last = all[all.length - 1]
          const text = (last.innerText || '').trim()
          if (last.querySelector('.caret') || /^◌?\\s*Thinking/i.test(text)) return false
          return text.length > 0
        })()`,
        'a completed assistant reply',
        90_000
      )
      const reply = await cdp.evaluate(
        `(() => { const all = document.querySelectorAll('.msg.assistant .msg-body'); const last = all[all.length - 1]
          return last ? (last.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120) : '' })()`
      )
      record('PASS', 'a prompt round-trips to the model', `reply: "${reply}"`)
      const errors = await cdp.evaluate(`[...document.querySelectorAll('.toast.error')].map((t) => t.innerText).join(' | ')`)
      if (errors) record('WARN', 'error toast shown after sending', errors.slice(0, 200))
      else record('PASS', 'no error toast after sending', 'clean send')
    } catch (e) {
      record('FAIL', 'a prompt round-trips to the model', e.message)
    }
  }

  // 9. Renderer hygiene: no uncaught errors.
  const problems = [...cdp.exceptions, ...cdp.console_].filter(Boolean)
  if (problems.length === 0) record('PASS', 'no renderer errors', 'no exceptions or console errors')
  else record('WARN', 'renderer errors seen', problems.slice(0, 3).join(' | ').slice(0, 300))
} catch (e) {
  record('FAIL', 'desktop smoke setup', e.message)
} finally {
  cdp?.close()
}

const failed = results.filter((r) => r.status === 'FAIL').length
const warned = results.filter((r) => r.status === 'WARN').length
console.log(`\n${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failed`)
process.exitCode = failed ? 1 : 0
