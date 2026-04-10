import { describe, expect, it, vi } from 'vitest'

vi.mock('../cli', () => ({
  readConfig: vi.fn(async () => ({})),
  readEnvFile: vi.fn(async () => ({})),
}))

vi.mock('../openclaw-control-ui-rpc', () => ({
  inspectControlUiAppViaBrowser: vi.fn(),
}))

import { inspectControlUiAppViaBrowser } from '../openclaw-control-ui-rpc'
import { getOpenClawUpstreamModelState } from '../openclaw-upstream-model-state'

const inspectControlUiAppViaBrowserMock = vi.mocked(inspectControlUiAppViaBrowser)

describe('getOpenClawUpstreamModelState', () => {
  it('returns upstream-derived control ui app state without fallback on the happy path', async () => {
    inspectControlUiAppViaBrowserMock.mockResolvedValueOnce({
      connected: true,
      hasClient: true,
      lastError: '',
      appKeys: ['client', 'connected', 'hello', 'healthResult'],
      helloSnapshot: {
        models: {
          status: {
            defaultModel: 'minimax-portal/MiniMax-M2.5',
            allowed: ['minimax-portal/MiniMax-M2.5'],
            auth: {
              oauth: {
                providers: [{ provider: 'minimax-portal', status: 'ok' }],
              },
            },
          },
        },
      },
      healthResult: {
        status: 'ok',
      },
      sessionsState: {
        count: 1,
      },
      modelCatalogState: {
        items: [
          {
            key: 'minimax/MiniMax-M2.5',
            provider: 'minimax',
            available: false,
          },
        ],
      },
    })

    const result = await getOpenClawUpstreamModelState()

    expect(result).toEqual({
      ok: true,
      source: 'control-ui-app',
      fallbackUsed: false,
      data: {
        source: 'control-ui-app',
        connected: true,
        hasClient: true,
        appKeys: ['client', 'connected', 'hello', 'healthResult'],
        helloSnapshot: {
          models: {
            status: {
              defaultModel: 'minimax-portal/MiniMax-M2.5',
              allowed: ['minimax-portal/MiniMax-M2.5'],
              auth: {
                oauth: {
                  providers: [{ provider: 'minimax-portal', status: 'ok' }],
                },
              },
            },
          },
        },
        healthResult: {
          status: 'ok',
        },
        sessionsState: {
          count: 1,
        },
        modelCatalogState: {
          items: [
            {
              key: 'minimax/MiniMax-M2.5',
              provider: 'minimax',
              available: false,
            },
          ],
        },
        modelStatusLike: {
          defaultModel: 'minimax-portal/MiniMax-M2.5',
          allowed: ['minimax-portal/MiniMax-M2.5'],
          auth: {
            oauth: {
              providers: [{ provider: 'minimax-portal', status: 'ok' }],
            },
          },
        },
        modelStatusSummaryLike: {
          defaultModel: 'minimax-portal/MiniMax-M2.5',
          allowedCount: 1,
          fallbackCount: undefined,
          providerAuth: [{ provider: 'minimax-portal', status: 'ok' }],
        },
        catalogItemsLike: [
          {
            key: 'minimax/MiniMax-M2.5',
            provider: 'minimax',
            available: false,
          },
        ],
        catalogSummaryLike: {
          totalItems: 1,
          availableItems: 0,
          providerKeys: ['minimax'],
        },
        sessionInventoryLike: {
          totalSessions: 1,
          continuableSessions: undefined,
          patchableSessions: undefined,
          observedKinds: [],
          observedChannels: [],
        },
        debugSnapshots: {
          helloSnapshot: {
            models: {
              status: {
                defaultModel: 'minimax-portal/MiniMax-M2.5',
                allowed: ['minimax-portal/MiniMax-M2.5'],
                auth: {
                  oauth: {
                    providers: [{ provider: 'minimax-portal', status: 'ok' }],
                  },
                },
              },
            },
          },
          healthResult: {
            status: 'ok',
          },
          sessionsState: {
            count: 1,
          },
          modelCatalogState: {
            items: [
              {
                key: 'minimax/MiniMax-M2.5',
                provider: 'minimax',
                available: false,
              },
            ],
          },
        },
      },
      diagnostics: {
        upstreamAvailable: true,
        connected: true,
        hasClient: true,
        hasHelloSnapshot: true,
        hasHealthResult: true,
        hasSessionsState: true,
        hasModelCatalogState: true,
        appKeys: ['client', 'connected', 'hello', 'healthResult'],
        lastError: undefined,
      },
    })
  })

  it('records a fallback reason when upstream inspect fails', async () => {
    inspectControlUiAppViaBrowserMock.mockRejectedValueOnce(new Error('gateway control ui config unavailable'))

    const result = await getOpenClawUpstreamModelState()

    expect(result.ok).toBe(false)
    expect(result.fallbackUsed).toBe(true)
    expect(result.fallbackReason).toBe('gateway control ui config unavailable')
    expect(result.diagnostics.upstreamAvailable).toBe(false)
    expect(result.diagnostics.lastError).toBe('gateway control ui config unavailable')
  })

  it('passes optional timeout overrides through to the control ui inspection helper', async () => {
    inspectControlUiAppViaBrowserMock.mockResolvedValueOnce({
      connected: true,
      hasClient: true,
      lastError: '',
      appKeys: ['client'],
      helloSnapshot: { models: { status: { allowed: ['openai/gpt-5.4-pro'] } } },
      healthResult: null,
      sessionsState: null,
      modelCatalogState: null,
    })

    await getOpenClawUpstreamModelState({
      timeoutMs: 35_000,
      loadTimeoutMs: 30_000,
    })

    expect(inspectControlUiAppViaBrowserMock).toHaveBeenCalledWith(
      expect.any(Object),
      {
        timeoutMs: 35_000,
        loadTimeoutMs: 30_000,
      }
    )
  })

  it('records a fallback reason when control ui app is reachable but missing model state', async () => {
    inspectControlUiAppViaBrowserMock.mockResolvedValueOnce({
      connected: true,
      hasClient: true,
      lastError: '',
      appKeys: ['client', 'connected'],
      helloSnapshot: null,
      healthResult: null,
      sessionsState: null,
      modelCatalogState: null,
    })

    const result = await getOpenClawUpstreamModelState()

    expect(result.ok).toBe(false)
    expect(result.fallbackUsed).toBe(true)
    expect(result.fallbackReason).toBe('control-ui-app-missing-model-state')
    expect(result.diagnostics.connected).toBe(true)
    expect(result.diagnostics.hasClient).toBe(true)
  })

  it('builds stable summaries even when the projected control ui shapes differ', async () => {
    inspectControlUiAppViaBrowserMock.mockResolvedValueOnce({
      connected: true,
      hasClient: true,
      lastError: '',
      appKeys: ['client', 'connected', 'sessionsState', 'modelCatalogState'],
      helloSnapshot: {
        bootstrap: {
          model: {
            current: {
              defaultModel: 'openai/gpt-5.4-pro',
              model: 'openai/gpt-5.4-pro',
              allowed: ['openai/gpt-5.4-pro', 'openai/gpt-5.4-mini'],
              fallbacks: ['openai/gpt-4.1'],
              auth: {
                providers: [
                  { provider: 'openai', status: 'ok' },
                  { provider: 'azure-openai', status: 'degraded' },
                ],
              },
            },
          },
        },
      },
      healthResult: {
        state: 'ok',
      },
      sessionsState: {
        summary: {
          total: 2,
        },
        data: {
          entries: [
            {
              id: 'session-a',
              kind: 'direct',
              canPatchModel: true,
            },
            {
              sessionKey: 'channel:feishu:abc',
              channel: 'feishu',
              writable: true,
            },
          ],
        },
      },
      modelCatalogState: {
        catalog: {
          models: [
            {
              key: 'openai/gpt-5.4-pro',
              provider: 'openai',
              available: true,
            },
            {
              key: 'anthropic/claude-sonnet-4.5',
              provider: 'anthropic',
              available: false,
            },
          ],
        },
      },
    })

    const result = await getOpenClawUpstreamModelState()

    expect(result.ok).toBe(true)
    expect(result.data?.modelStatusSummaryLike).toEqual({
      defaultModel: 'openai/gpt-5.4-pro',
      activeModel: 'openai/gpt-5.4-pro',
      allowedCount: 2,
      fallbackCount: 1,
      providerAuth: [
        { provider: 'azure-openai', status: 'degraded' },
        { provider: 'openai', status: 'ok' },
      ],
    })
    expect(result.data?.catalogSummaryLike).toEqual({
      totalItems: 2,
      availableItems: 1,
      providerKeys: ['anthropic', 'openai'],
    })
    expect(result.data?.sessionInventoryLike).toEqual({
      totalSessions: 2,
      continuableSessions: 1,
      patchableSessions: 1,
      observedKinds: ['direct'],
      observedChannels: ['feishu'],
    })
    expect(result.data?.debugSnapshots?.sessionsState).toEqual({
      summary: {
        total: 2,
      },
      data: {
        entries: [
          {
            id: 'session-a',
            kind: 'direct',
            canPatchModel: true,
          },
          {
            sessionKey: 'channel:feishu:abc',
            channel: 'feishu',
            writable: true,
          },
        ],
      },
    })
  })

  it('derives provider-ready model state from current control ui rpc snapshots', async () => {
    inspectControlUiAppViaBrowserMock.mockResolvedValueOnce({
      connected: true,
      hasClient: true,
      lastError: '',
      appKeys: ['client', 'connected', 'sessionsResult', 'chatModelCatalog'],
      helloSnapshot: {
        health: {
          ok: true,
        },
      },
      healthResult: {
        ok: true,
      },
      sessionsState: null,
      modelCatalogState: null,
      sessionsResult: {
        count: 3,
        defaults: {
          modelProvider: 'minimax-portal',
          model: 'MiniMax-M2.7',
        },
        sessions: [
          {
            key: 'agent:main:main',
            kind: 'direct',
            lastChannel: 'webchat',
          },
        ],
      },
      chatModelCatalog: [
        {
          id: 'MiniMax-M2.7',
          name: 'MiniMax-M2.7',
          provider: 'minimax-portal',
        },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          provider: 'openai-codex',
        },
      ],
      rpcStatus: {
        sessions: {
          count: 3,
        },
      },
      rpcModels: {
        models: [
          {
            id: 'MiniMax-M2.7',
            name: 'MiniMax-M2.7',
            provider: 'minimax-portal',
          },
          {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            provider: 'openai-codex',
          },
        ],
      },
      rpcErrors: [],
    })

    const result = await getOpenClawUpstreamModelState()

    expect(result.ok).toBe(true)
    expect(result.data?.modelStatusLike).toEqual({
      allowed: ['minimax-portal/MiniMax-M2.7', 'openai-codex/gpt-5.4'],
      defaultModel: 'minimax-portal/MiniMax-M2.7',
      model: 'minimax-portal/MiniMax-M2.7',
    })
    expect(result.data?.modelStatusSummaryLike).toEqual({
      defaultModel: 'minimax-portal/MiniMax-M2.7',
      activeModel: 'minimax-portal/MiniMax-M2.7',
      allowedCount: 2,
      fallbackCount: undefined,
      providerAuth: [],
    })
    expect(result.data?.catalogItemsLike).toEqual([
      {
        key: 'minimax-portal/MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        provider: 'minimax-portal',
        available: true,
      },
      {
        key: 'openai-codex/gpt-5.4',
        name: 'GPT-5.4',
        provider: 'openai-codex',
        available: true,
      },
    ])
    expect(result.data?.sessionInventoryLike).toEqual({
      totalSessions: 3,
      continuableSessions: undefined,
      patchableSessions: undefined,
      observedKinds: ['direct'],
      observedChannels: ['webchat'],
    })
    expect(result.data?.debugSnapshots?.sessionsResult).toEqual({
      count: 3,
      defaults: {
        modelProvider: 'minimax-portal',
        model: 'MiniMax-M2.7',
      },
      sessions: [
        {
          key: 'agent:main:main',
          kind: 'direct',
          lastChannel: 'webchat',
        },
      ],
    })
    expect(result.data?.debugSnapshots?.rpcModels).toEqual({
      models: [
        {
          id: 'MiniMax-M2.7',
          name: 'MiniMax-M2.7',
          provider: 'minimax-portal',
        },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          provider: 'openai-codex',
        },
      ],
    })
  })
})
