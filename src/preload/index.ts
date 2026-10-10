import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@shared/channels'

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
