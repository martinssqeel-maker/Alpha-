import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@shared/channels'
import { RESOLVED_THEME_OPTIONS, THEME_TOKENS } from '@shared/theme'

// The main process passes the saved, resolved theme so the first renderer paint
// already matches its surfaces. Dark remains the CSS fallback if no value is set.
const themeArg = process.argv.find((arg) => arg.startsWith('--alpha-theme='))
const initialTheme = themeArg?.slice('--alpha-theme='.length)
const preloadDocument = (globalThis as typeof globalThis & {
  document?: {
    documentElement?: {
      dataset: Record<string, string>
      style: { colorScheme: string; setProperty(name: string, value: string): void }
    }
    addEventListener(type: 'DOMContentLoaded', listener: () => void, options: { once: true }): void
  }
}).document
if (initialTheme && RESOLVED_THEME_OPTIONS.includes(initialTheme as (typeof RESOLVED_THEME_OPTIONS)[number])) {
  const applyInitialTheme = (): void => {
    const root = preloadDocument?.documentElement
    if (!root) return
    root.dataset.theme = initialTheme
    root.style.colorScheme = initialTheme === 'light' ? 'light' : 'dark'
    for (const [token, value] of Object.entries(THEME_TOKENS[initialTheme as keyof typeof THEME_TOKENS])) {
      root.style.setProperty(token, value)
    }
  }
  if (preloadDocument?.documentElement) applyInitialTheme()
  else preloadDocument?.addEventListener('DOMContentLoaded', applyInitialTheme, { once: true })
}

const invokeSet = new Set<string>(INVOKE_CHANNELS)
const eventSet = new Set<string>(EVENT_CHANNELS)

const api = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  subscribe(channel: string, cb: (data: unknown) => void): () => void {
    if (!eventSet.has(channel)) {
      throw new Error(`Blocked event channel: ${channel}`)
    }
    const listener = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(channel, listener as never)
    return () => {
      ipcRenderer.removeListener(channel, listener as never)
    }
  }
}

contextBridge.exposeInMainWorld('alpha', api)
