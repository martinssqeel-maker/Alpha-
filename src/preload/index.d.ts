export interface AlphaBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  subscribe(channel: string, cb: (data: unknown) => void): () => void
}

declare global {
  interface Window {
    alpha: AlphaBridge
  }
}

export {}
