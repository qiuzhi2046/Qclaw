import { describe, expect, it, vi } from 'vitest'
import { getModelCatalog } from '../openclaw-model-catalog'
import type { CliCommandResult } from '../openclaw-capabilities'

const SAMPLE_MODELS = [
  {
    key: 'openai/gpt-5.1-codex',
    name: 'GPT 5.1 Codex',
    provider: 'openai',
    input: 'text',
    contextWindow: 256000,
    local: false,
    available: true,
    tags: ['text', 'coding'],
    missing: [],
  },
  {
    key: 'openai/gpt-4o',
    name: 'GPT 4o',
    provider: 'openai',
    input: 'text',
    contextWindow: 128000,
    local: false,
    available: true,
    tags: ['text', 'vision'],
    missing: [],
  },
  {
    key: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    input: 'text',
    contextWindow: 1000000,
    local: false,
    available: false,
    tags: ['text'],
    missing: ['auth'],
  },
  {
    key: 'local/llama3',
    name: 'Llama 3',
    provider: 'local',
    input: 'text',
    contextWindow: 8192,
    local: true,
    available: true,
    tags: ['local'],
    missing: [],
  },
]

function ok(stdout: string): CliCommandResult {
  return { ok: true, stdout, stderr: '', code: 0 }
}

describe('getModelCatalog', () => {
  it('loads bootstrap capabilities for live catalog reads by default', async () => {
    const loadCapabilities = vi.fn(async () => ({
      supports: {
        modelsListAllJson: true,
      },
      commandFlags: {
        'models list': ['--all', '--json'],
      },
    }) as any)
    const runCommand = vi.fn(async () => ok(JSON.stringify({ models: SAMPLE_MODELS })))

    const result = await getModelCatalog({
      loadCapabilities,
      runCommand,
      now: () => new Date('2026-03-12T00:00:00.000Z'),
      query: { bypassCache: true },
    })

    expect(loadCapabilities).toHaveBeenCalledWith({ profile: 'bootstrap' })
    expect(result.source).toBe('live')
  })

  it('returns live catalog with provider/search filter and pagination', async () => {
    const writeCache = vi.fn(async () => {})
    const runCommand = vi.fn(async () => ok(JSON.stringify({ count: SAMPLE_MODELS.length, models: SAMPLE_MODELS })))

    const result = await getModelCatalog({
      query: { provider: 'openai', search: 'gpt', page: 1, pageSize: 1 },
      runCommand,
      writeCache,
      now: () => new Date('2026-03-12T00:00:00.000Z'),
    })

    expect(result.source).toBe('live')
    expect(result.total).toBe(2)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].key).toBe('openai/gpt-5.1-codex')
    expect(result.providers).toContain('openai')
    expect(writeCache).toHaveBeenCalledTimes(1)
  })

  it('throws when live payload is corrupted JSON and no cache is available', async () => {
    const runCommand = vi.fn(async () => ok('{bad-json'))

    await expect(
      getModelCatalog({
        runCommand,
        readCache: async () => null,
      })
    ).rejects.toThrow(/parse/i)
  })

  it('returns fresh cache directly when ttl is not expired', async () => {
    const runCommand = vi.fn(
      async () =>
        ({
          ok: false,
          stdout: '',
          stderr: 'command timeout after 60000ms',
          code: 124,
        }) satisfies CliCommandResult
    )

    const result = await getModelCatalog({
      runCommand,
      readCache: async () => ({
        fetchedAt: '2026-03-12T00:00:00.000Z',
        models: SAMPLE_MODELS,
      }),
      now: () => new Date('2026-03-12T00:02:00.000Z'),
      ttlMs: 10 * 60 * 1000,
    })

    expect(result.source).toBe('cache')
    expect(result.stale).toBe(false)
    expect(result.total).toBe(SAMPLE_MODELS.length)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('bypasses fresh cache when query requests live refresh', async () => {
    const runCommand = vi.fn(async () => ok(JSON.stringify({ models: SAMPLE_MODELS })))

    const result = await getModelCatalog({
      query: { includeUnavailable: false, bypassCache: true },
      runCommand,
      readCache: async () => ({
        fetchedAt: '2026-03-12T00:00:00.000Z',
        models: SAMPLE_MODELS,
      }),
      now: () => new Date('2026-03-12T00:02:00.000Z'),
      ttlMs: 10 * 60 * 1000,
    })

    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('live')
    expect(result.stale).toBe(false)
    expect(result.total).toBe(3)
  })

  it('marks cached result as stale when cache is older than ttl', async () => {
    const runCommand = vi.fn(
      async () =>
        ({
          ok: false,
          stdout: '',
          stderr: 'timeout',
          code: 124,
        }) satisfies CliCommandResult
    )

    const result = await getModelCatalog({
      runCommand,
      readCache: async () => ({
        fetchedAt: '2026-03-01T00:00:00.000Z',
        models: SAMPLE_MODELS,
      }),
      now: () => new Date('2026-03-12T00:00:00.000Z'),
      ttlMs: 60 * 1000,
    })

    expect(result.source).toBe('cache')
    expect(result.stale).toBe(true)
    expect(result.total).toBe(SAMPLE_MODELS.length)
  })

  it('can return the full filtered catalog in a single live fetch', async () => {
    const module = await import('../openclaw-model-catalog') as Record<string, any>
    expect(typeof module.getAllModelCatalogItems).toBe('function')

    const runCommand = vi.fn(async () => ok(JSON.stringify({ models: SAMPLE_MODELS })))

    const result = await module.getAllModelCatalogItems({
      query: {
        provider: 'openai',
        includeUnavailable: false,
      },
      runCommand,
      now: () => new Date('2026-03-12T00:00:00.000Z'),
    })

    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('live')
    expect(result.total).toBe(2)
    expect(result.items.map((item: { key: string }) => item.key)).toEqual([
      'openai/gpt-5.1-codex',
      'openai/gpt-4o',
    ])
  })
})
