import { contextBridge, ipcRenderer } from 'electron'
import { HUD } from '@shared/channels'
import type { HudState } from '@shared/types'

/**
 * Preload for the always-on-top control pill.
 *
 * Deliberately tiny: three actions and one state stream. The HUD can approve or
 * deny the pending action and can stop the agent, and it can do nothing else —
 * no settings, no filesystem, no model access.
 */
const api = {
  decide(approvalId: string, approved: boolean): void {
    ipcRenderer.send(HUD.decision, { approvalId, approved })
  },
  stop(): void {
    ipcRenderer.send(HUD.stop)
  },
  onState(cb: (state: HudState) => void): () => void {
    const listener = (_event: unknown, state: HudState): void => cb(state)
    ipcRenderer.on(HUD.state, listener as never)
    return () => {
      ipcRenderer.removeListener(HUD.state, listener as never)
    }
  }
}

contextBridge.exposeInMainWorld('alphaHud', api)

export type HudApi = typeof api
