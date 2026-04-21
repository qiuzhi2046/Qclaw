import { describe, expect, it, vi } from 'vitest'
import {
  createUnavailableUpstreamModelState,
  getUpstreamCatalogSummaryLike,
  getUpstreamCatalogItemsLike,
  getUpstreamDebugSnapshotsLike,
  getUpstreamModelStatusLike,
  getUpstreamModelStatusSummaryLike,
  getUpstreamSessionInventoryLike,
  logUpstreamModelStateFallback,
  readOpenClawUpstreamModelState,
  selectPreferredRendererCatalogItems,
} from '../upstream-model-state'

describe('upstream model state helpers', () => {
  it('returns a stable fallback payload when upstream read throws', async () => {
    const result = await readOpenClawUpstreamModelState(async () => {
      throw new Error('control-ui-down')
    })

    expect(result).toMatchObject({
      ok: false,
      fallbackUsed: true,
      fallbackReason: 'control-ui-down',
      diagnostics: {
        upstreamAvailable: false,
        connected: false,
      },
    })
  })

  it('extracts status and catalog only from successful upstream payloads', () => {
    const result = {
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
        appKeys: [],
      },
      data: {
        source: 'control-ui-app',
        connected: true,
        hasClient: true,
        appKeys: [],
        modelStatusLike: {
          defaultModel: 'openai/gpt-5.4-pro',
        },
        modelStatusSummaryLike: {
          defaultModel: 'openai/gpt-5.4-pro',
          allowedCount: 2,
          providerAuth: [{ provider: 'openai', status: 'ok' }],
        },
        catalogItemsLike: [
          { key: 'openai/gpt-5.4-pro', provider: 'openai', available: true },
          { key: '', provider: 'openai' },
        ],
        catalogSummaryLike: {
          totalItems: 2,
          availableItems: 1,
          providerKeys: ['openai', ''],
        },
        sessionInventoryLike: {
          totalSessions: 2,
          continuableSessions: 1,
          patchableSessions: 1,
          observedKinds: ['direct', ''],
          observedChannels: ['feishu', ''],
        },
        debugSnapshots: {
          sessionsState: {
            total: 2,
          },
        },
      },
    } as Awaited<ReturnType<typeof window.api.getModelUpstreamState>>

    expect(getUpstreamModelStatusLike(result)).toEqual({
      defaultModel: 'openai/gpt-5.4-pro',
    })
    expect(getUpstreamModelStatusSummaryLike(result)).toEqual({
      defaultModel: 'openai/gpt-5.4-pro',
      activeModel: undefined,
      allowedCount: 2,
      fallbackCount: undefined,
      providerAuth: [{ provider: 'openai', status: 'ok' }],
    })
    expect(getUpstreamCatalogItemsLike(result)).toEqual([
      { key: 'openai/gpt-5.4-pro', provider: 'openai', available: true },
    ])
    expect(getUpstreamCatalogSummaryLike(result)).toEqual({
      totalItems: 2,
      availableItems: 1,
      providerKeys: ['openai'],
    })
    expect(getUpstreamSessionInventoryLike(result)).toEqual({
      totalSessions: 2,
      continuableSessions: 1,
      patchableSessions: 1,
      observedKinds: ['direct'],
      observedChannels: ['feishu'],
    })
    expect(getUpstreamDebugSnapshotsLike(result)).toEqual({
      helloSnapshot: null,
      healthResult: null,
      sessionsState: {
        total: 2,
      },
      modelCatalogState: null,
    })
  })

  it('logs fallback reasons only when upstream actually fell back', () => {
    const logger = vi.fn()

    logUpstreamModelStateFallback('Dashboard', createUnavailableUpstreamModelState('control-ui-down'), logger)
    logUpstreamModelStateFallback(
      'Dashboard',
      {
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
          hasModelCatalogState: false,
          appKeys: [],
        },
      },
      logger
    )

    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith(
      '[Dashboard] upstream model state fallback:',
      'control-ui-down'
    )
  })

  it('stays silent when fallback logging is explicitly disabled', () => {
    const logger = vi.fn()

    logUpstreamModelStateFallback(
      'Dashboard',
      createUnavailableUpstreamModelState('control-ui-down'),
      logger,
      false
    )

    expect(logger).not.toHaveBeenCalled()
  })
})

describe('selectPreferredRendererCatalogItems', () => {
  it('prefers the CLI full catalog over a smaller upstream snapshot once the CLI catalog has loaded', () => {
    const upstreamItems = [
      { key: 'minimax/MiniMax-M2.5', provider: 'minimax' },
      { key: 'minimax/MiniMax-M2.7', provider: 'minimax' },
    ]
    const cliItems = [
      { key: 'minimax/MiniMax-M2.5', provider: 'minimax' },
      { key: 'minimax/MiniMax-M2.7', provider: 'minimax' },
      { key: 'minimax/MiniMax-Text-01', provider: 'minimax' },
      { key: 'minimax/MiniMax-VL-01', provider: 'minimax' },
      { key: 'minimax/MiniMax-M1', provider: 'minimax' },
      { key: 'minimax/MiniMax-M1-80k', provider: 'minimax' },
      { key: 'minimax/MiniMax-M1-thinking', provider: 'minimax' },
    ]

    expect(selectPreferredRendererCatalogItems({
      cliLoaded: true,
      cliItems,
      upstreamItems,
    })).toEqual(cliItems)
  })

  it('keeps the exact CLI result when it is empty instead of falling back to upstream items', () => {
    expect(selectPreferredRendererCatalogItems({
      cliLoaded: true,
      cliItems: [],
      upstreamItems: [
        { key: 'minimax/MiniMax-M2.5', provider: 'minimax' },
      ],
    })).toEqual([])
  })

  it('falls back to upstream items only when the CLI catalog is unavailable', () => {
    const upstreamItems = [
      { key: 'openai/gpt-5.4', provider: 'openai' },
    ]

    expect(selectPreferredRendererCatalogItems({
      cliLoaded: false,
      cliItems: [],
      upstreamItems,
    })).toEqual(upstreamItems)
  })
})
