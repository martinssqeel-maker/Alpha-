import fs from 'node:fs'
import path from 'node:path'
import type {
  GithubDevicePollResult,
  GithubDevicePollStatus,
  GithubDeviceStartResult
} from '@shared/types'
import { getLogger } from './logger'
import type { SecretStore } from './secrets'

/**
 * GitHub Device Flow authentication for the desktop app.
 *
 * Why Device Flow and not the browser/loopback authorization-code flow:
 * GitHub's OAuth App docs mark `client_secret` REQUIRED for the web-flow token
 * exchange, and a GitHub maintainer has confirmed there is "no movement towards
 * removing the client secret requirement" (github.blog PKCE changelog, 2025-07).
 * A client secret embedded in a distributed desktop binary is not confidential
 * (RFC 8252), so shipping one would be fake security. Device Flow is the only
 * GitHub-documented flow that needs no client secret, and it still supports
 * expiring access tokens with a secretless refresh grant (GitHub: "client_secret
 * … Required unless the token was generated using the device flow").
 *
 * Device Flow does NOT use PKCE and has no `state`/redirect (the device-code
 * flow is explicitly PKCE-less per GitHub's changelog). The security comes from
 * the short-lived single-use device code plus the user explicitly approving in
 * their own browser on github.com/login/device. We therefore do not generate a
 * PKCE verifier or a state value here — they are not part of this flow.
 *
 * The resulting access token is stored under the SAME `github:token` secret ref
 * the existing PAT/CLI path uses, so `GithubService` (status / repos / create)
 * keeps working untouched. Refresh/expiry metadata is stored under `github:oauth:*`.
 */

const ACCESS_TOKEN_REF = 'github:token'
const REFRESH_TOKEN_REF = 'github:oauth:refresh'
const EXPIRES_AT_REF = 'github:oauth:expires'
const METHOD_REF = 'github:oauth:method'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'

const DEFAULT_SCOPE = 'repo'
const EXPIRY_SKEW_MS = 60_000

/**
 * Result types live in `@shared/types` so the IPC contract can reference them
 * without importing from the main process. These aliases keep main-process call
 * sites readable and single-sourced.
 */
export type DeviceStartResult = GithubDeviceStartResult
export type DevicePollStatus = GithubDevicePollStatus
export type DevicePollResult = GithubDevicePollResult

interface PendingDevice {
  deviceCode: string
  interval: number
  expiresAt: number
  verificationUri: string
}

export interface GithubOAuthOptions {
  secrets: SecretStore
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable for tests. Defaults to env-var / config-file lookup. */
  getClientId?: () => string | null
  getScope?: () => string
  /** Extra config-file paths to search before the built-in ones. */
  configPaths?: string[]
}

/**
 * Read the public OAuth Client ID from an environment variable or a config file.
 * The Client ID is a public identifier (safe to ship), but it is deliberately
 * NOT committed here; operators provide it locally or in packaging resources.
 *
 * Lookup order:
 *   1. `GITHUB_OAUTH_CLIENT_ID`
 *   2. any explicit `extraPaths`
 *   3. `GITHUB_OAUTH_CONFIG` (path to a JSON file)
 *   4. `<cwd>/github-oauth.json` (development)
 *   5. `<resourcesPath>/github-oauth.json` (packaged app, electron-builder extraResources)
 */
export function loadClientId(
  env: NodeJS.ProcessEnv = process.env,
  extraPaths: string[] = [],
  cwd: string = process.cwd(),
  resourcesPath: string = process.resourcesPath ?? ''
): string | null {
  const fromEnv = (env.GITHUB_OAUTH_CLIENT_ID ?? '').trim()
  if (fromEnv) return fromEnv

  const candidates = [
    ...extraPaths,
    env.GITHUB_OAUTH_CONFIG,
    cwd ? path.resolve(cwd, 'github-oauth.json') : undefined,
    resourcesPath ? path.join(resourcesPath, 'github-oauth.json') : undefined
  ].filter((p): p is string => Boolean(p))

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { clientId?: unknown }
      if (typeof parsed.clientId === 'string' && parsed.clientId.trim()) {
        return parsed.clientId.trim()
      }
    } catch {
      /* unreadable/malformed config is ignored; the env var or a fixed file can override */
    }
  }
  return null
}

function loadScope(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GITHUB_OAUTH_SCOPE ?? '').trim() || DEFAULT_SCOPE
}

