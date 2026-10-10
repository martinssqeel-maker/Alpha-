import { describe, it, expect, vi, afterEach } from 'vitest'
import { OllamaAdapter } from '@main/services/providers/ollama'
import { OpenAICompatibleAdapter } from '@main/services/providers/openaiCompatible'
import { ProviderError } from '@main/services/providers/types'

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l))
      controller.close()
    }
  })
  return { ok: true, status: 200, body: stream, json: async () => ({}), text: async () => '' } as unknown as Response
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OllamaAdapter', () => {
  it('maps /api/tags into model info with capabilities', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        models: [
          {
            name: 'qwen2.5:3b',
            model: 'qwen2.5:3b',
            size: 1,
            details: { family: 'qwen2', parameter_size: '3B', context_length: 32768 },
            capabilities: ['completion', 'tools']
          }
        ]
      })
    )
    const models = await new OllamaAdapter().listModels('http://127.0.0.1:11434', null)
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('qwen2.5:3b')
    expect(models[0].capabilities.tools).toBe(true)
    expect(models[0].capabilities.vision).toBe(false)
    expect(models[0].contextLength).toBe(32768)
  })

  it('throws an unreachable error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(new OllamaAdapter().listModels('http://127.0.0.1:11434', null)).rejects.toBeInstanceOf(ProviderError)
  })

  it('streams NDJSON content, thinking, tool calls and usage', async () => {
    const deltas: { content?: string; thinking?: string }[] = []
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamResponse([
        JSON.stringify({ message: { role: 'assistant', thinking: 'hmm' } }) + '\n',
        JSON.stringify({ message: { content: 'Hello' } }) + '\n',
        JSON.stringify({ message: { content: ' world' } }) + '\n',
        JSON.stringify({
          message: { tool_calls: [{ function: { name: 'read_project_file', arguments: { path: 'a.ts' } } }] }
        }) + '\n',
        JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5 }) + '\n'
      ])
    )
    const result = await new OllamaAdapter().chat('http://127.0.0.1:11434', null, {
      model: 'qwen2.5:3b',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d)
    })
    expect(result.content).toBe('Hello world')
    expect(result.toolCalls[0].name).toBe('read_project_file')
    expect(result.toolCalls[0].arguments).toEqual({ path: 'a.ts' })
    expect(result.usage?.totalTokens).toBe(15)
    expect(deltas.some((d) => d.thinking === 'hmm')).toBe(true)
  })

  it('reports model_not_found on HTTP 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'model not found' }, false, 404)
    )
    await expect(
      new OllamaAdapter().chat('http://127.0.0.1:11434', null, {
        model: 'nope',
        messages: [],
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'model_not_found' })
  })
})

describe('OpenAICompatibleAdapter', () => {
  it('lists models from the /models endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }] })
    )
    const models = await new OpenAICompatibleAdapter().listModels('https://api.openai.com/v1', 'sk-test')
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'text-embedding-3-small'])
    expect(models[0].capabilities.vision).toBe(true)
  })

  it('maps auth failures to an auth error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'unauthorized' }, false, 401))
    await expect(
      new OpenAICompatibleAdapter().listModels('https://api.openai.com/v1', 'bad')
    ).rejects.toMatchObject({ code: 'auth' })
  })

  it('accumulates streamed SSE deltas and tool calls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamResponse([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'He' } }] }) + '\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'llo' } }] }) + '\n',
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', function: { name: 'search_project', arguments: '{"query":"x"}' } }
                  ]
                }
              }
            ]
          }) +
          '\n',
        'data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }) + '\n',
        'data: ' + JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } }) + '\n',
        'data: [DONE]\n'
      ])
    )
    const result = await new OpenAICompatibleAdapter().chat('https://api.openai.com/v1', 'sk', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal
    })
    expect(result.content).toBe('Hello')
    expect(result.toolCalls[0]).toMatchObject({ id: 'c1', name: 'search_project', arguments: { query: 'x' } })
    expect(result.usage?.totalTokens).toBe(10)
  })
})
