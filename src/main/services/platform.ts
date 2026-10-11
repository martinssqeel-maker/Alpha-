import type { AppSettings, PlatformConfig, PlatformStatus } from '@shared/types'
import type { Logger } from './logger'
import type { SecretStore } from './secrets'
import type { SettingsRepo } from './store'

/**
 * Persistent store for the Alpha Cloud session (access + refresh tokens). Backed
 * by the encrypted SecretStore (OS DPAPI), so session tokens are at rest
 * encrypted, never written to app settings / logs.
 */
export class EncryptedSessionStorage {
  private memory = new Map<string, string>()

  constructor(private secrets: SecretStore, private readKey = 'platform:session-store') {
    const raw = secrets.get(readKey)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, string>
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') this.memory.set(k, v)
      } catch {
        secrets.delete(readKey)
      }
    }
  }

  async getItem(key: string): Promise<string | null> {
    return this.memory.get(key) ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.memory.set(key, value)
    this.flush()
  }

  async removeItem(key: string): Promise<void> {
    this.memory.delete(key)
    this.flush()
  }

  private flush(): void {
    this.secrets.set(this.readKey, JSON.stringify(Object.fromEntries(this.memory)))
  }
}

export interface PlatformServiceOptions {
  settings: SettingsRepo
  secrets: SecretStore
  logger: Logger
  onStatus: (status: PlatformStatus) => void
  onActiveChange: (active: boolean) => void
}

export interface DeepLinkParams {
  access_token?: string
  refresh_token?: string
  token?: string
  email?: string
  code?: string
  type?: string
  error?: string
  error_description?: string
}

interface StoredSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
}

const SESSION_KEY = 'alpha-session'
const EXPIRY_SKEW_MS = 60_000

/** Parse an alpha:// auth callback URL (fragment or query token pairs). */
export function parseDeepLink(rawUrl: string): DeepLinkParams {
  const out: DeepLinkParams = {}
  try {
    const u = new URL(rawUrl)
    const pairs = [
      ...new URLSearchParams(u.hash.startsWith('#') ? u.hash.slice(1) : u.hash).entries(),
      ...new URLSearchParams(u.search).entries()
    ]
    for (const [k, v] of pairs) {
      const key = k as keyof DeepLinkParams
      if (typeof out[key] !== 'string') out[key] = v
    }
  } catch {
    // Non-URL deep links (e.g. alpha://x#a=b without host) still parse via URLSearchParams.
    const hashIdx = rawUrl.indexOf('#')
    const fragment = hashIdx >= 0 ? rawUrl.slice(hashIdx + 1) : ''
    for (const [k, v] of new URLSearchParams(fragment).entries()) {
      const key = k as keyof DeepLinkParams
      if (typeof out[key] !== 'string') out[key] = v
    }
  }
  return out
}

export class PlatformService {
  private storage: EncryptedSessionStorage
  private session: StoredSession | null = null
  private cached: PlatformStatus = {
    enabled: false,
    configured: false,
    authenticated: false,
    config: null
  }
  private refreshInFlight: Promise<PlatformStatus> | null = null

  constructor(private opts: PlatformServiceOptions) {
    this.storage = new EncryptedSessionStorage(opts.secrets)
  }

  /** Restore any persisted session and report the initial status (no network). */
  async restore(): Promise<void> {
    const cfg = this.platformSettings()
    this.session = await this.loadSession()
    this.cached = {
      ...this.cached,
      enabled: cfg.enabled,
      configured: this.isConfigured(),
      authenticated: Boolean(this.session),
      email: this.session?.email
    }
    this.bump()
    this.opts.onActiveChange(this.isActive())
    void this.refresh()
  }

  config(): PlatformConfig | null {
    return this.cached.config
  }

  /**
   * Current status. `enabled` / `configured` are always derived from the live
   * settings, because the platform can be turned on or re-pointed from
   * Settings while the app is running; the cached snapshot is only authoritative
   * for session/entitlement fields, which come from the network.
   */
  status(): PlatformStatus {
    const enabled = this.platformSettings().enabled
    const configured = this.isConfigured()
    return {
      ...this.cached,
      enabled,
      configured,
      authenticated: configured ? this.cached.authenticated : false
    }
  }

  isActive(): boolean {
    return this.isConfigured() && this.cached.authenticated
  }

  platformSettings(): AppSettings['platform'] {
    return this.opts.settings.get().platform
  }

