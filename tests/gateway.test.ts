import { describe, expect, it } from 'vitest'
import { parseGatewaySseLine } from '../src/main/services/providers/gateway'

describe('gateway SSE parsing', () => {
  it('extracts a content delta', () => {
    const ev = parseGatewaySseLine('data: {"choices":[{"delta":{"content":"Hello"}}]}')
    expect(ev?.kind).toBe('delta')
    expect(ev?.delta?.content).toBe('Hello')
  })

  it('extracts a reasoning/thinking delta', () => {
    const ev = parseGatewaySseLine('data: {"choices":[{"delta":{"reasoning":"hmm"}}]}')
    expect(ev?.delta?.thinking).toBe('hmm')
  })

  it('recognises the terminator', () => {
    expect(parseGatewaySseLine('data: [DONE]')?.kind).toBe('done')
  })

  it('carries usage and finish_reason', () => {
    const ev = parseGatewaySseLine(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}'
    )
    expect(ev?.finishReason).toBe('stop')
    expect(ev?.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 })
  })

  it('surfaces a structured error', () => {
    const ev = parseGatewaySseLine('data: {"error":{"code":"rate_limited","message":"Slow down"}}')
    expect(ev?.kind).toBe('error')
    expect(ev?.error?.code).toBe('rate_limited')
    expect(ev?.error?.message).toBe('Slow down')
  })

  it('accepts lines without the data: prefix', () => {
    expect(parseGatewaySseLine('{"choices":[{"delta":{"content":"x"}}]}')?.delta?.content).toBe('x')
  })

  it('parses streaming tool-call deltas', () => {
    const start = parseGatewaySseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}'
    )
    expect(start?.toolCalls?.[0]).toEqual({ index: 0, id: 'call_1', name: 'read_file', arguments: '' })

    const args = parseGatewaySseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}'
    )
    expect(args?.toolCalls?.[0]).toEqual({ index: 0, id: undefined, name: undefined, arguments: '{"path":' })
  })

  it('ignores blanks and non-JSON noise', () => {
    expect(parseGatewaySseLine('')).toBeNull()
    expect(parseGatewaySseLine(': keepalive')).toBeNull()
    expect(parseGatewaySseLine('data: not-json')).toBeNull()
  })
})