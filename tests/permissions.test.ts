import { describe, it, expect } from 'vitest'
import {
  resolvePermission,
  permissionsForMode,
  DEFAULT_PERMISSIONS,
  CHAT_PERMISSIONS
} from '@shared/permissions'
import type { PermissionSettings } from '@shared/types'

describe('resolvePermission', () => {
  it('denies every mutating action in chat mode', () => {
    expect(resolvePermission(CHAT_PERMISSIONS, 'fileWrites')).toBe('deny')
    expect(resolvePermission(CHAT_PERMISSIONS, 'terminal')).toBe('deny')
    expect(resolvePermission(CHAT_PERMISSIONS, 'githubPush')).toBe('deny')
  })

  it('returns configured level in assist/agent modes', () => {
    const s: PermissionSettings = { ...DEFAULT_PERMISSIONS, mode: 'agent', terminal: 'allow' }
    expect(resolvePermission(s, 'terminal')).toBe('allow')
    expect(resolvePermission(s, 'fileWrites')).toBe('ask')
  })

  it('never resolves the mode key itself', () => {
    expect(resolvePermission(DEFAULT_PERMISSIONS, 'mode')).toBe('deny')
  })
})

describe('permissionsForMode', () => {
  it('applies mode defaults', () => {
    const agent = permissionsForMode('agent')
    expect(agent.mode).toBe('agent')
    expect(agent.fileWrites).toBe('allow')
    expect(agent.terminal).toBe('allow')
  })

  it('preserves user sensitiveFiles choice across mode switches', () => {
    const current: PermissionSettings = { ...DEFAULT_PERMISSIONS, sensitiveFiles: 'ask' }
    const next = permissionsForMode('agent', current)
    expect(next.sensitiveFiles).toBe('ask')
  })

  it('chat mode disables mutations', () => {
    const chat = permissionsForMode('chat')
    expect(chat.fileWrites).toBe('deny')
    expect(chat.mode).toBe('chat')
  })
})