  /** Base URL of the Alpha Cloud API (Neon Function), trailing slashes trimmed. */
  apiBaseUrl(): string {
    return this.platformSettings().apiBaseUrl.trim().replace(/\/+$/, '')
  }

  authScheme(): string {
    return (this.platformSettings().authRedirectScheme || 'alpha').replace(/:\/\/+$/, '')
  }

  private isConfigured(): boolean {
    return this.platformSettings().enabled && Boolean(this.apiBaseUrl())
  }

  private ensureConfigured(): boolean {
    return this.isConfigured()
  }

  /** Return a valid access token, refreshing the session when it is near expiry. */
  async getAccessToken(): Promise<string | null> {
    if (!this.isActive()) return null
    if (!this.session) return null
    if (this.session.expiresAt - EXPIRY_SKEW_MS > Date.now()) return this.session.accessToken
    const refreshed = await this.refreshSession().catch(() => null)
    return refreshed?.accessToken ?? null
  }

  async signIn(email: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.ensureConfigured()) {
      return { ok: false, message: 'Alpha Cloud is not configured. Set the API base URL in Settings → Platform.' }
    }
    try {
      const res = await this.request('/auth/request', { method: 'POST', body: { email } })
      const data = (res.body ?? {}) as { message?: string }
      this.bump({ pendingSignIn: true })
      return { ok: true, message: data.message ?? `A sign-in link was sent to ${email}. Open it to continue.` }
    } catch (e) {
      return { ok: false, message: friendlyAuthError((e as Error).message) }
    }
  }

  /** Handle an alpha://auth/callback deep link launched from the system browser. */
  async handleRedirectUrl(rawUrl: string): Promise<void> {
    const params = parseDeepLink(rawUrl)
    this.opts.logger.info('platform', 'auth callback received')
    if (params.error) {
      this.bump({ pendingSignIn: false, error: params.error_description ?? params.error })
      return
    }
    if (!this.ensureConfigured()) return
    try {
      if (params.access_token && params.refresh_token) {
        await this.storeSession({
          accessToken: params.access_token,
          refreshToken: params.refresh_token,
          expiresAt: Date.now() + 5 * 60_000,
          email: params.email
        })
      } else if (params.token) {
        const res = await this.request('/auth/verify', { method: 'POST', body: { token: params.token } })
        await this.adoptAuthResponse(res.body)
      } else if (params.email && params.code) {
        const res = await this.request('/auth/verify', {
          method: 'POST',
          body: { email: params.email, code: params.code }
        })
        await this.adoptAuthResponse(res.body)
      } else {
        this.bump({ pendingSignIn: false, error: 'The sign-in link was missing its verification data.' })
        return
      }
      this.bump({ pendingSignIn: false, error: undefined })
      await this.refresh()
    } catch (e) {
      this.bump({ pendingSignIn: false, error: friendlyAuthError((e as Error).message) })
    }
  }

  async signOut(): Promise<void> {
    if (this.session) {
      await this.request('/auth/signout', { method: 'POST', token: this.session.accessToken }).catch(() => undefined)
    }
    await this.clearSession()
    this.cached = { ...this.cached, authenticated: false, email: undefined, config: null }
    this.bump()
    this.opts.onActiveChange(false)
  }

  /** Fetch the authoritative platform config (entitlements, limits, usage, models). */
  refresh(): Promise<PlatformStatus> {
    if (this.refreshInFlight) return this.refreshInFlight
    const run = (async () => {
      const cfg = this.platformSettings()
      if (!this.ensureConfigured()) {
        this.cached = { enabled: cfg.enabled, configured: false, authenticated: false, config: null }
        this.bump()
        return this.cached
      }
      const token = await this.getAccessToken()
      if (!this.isActive() && !token) {
        this.cached = {
          ...this.cached,
          enabled: cfg.enabled,
          configured: true,
          authenticated: false,
          email: undefined,
          config: null
        }
        this.bump()
        this.opts.onActiveChange(false)
        return this.cached
      }
      try {
        const data = await this.fetchConfig(token)
        this.cached = {
          enabled: cfg.enabled,
          configured: true,
          authenticated: true,
          email: this.session?.email,
          config: (data ?? null) as PlatformConfig | null,
          error: undefined,
          lastUpdatedAt: Date.now()
        }
        void this.registerDevice()
      } catch (e) {
        const err = e as Error
        if (err.name === 'Unauthorized') {
          const session = await this.refreshSession().catch(() => null)
          if (session) {
            try {
              const data = await this.fetchConfig(session.accessToken)
              this.cached = {
                enabled: cfg.enabled,
                configured: true,
                authenticated: true,
                email: session.email,
                config: (data ?? null) as PlatformConfig | null,
                error: undefined,
                lastUpdatedAt: Date.now()
              }
              void this.registerDevice()
              this.bump()
              this.opts.onActiveChange(true)
              return this.cached
            } catch {
              /* fall through to signed-out */
            }
          }
          await this.clearSession()
          this.cached = { ...this.cached, configured: true, authenticated: false, email: undefined, config: null }
        } else {
          this.cached = {
            ...this.cached,
            authenticated: true,
            email: this.session?.email,
            config: null,
            error: friendlyAuthError(err.message)
          }
        }
      }
      this.bump()
      const active = this.isActive()
      this.opts.onActiveChange(active)
      return this.cached
    })()
    this.refreshInFlight = run
    void run.finally(() => {
      this.refreshInFlight = null
    })
    return run
  }

  private async fetchConfig(token: string | null): Promise<PlatformConfig | null> {
    const res = await this.request('/platform/config', { token: token ?? undefined })
    return (res.body ?? null) as PlatformConfig | null
  }

  private async registerDevice(): Promise<void> {
    const token = await this.getAccessToken()
    if (!token) return
    await this.request('/platform/device', {
      method: 'POST',
      token,
      body: { platform: 'windows', appVersion: pkgVersion() }
    }).catch(() => undefined)
  }

  private async refreshSession(): Promise<StoredSession | null> {
    if (!this.session) return null
    if (!this.ensureConfigured()) return null
    try {
      const res = await this.request('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: this.session.refreshToken }
      })
      return await this.adoptAuthResponse(res.body)
    } catch {
      return null
    }
  }

  private async adoptAuthResponse(body: unknown): Promise<StoredSession> {
    const data = (body ?? {}) as {
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
      email?: string
    }
    if (!data.accessToken || !data.refreshToken) {
      throw new Error('The sign-in response was missing its session tokens.')
    }
    return this.storeSession({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : Date.now() + 5 * 60_000,
      email: data.email
    })
  }

  private async storeSession(session: StoredSession): Promise<StoredSession> {
    this.session = session
    await this.storage.setItem(SESSION_KEY, JSON.stringify(session))
    this.cached = {
      ...this.cached,
      configured: true,
      authenticated: true,
      email: session.email
    }
    this.bump()
    this.opts.onActiveChange(true)
    return session
  }

  private async clearSession(): Promise<void> {
    this.session = null
    await this.storage.removeItem(SESSION_KEY)
  }

  private async loadSession(): Promise<StoredSession | null> {
    const raw = await this.storage.getItem(SESSION_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as StoredSession
      if (!parsed?.accessToken || !parsed?.refreshToken) return null
      return parsed
    } catch {
      await this.storage.removeItem(SESSION_KEY)
      return null
    }
  }

  private async request(
    path: string,
    opts: { method?: string; body?: unknown; token?: string } = {}
  ): Promise<{ status: number; body: unknown }> {
    const base = this.apiBaseUrl()
    if (!base) throw new Error('Alpha Cloud is not configured.')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      })
    } catch (e) {
      throw new Error(`Could not reach Alpha Cloud: ${(e as Error).message}`)
    }
    let body: unknown = null
    const text = await res.text().catch(() => '')
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    if (!res.ok) {
      const err = (body as { error?: { message?: string } } | null)?.error
      const message = err?.message ?? `Request failed (${res.status}).`
      const failure = new Error(message)
      failure.name = res.status === 401 || res.status === 403 ? 'Unauthorized' : 'RequestError'
      throw failure
    }
    return { status: res.status, body }
  }

  private bump(patch: Partial<PlatformStatus> = {}): void {
    this.cached = { ...this.cached, ...patch }
    try {
      this.opts.onStatus(this.cached)
    } catch {
      /* ignore */
    }
  }
}

function pkgVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('not confirmed')) return 'This email is not confirmed yet. Check your inbox.'
  if (m.includes('invalid login') || m.includes('invalid or has expired') || m.includes('expired')) {
    return 'The sign-in link is invalid or has expired. Request a new one.'
  }
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Try again in a minute.'
  if (m.includes('user already registered')) return 'This email is already registered. Sign in instead.'
  return message
}

export function toStatusSkeleton(enabled: boolean): PlatformStatus {
  return { enabled, configured: false, authenticated: false, config: null }
}
