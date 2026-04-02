import { MantineProvider } from '@mantine/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import Dashboard from '../Dashboard'
import {
  runDashboardEntryBootstrapFlow,
  type DashboardEntryBootstrapApi,
} from '../GatewayBootstrapGate'

function createBootstrapApi(
  overrides: Partial<DashboardEntryBootstrapApi> = {}
): DashboardEntryBootstrapApi {
  return {
    gatewayHealth: vi.fn().mockResolvedValue({
      running: false,
      summary: 'Gateway 未运行',
    }),
    readConfig: vi.fn().mockResolvedValue({
      channels: {
        feishu: {
          name: 'Feishu 客服',
          appId: 'cli_test_feishu',
          domain: 'feishu',
        },
      },
      models: {
        openai: {
          enabled: true,
        },
      },
    }),
    getModelStatus: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        defaultModel: 'openai/gpt-5.1-codex',
        auth: {
          providers: [{ provider: 'openai-codex', status: 'ok' }],
        },
      },
    }),
    getModelUpstreamState: vi.fn().mockResolvedValue({
      ok: true,
      source: 'control-ui-app',
      fallbackUsed: false,
      diagnostics: {
        upstreamAvailable: true,
        connected: true,
        hasClient: true,
        hasHelloSnapshot: true,
        hasHealthResult: false,
        hasSessionsState: false,
        hasModelCatalogState: true,
        appKeys: ['helloSnapshot', 'modelCatalogState'],
      },
      data: {
        source: 'control-ui-app',
        connected: true,
        hasClient: true,
        appKeys: ['helloSnapshot', 'modelCatalogState'],
        modelStatusLike: {
          defaultModel: 'openai/gpt-5.4-pro',
          auth: {
            providers: [{ provider: 'openai-codex', status: 'ok' }],
          },
        },
        catalogItemsLike: [
          {
            key: 'openai/gpt-5.4-pro',
            provider: 'openai',
            available: true,
          },
        ],
      },
    }),
    pairingFeishuStatus: vi.fn().mockResolvedValue({
      default: {
        pairedCount: 1,
        pairedUsers: ['ou_123'],
      },
    }),
    getFeishuRuntimeStatus: vi.fn().mockResolvedValue({
      default: {
        runtimeState: 'online',
        summary: '运行中',
        issues: [],
      },
    }),
    ...overrides,
  }
}

