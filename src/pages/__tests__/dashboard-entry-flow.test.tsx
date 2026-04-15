import { MantineProvider } from '@mantine/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import Dashboard from '../Dashboard'
import {
  runDashboardEntryBootstrapFlow,
  type DashboardEntryBootstrapApi,
} from '../GatewayBootstrapGate'
import gatewayBootstrapSource from '../GatewayBootstrapGate.tsx?raw'

function createBootstrapApi(
  overrides: Partial<DashboardEntryBootstrapApi> = {}
): DashboardEntryBootstrapApi {
  return {
    ensureGatewayRunning: vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      summary: 'Gateway 未运行',
    }),
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
  it('records gateway bootstrap flow progress into env-check diagnostics', () => {
    expect(gatewayBootstrapSource).toContain("window.api.appendEnvCheckDiagnostic('gateway-bootstrap-run-start'")
    expect(gatewayBootstrapSource).toContain("window.api.appendEnvCheckDiagnostic('gateway-bootstrap-flow-result'")
    expect(gatewayBootstrapSource).toContain("window.api.appendEnvCheckDiagnostic('gateway-bootstrap-ready'")
    expect(gatewayBootstrapSource).toContain("window.api.appendEnvCheckDiagnostic('gateway-bootstrap-flow-failed'")
  })

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
    expect(result.softWarnings).toContain('暂时无法读取网关状态，控制面板会先按当前已知状态打开。')

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

    expect(result.softWarnings).toContain('飞书连接状态读取失败。')
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

    expect(result.softWarnings).toContain('飞书插件信息读取失败。')
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

    expect(result.softWarnings).toContain('暂时无法读取最新模型状态，当前先按已有配置显示模型信息。')
    expect(result.softWarnings).toContain('模型状态暂时不可用，稍后可在控制面板中刷新。')
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
    expect(result.softWarnings).toContain('暂时无法读取最新模型状态，当前先按已有配置显示模型信息。')
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
    expect(result.softWarnings).toContain('网关当前未就绪：Gateway 未运行')
  })

  it('attempts a lightweight gateway ensure before dashboard entry when the gateway is not running', async () => {
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      summary: 'Gateway 已自动恢复',
    })
    const api = createBootstrapApi({
      ensureGatewayRunning,
      gatewayHealth: vi.fn().mockResolvedValue({
        running: false,
        summary: 'Gateway 未 ready',
      }),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(result.snapshot.gatewayRunning).toBe(true)
    expect(result.softWarnings).toEqual([])
  })

  it('keeps dashboard entry soft-blocking when the lightweight gateway ensure still fails', async () => {
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      summary: 'Gateway 自动恢复失败',
    })
    const api = createBootstrapApi({
      ensureGatewayRunning,
      gatewayHealth: vi.fn().mockResolvedValue({
        running: false,
        summary: 'Gateway 未 ready',
      }),
    })

    const result = await runDashboardEntryBootstrapFlow(api)

    expect(ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(result.snapshot.gatewayRunning).toBe(false)
    expect(result.softWarnings).toContain('网关当前未就绪：Gateway 自动恢复失败')
  })

  it('lets dashboard entry continue when the lightweight gateway ensure exceeds the bootstrap wait budget', async () => {
    const ensureGatewayRunning = vi.fn(
      (_options?: Parameters<DashboardEntryBootstrapApi['ensureGatewayRunning']>[0]) =>
        new Promise<Awaited<ReturnType<DashboardEntryBootstrapApi['ensureGatewayRunning']>>>(() => {
          // Keep the ensure request pending to simulate a long-running gateway recovery.
        })
    )
    const api = createBootstrapApi({
      ensureGatewayRunning,
      gatewayHealth: vi.fn().mockResolvedValue({
        running: false,
        summary: 'Gateway 仍在恢复中',
      }),
    })

    const outcome = await Promise.race([
      runDashboardEntryBootstrapFlow(api, {
        gatewayEnsureTimeoutMs: 5,
      }).then((result) => ({ kind: 'resolved' as const, result })),
      new Promise<{ kind: 'timed_out' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timed_out' }), 40)
      }),
    ])

    expect(outcome.kind).toBe('resolved')
    if (outcome.kind !== 'resolved') {
      throw new Error('dashboard bootstrap did not resolve before the test watchdog timeout')
    }

    expect(ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(outcome.result.snapshot.gatewayRunning).toBe(false)
    expect(outcome.result.softWarnings).toContain('网关仍在后台继续恢复，控制面板先按当前状态打开。')
    expect(outcome.result.softWarnings).toContain('网关当前未就绪：Gateway 仍在恢复中')
  })

  it('lets dashboard entry continue when model and pairing summaries exceed the bootstrap wait budgets', async () => {
    const pending = () =>
      new Promise<never>(() => {
        // Keep the read pending to simulate a slow bootstrap side task.
      })
    const api = createBootstrapApi({
      gatewayHealth: vi.fn().mockResolvedValue({
        running: true,
        summary: 'Gateway å·²è¿è¡Œ',
      }),
      getModelUpstreamState: vi.fn(pending),
      pairingFeishuStatus: vi.fn(pending),
      getFeishuRuntimeStatus: vi.fn(pending),
    })

    const outcome = await Promise.race([
      runDashboardEntryBootstrapFlow(api, {
        modelBootstrapTimeoutMs: 5,
        pairingBootstrapTimeoutMs: 5,
      } as any).then((result) => ({ kind: 'resolved' as const, result })),
      new Promise<{ kind: 'timed_out' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timed_out' }), 40)
      }),
    ])

    expect(outcome.kind).toBe('resolved')
    if (outcome.kind !== 'resolved') {
      throw new Error('dashboard bootstrap did not resolve before the test watchdog timeout')
    }

    expect(outcome.result.snapshot.gatewayRunning).toBe(true)
    expect(outcome.result.snapshot.modelStatus).toBeNull()
    expect(outcome.result.snapshot.pairingSummary).toBeNull()
  })

  it('treats config reads as a hard block', async () => {
    const api = createBootstrapApi({
      readConfig: vi.fn().mockRejectedValue(new Error('disk unavailable')),
    })

    await expect(runDashboardEntryBootstrapFlow(api)).rejects.toMatchObject({
      title: '配置暂时无法读取',
    })
  })
})
