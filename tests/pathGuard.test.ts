import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  safeResolve,
  isWithin,
  isSensitivePath,
  isGitInternal,
  isBinaryBuffer,
  detectLanguage,
  PathError
} from '@main/services/pathGuard'

const root = path.resolve('C:/projects/demo')

describe('safeResolve', () => {
  it('resolves relative paths inside the root', () => {
    const p = safeResolve(root, 'src/index.ts')
    expect(p).toBe(path.join(root, 'src', 'index.ts'))
  })

  it('rejects traversal escapes', () => {
    expect(() => safeResolve(root, '../secret.txt')).toThrow(PathError)
    expect(() => safeResolve(root, '../../etc/passwd')).toThrow(PathError)
  })

  // Windows-only: on POSIX `C:/Windows/system32` is not absolute, so it is just
  // a (legal) relative name under the root. The containment rule itself is the
  // same either way; the input only means "outside" on Windows.
  it.runIf(process.platform === 'win32')('rejects absolute paths outside the root', () => {
    expect(() => safeResolve(root, 'C:/Windows/system32')).toThrow(PathError)
  })

  it('rejects null bytes', () => {
    expect(() => safeResolve(root, 'a\u0000b')).toThrow(PathError)
  })

  it('allows the root itself', () => {
    expect(isWithin(root, root)).toBe(true)
  })

  it('rejects a sibling directory sharing a prefix', () => {
    expect(isWithin(root, path.resolve('C:/projects/demo-evil'))).toBe(false)
  })
})

describe('sensitive/git detection', () => {
  it('flags dotenv and keys', () => {
    expect(isSensitivePath('.env')).toBe(true)
    expect(isSensitivePath('config/.env.local')).toBe(true)
    expect(isSensitivePath('certs/server.pem')).toBe(true)
    expect(isSensitivePath('id_rsa')).toBe(true)
    expect(isSensitivePath('.aws/credentials')).toBe(true)
  })

  it('does not flag normal source files', () => {
    expect(isSensitivePath('src/app.ts')).toBe(false)
    expect(isSensitivePath('README.md')).toBe(false)
  })

  it('detects git internals', () => {
    expect(isGitInternal('.git/config')).toBe(true)
    expect(isGitInternal('.git')).toBe(true)
    expect(isGitInternal('src/gitignore.ts')).toBe(false)
  })
})

describe('byte-level helpers', () => {
  it('detects binary buffers by NUL byte', () => {
    expect(isBinaryBuffer(Buffer.from([1, 2, 3, 0, 4]))).toBe(true)
    expect(isBinaryBuffer(Buffer.from('hello world'))).toBe(false)
  })

  it('maps languages by extension', () => {
    expect(detectLanguage('a/b/main.ts')).toBe('typescript')
    expect(detectLanguage('x.unknown')).toBeUndefined()
  })
})
