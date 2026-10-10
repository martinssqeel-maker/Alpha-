import fs from 'node:fs'
import path from 'node:path'
import { getLogger } from './logger'

export interface Cipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(payload: string): string
}

/** Fallback cipher used only when the OS secure store is unavailable. */
export class ObfuscationCipher implements Cipher {
  available(): boolean {
    return true
  }
  encrypt(plain: string): string {
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64')
  }
  decrypt(payload: string): string {
    if (payload.startsWith('b64:')) {
      return Buffer.from(payload.slice(4), 'base64').toString('utf8')
    }
    return payload
  }
}

export class SecretStore {
  private filePath: string
  private cipher: Cipher
  private cache: Record<string, string> = {}
  private secure: boolean

  constructor(filePath: string, cipher: Cipher) {
    this.filePath = filePath
    this.cipher = cipher
    this.secure = cipher.available()
    if (!this.secure) {
      getLogger().warn(
        'secrets',
        'OS secure storage unavailable; secrets are stored obfuscated, not encrypted'
      )
    }
    this.load()
  }

  get usesSecureStorage(): boolean {
    return this.secure
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      }
    } catch (e) {
      getLogger().error('secrets', `failed to load secret store: ${String(e)}`)
      this.cache = {}
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache))
    } catch (e) {
      getLogger().error('secrets', `failed to persist secret store: ${String(e)}`)
    }
  }

  set(ref: string, value: string): void {
    if (!value) {
      this.delete(ref)
      return
    }
    this.cache[ref] = this.cipher.encrypt(value)
    this.persist()
  }

  get(ref: string): string | null {
    const stored = this.cache[ref]
    if (!stored) return null
    try {
      return this.cipher.decrypt(stored)
    } catch (e) {
      getLogger().error('secrets', `failed to decrypt ${ref}: ${String(e)}`)
      return null
    }
  }

  has(ref: string): boolean {
    return Boolean(this.cache[ref])
  }

  delete(ref: string): void {
    delete this.cache[ref]
    this.persist()
  }

  clear(): void {
    this.cache = {}
    this.persist()
  }
}
