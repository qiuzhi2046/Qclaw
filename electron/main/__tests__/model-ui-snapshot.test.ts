import { describe, expect, it, vi } from 'vitest'

import { getModelUiSnapshot } from '../model-ui-snapshot'

describe('getModelUiSnapshot', () => {
  it('returns a bounded partial snapshot when config, env, or status reads never settle', async () => {
    vi.useFakeTimers()

    const pending = () =>
      new Promise<never>(() => {
        // Intentionally never settles so the snapshot must rely on its local budgets.
      })

    const resultPromise = getModelUiSnapshot(
      {
        includeEnv: true,
        includeCatalog: true,
      },
      {
        readConfig: vi.fn(pending),
        readEnvFile: vi.fn(pending),
        getModelStatus: vi.fn(pending),
        getAllCatalog: vi.fn(async () => ({
          total: 1,
          items: [{ key: 'openai/gpt-5.4-pro', provider: 'openai', name: 'GPT-5.4 Pro' }],
          providers: ['openai'],
          updatedAt: '2026-04-10T00:00:00.000Z',
          source: 'cache',
          stale: false,
        })),
        timeouts: {
          configMs: 5,
          envMs: 5,
          statusMs: 5,
          catalogMs: 5,
        },
      } as any
    )

    await vi.advanceTimersByTimeAsync(20)

    await expect(resultPromise).resolves.toMatchObject({
      envVars: null,
      config: null,
      modelStatus: null,
      catalog: {
        total: 1,
      },
    })

    const result = await resultPromise
    expect(result.warnings).toContain('模型状态快照读取超时，当前先按已有配置显示。')
    expect(result.warnings).toContain('配置快照读取超时，当前先按空配置继续。')
    expect(result.warnings).toContain('环境变量快照读取超时，当前先按空环境继续。')

    vi.useRealTimers()
  })

  it('returns a complete snapshot when all underlying reads settle in time', async () => {
    const result = await getModelUiSnapshot(
      {
        includeEnv: true,
        includeCatalog: true,
        statusOptions: { agentId: 'feishu-default' },
      },
      {
        readConfig: vi.fn(async () => ({
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5.4-pro',
              },
            },
          },
        })),
        readEnvFile: vi.fn(async () => ({
          OPENAI_API_KEY: 'sk-test',
        })),
        getModelStatus: vi.fn(async () => ({
          ok: true,
          action: 'status',
          command: ['models', 'status', '--json'],
          stdout: '{"defaultModel":"openai/gpt-5.4-pro"}',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'openai/gpt-5.4-pro',
          },
        })),
        getAllCatalog: vi.fn(async () => ({
          total: 2,
          items: [
            { key: 'openai/gpt-5.4-pro', provider: 'openai', name: 'GPT-5.4 Pro' },
            { key: 'openai/gpt-4.1', provider: 'openai', name: 'GPT-4.1' },
          ],
          providers: ['openai'],
          updatedAt: '2026-04-10T00:00:00.000Z',
          source: 'live',
          stale: false,
        })),
      } as any
    )

    expect(result.warnings).toEqual([])
    expect(result.envVars).toEqual({
      OPENAI_API_KEY: 'sk-test',
    })
    expect(result.config).toMatchObject({
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-5.4-pro',
          },
        },
      },
    })
    expect(result.modelStatus).toMatchObject({
      defaultModel: 'openai/gpt-5.4-pro',
    })
    expect(result.catalog?.items).toHaveLength(2)
  })
})