export class GitHubOAuthService {
  private secrets: SecretStore
  private fetchImpl: typeof fetch
  private getClientId: () => string | null
  private getScope: () => string
  private pending: PendingDevice | null = null

  constructor(opts: GithubOAuthOptions) {
    this.secrets = opts.secrets
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.getClientId = opts.getClientId ?? (() => loadClientId(process.env, opts.configPaths ?? []))
    this.getScope = opts.getScope ?? (() => loadScope())
  }

  /** True when an OAuth Client ID is configured (env or config file). */
  isConfigured(): boolean {
    return Boolean(this.getClientId())
  }

  /** True when the stored `github:token` came from Device Flow (not a PAT/CLI). */
  isSession(): boolean {
    return this.secrets.get(METHOD_REF) === 'device'
  }

  /** Begin Device Flow. Returns the user code + verification URL to display. */
  async startDeviceFlow(): Promise<DeviceStartResult> {
    const clientId = this.getClientId()
    if (!clientId) {
      return {
        ok: false,
        message:
          'GitHub sign-in is not configured. Set GITHUB_OAUTH_CLIENT_ID or add a github-oauth.json with a clientId.'
      }
    }
    if (this.pending) {
      // A flow is already active; return it rather than burning a new code.
      return {
        ok: true,
        userCode: undefined,
        verificationUri: this.pending.verificationUri,
        interval: this.pending.interval,
        expiresIn: Math.max(0, Math.ceil((this.pending.expiresAt - Date.now()) / 1000))
      }
    }

    let res: Response
    try {
      res = await this.fetchImpl(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope: this.getScope() }).toString(),
        signal: AbortSignal.timeout(20_000)
      })
    } catch (e) {
      return { ok: false, message: `Could not reach GitHub to start sign-in: ${(e as Error).message}` }
    }

    let body: Record<string, unknown>
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (!res.ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
      const err = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
      getLogger().warn('github-oauth', `device code request failed: ${err}`)
      return { ok: false, message: `GitHub sign-in could not start (${err}).` }
    }

    const deviceCode = body.device_code as string
    const userCode = body.user_code as string
    const verificationUri =
      typeof body.verification_uri === 'string' ? body.verification_uri : 'https://github.com/login/device'
    const interval = typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 900

    this.pending = {
      deviceCode,
      interval,
      expiresAt: Date.now() + expiresIn * 1000,
      verificationUri
    }
    getLogger().info('github-oauth', 'device flow started')
    return { ok: true, userCode, verificationUri, interval, expiresIn }
  }

  /** Re-open the GitHub verification page in the default browser. */
  openVerification(): { ok: boolean; message?: string } {
    if (!this.pending) return { ok: false, message: 'No sign-in is in progress.' }
    return { ok: true, message: this.pending.verificationUri }
  }

  /** Current verification URL for the in-progress flow, if any. */
  verificationUri(): string | null {
    return this.pending?.verificationUri ?? null
  }

  /**
   * Perform a single Device Flow token poll. Never blocks the app: the renderer
   * schedules these at the interval GitHub returned. Returns a status the UI maps
   * to progress / success / cancellation / timeout.
   */
  async pollOnce(): Promise<DevicePollResult> {
    const clientId = this.getClientId()
    const pending = this.pending
    if (!clientId) return { status: 'error', message: 'GitHub sign-in is not configured.' }
    if (!pending) return { status: 'error', message: 'No sign-in is in progress.' }
    if (Date.now() >= pending.expiresAt) {
      this.pending = null
      return { status: 'expired', message: 'The sign-in code expired. Start again.' }
    }

    let res: Response
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: pending.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        }).toString(),
        signal: AbortSignal.timeout(20_000)
      })
    } catch (e) {
      return { status: 'error', message: `Could not reach GitHub: ${(e as Error).message}`, interval: pending.interval }
    }

    let body: Record<string, unknown>
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      body = {}
    }

    const error = typeof body.error === 'string' ? body.error : ''
    if (error === 'authorization_pending') return { status: 'pending', interval: pending.interval }
    if (error === 'slow_down') {
      pending.interval += 5
      return { status: 'slow_down', interval: pending.interval }
    }
    if (error === 'access_denied') {
      this.pending = null
      return { status: 'denied', message: 'You declined the sign-in request in the browser.' }
    }
    if (error === 'expired_token') {
      this.pending = null
      return { status: 'expired', message: 'The sign-in code expired. Start again.' }
    }

    const accessToken = typeof body.access_token === 'string' ? body.access_token : null
    if (!accessToken) {
      const desc = typeof body.error_description === 'string' ? body.error_description : `HTTP ${res.status}`
      getLogger().warn('github-oauth', `token poll returned no token: ${error || desc}`)
      this.pending = null
      return { status: 'error', message: `Sign-in failed (${error || desc}).` }
    }

    // Persist. Access token reuses the existing ref so GithubService keeps working.
    this.secrets.set(ACCESS_TOKEN_REF, accessToken)
    this.secrets.set(METHOD_REF, 'device')
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null
    if (refreshToken) this.secrets.set(REFRESH_TOKEN_REF, refreshToken)
    if (typeof body.expires_in === 'number') {
      this.secrets.set(EXPIRES_AT_REF, String(Date.now() + (body.expires_in as number) * 1000))
    } else {
      this.secrets.delete(EXPIRES_AT_REF)
    }
    this.pending = null

    const login = await this.fetchLogin(accessToken)
    getLogger().info('github-oauth', `device flow completed as ${login ?? 'unknown'}`)
    return { status: 'success', login: login ?? undefined, interval: pending.interval }
  }

  /** Abandon any in-progress sign-in (does not touch a completed session). */
  cancel(): void {
    if (this.pending) getLogger().info('github-oauth', 'device flow cancelled')
    this.pending = null
  }

  hasPending(): boolean {
    return Boolean(this.pending)
  }

  /** Access token for API calls, refreshing first when near expiry. */
  async getValidAccessToken(): Promise<string | null> {
    if (!this.isSession()) return null
    const token = this.secrets.get(ACCESS_TOKEN_REF)
    if (!token) return null
    const expiresAt = Number(this.secrets.get(EXPIRES_AT_REF) ?? 0)
    if (expiresAt && Date.now() >= expiresAt - EXPIRY_SKEW_MS) {
      const refreshed = await this.refresh().catch(() => false)
      if (!refreshed) {
        // Refresh failed (revoked/expired). Drop the session so status reports
        // signed-out and the user re-authorizes.
        this.logout()
        return null
      }
      return this.secrets.get(ACCESS_TOKEN_REF)
    }
    return token
  }

  /** Exchange the stored refresh token for a new access token (no client secret). */
  async refresh(): Promise<boolean> {
    const clientId = this.getClientId()
    const refreshToken = this.secrets.get(REFRESH_TOKEN_REF)
    if (!clientId || !refreshToken) return false
    let res: Response
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }).toString(),
        signal: AbortSignal.timeout(20_000)
      })
    } catch (e) {
      getLogger().warn('github-oauth', `refresh failed: ${(e as Error).message}`)
      return false
    }
    let body: Record<string, unknown>
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      body = {}
    }
    const accessToken = typeof body.access_token === 'string' ? body.access_token : null
    if (!accessToken) {
      getLogger().warn('github-oauth', `refresh rejected: ${typeof body.error === 'string' ? body.error : res.status}`)
      return false
    }
    this.secrets.set(ACCESS_TOKEN_REF, accessToken)
    const newRefresh = typeof body.refresh_token === 'string' ? body.refresh_token : null
    if (newRefresh) this.secrets.set(REFRESH_TOKEN_REF, newRefresh)
    if (typeof body.expires_in === 'number') {
      this.secrets.set(EXPIRES_AT_REF, String(Date.now() + (body.expires_in as number) * 1000))
    }
    getLogger().info('github-oauth', 'access token refreshed')
    return true
  }

  /** Remove the OAuth session (does not affect a separately-stored PAT). */
  logout(): void {
    this.secrets.delete(ACCESS_TOKEN_REF)
    this.secrets.delete(REFRESH_TOKEN_REF)
    this.secrets.delete(EXPIRES_AT_REF)
    this.secrets.delete(METHOD_REF)
  }

  private async fetchLogin(token: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(USER_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Alpha-AI-Workspace'
        },
        signal: AbortSignal.timeout(20_000)
      })
      if (!res.ok) return null
      const user = (await res.json()) as { login?: string }
      return typeof user.login === 'string' ? user.login : null
    } catch {
      return null
    }
  }
}