describe('dashboard entry bootstrap flow', () => {
  it('builds a dashboard entry snapshot and lets Dashboard render from it immediately', async () => {
    const api = createBootstrapApi({
      gatewayHealth: vi.fn().mockResolvedValue({
        running: true,
        summary: 'Gateway 已运行',
      }),
      readConfig: vi.fn().mockResolvedValue({
        channels: {
          feishu: {
            name: 'Feishu 客服',
            appId: 'cli_test_feishu',
            domain: 'feishu',
          },
          telegram: {
            name: 'Telegram 机器人',
            domain: 'telegram',
          },
        },
        models: {
          openai: {
            enabled: true,
          },
        },
      }),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(result.softWarnings).toEqual([])
    expect(result.snapshot).toMatchObject({
      gatewayRunning: true,
      modelStatus: {
        defaultModel: 'openai/gpt-5.4-pro',
      },
      pairingSummary: {
        feishuBotCount: 1,
        pairedBotCount: 1,
        degradedBotCount: 0,
        offlineBotCount: 0,
        otherChannelCount: 1,
      },
    })

    const html = renderToStaticMarkup(
      <MantineProvider>
        <Dashboard entrySnapshot={result.snapshot} />
      </MantineProvider>
    )

    expect(html).toContain('飞书')
    expect(html).toContain('Telegram 机器人')
    expect(html).toContain('openai/gpt-5.4-pro')
    expect(api.getModelStatus).not.toHaveBeenCalled()
  })

  it('allows dashboard entry when gateway probes fail and keeps gatewayRunning false', async () => {
    const api = createBootstrapApi({
      gatewayHealth: vi.fn().mockRejectedValue(new Error('health down')),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(result.snapshot.gatewayRunning).toBe(false)
    expect(result.softWarnings).toContain('网关状态读取失败，控制面板将先按离线状态进入：health down')

    const html = renderToStaticMarkup(
      <MantineProvider>
        <Dashboard entrySnapshot={result.snapshot} />
      </MantineProvider>
    )

    expect(html).toContain('已停止')
  })

  it('keeps pairing reads as soft-blocking warnings without blocking dashboard entry', async () => {
    const api = createBootstrapApi({
      readConfig: vi.fn().mockResolvedValue({
        channels: {
          feishu: {
            name: 'Feishu 客服',
            appId: 'cli_test_feishu',
            domain: 'feishu',
          },
        },
      }),
      pairingFeishuStatus: vi.fn().mockRejectedValue(new Error('pairing down')),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(result.softWarnings).toContain('飞书配对状态读取失败：pairing down')
    expect(result.snapshot.pairingSummary).toBeNull()
    expect(result.snapshot.modelStatus).toMatchObject({
      defaultModel: 'openai/gpt-5.4-pro',
    })
  })

  it('treats feishu runtime reads as soft warnings without blocking dashboard entry', async () => {
    const api = createBootstrapApi({
      getFeishuRuntimeStatus: vi.fn().mockRejectedValue(new Error('runtime down')),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(result.softWarnings).toContain('飞书运行状态读取失败：runtime down')
    expect(result.snapshot.pairingSummary).toBeNull()
  })

  it('adds a soft warning when model status snapshot fails', async () => {
    const api = createBootstrapApi({
      getModelUpstreamState: vi.fn().mockResolvedValue({
        ok: false,
        source: 'control-ui-app',
        fallbackUsed: true,
        fallbackReason: 'control-ui-app-unavailable',
        diagnostics: {
          upstreamAvailable: false,
          connected: false,
          hasClient: false,
          hasHelloSnapshot: false,
          hasHealthResult: false,
          hasSessionsState: false,
          hasModelCatalogState: false,
          appKeys: [],
          lastError: 'control-ui-app-unavailable',
        },
      }),
      getModelStatus: vi.fn().mockResolvedValue({
        ok: false,
      }),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(result.softWarnings).toContain(
      '模型上游状态暂不可用，已回退到命令行工具状态快照：control-ui-app-unavailable'
    )
    expect(result.softWarnings).toContain('模型状态读取失败：控制面板将先按配置快照显示模型信息。')
    expect(result.snapshot.modelStatus).toBeNull()
  })

  it('falls back to CLI model status when upstream state is unavailable', async () => {
    const api = createBootstrapApi({
      getModelUpstreamState: vi.fn().mockResolvedValue({
        ok: false,
        source: 'control-ui-app',
        fallbackUsed: true,
        fallbackReason: 'control-ui-app-missing-model-state',
        diagnostics: {
          upstreamAvailable: true,
          connected: true,
          hasClient: true,
          hasHelloSnapshot: false,
          hasHealthResult: false,
          hasSessionsState: false,
          hasModelCatalogState: false,
          appKeys: [],
        },
      }),
      getModelStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          defaultModel: 'anthropic/claude-sonnet-4-6',
        },
      }),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(result.snapshot.modelStatus).toMatchObject({
      defaultModel: 'anthropic/claude-sonnet-4-6',
    })
    expect(result.softWarnings).toContain(
      '模型上游状态暂不可用，已回退到命令行工具状态快照：control-ui-app-missing-model-state'
    )
    expect(api.getModelStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps gatewayRunning false when gateway health reports not ready', async () => {
    const api = createBootstrapApi({
      gatewayHealth: vi.fn().mockResolvedValue({
        running: false,
        summary: 'Gateway 未 ready',
      }),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(result.snapshot.gatewayRunning).toBe(false)
    expect(result.softWarnings).toContain('网关当前未就绪：Gateway 未 ready')
  })

  it('treats config reads as a hard block', async () => {
    const api = createBootstrapApi({
      readConfig: vi.fn().mockRejectedValue(new Error('disk unavailable')),
    })

    await expect(runDashboardEntryBootstrapFlow(api)).rejects.toMatchObject({
      title: '当前配置暂时不可读取',
    })
  })
})
