import { describe, expect, it, vi } from 'vitest'
import {
  getModelCenterCapabilities,
  refreshModelData,
  withModelCenterCapabilitiesInvalidatedOnSuccess,
} from '../model-center-capabilities'
import type { OpenClawCapabilities } from '../openclaw-capabilities'

const CAPABILITIES: OpenClawCapabilities = {
  version: 'OpenClaw 2026.3.26',
  discoveredAt: '2026-03-26T00:00:00.000Z',
  authRegistry: {
    ok: true,
    source: 'openclaw-internal-registry',
    providers: [],
  },
  authRegistrySource: 'openclaw-internal-registry',
  authChoices: [],
  rootCommands: ['models', 'plugins'],
  onboardFlags: ['--auth-choice'],
  modelsCommands: ['auth', 'list', 'status'],
  modelsAuthCommands: ['login'],
  pluginsCommands: ['enable'],
  commandFlags: {
    'models auth login': ['--provider'],
  },
  supports: {
    onboard: true,
    plugins: true,
    pluginsInstall: true,
    pluginsEnable: true,
    chatAgentModelFlag: false,
    chatGatewaySendModel: false,
    chatInThreadModelSwitch: false,
    modelsListAllJson: true,
    modelsStatusJson: true,
    modelsAuthLogin: true,
    modelsAuthAdd: false,
    modelsAuthPasteToken: false,
    modelsAuthSetupToken: false,
    modelsAuthOrder: false,
    modelsAuthLoginGitHubCopilot: false,
    aliases: false,
    fallbacks: false,
    imageFallbacks: false,
    modelsScan: false,
  },
}

describe('getModelCenterCapabilities', () => {
  it('uses the shared capabilities cache for ordinary page loads', async () => {
    const loadCapabilities = vi.fn(async () => CAPABILITIES)
    const discoverCapabilities = vi.fn(async () => CAPABILITIES)

    const result = await getModelCenterCapabilities(
      {},
      {
        loadCapabilities,
        discoverCapabilities,
      }
    )

    expect(result).toBe(CAPABILITIES)
    expect(loadCapabilities).toHaveBeenCalledTimes(1)
    expect(loadCapabilities).toHaveBeenCalledWith({ profile: 'bootstrap' })
    expect(discoverCapabilities).not.toHaveBeenCalled()
  })

  it('forces a fresh discovery when the user explicitly refreshes model capabilities', async () => {
    const loadCapabilities = vi.fn(async () => CAPABILITIES)
    const discoverCapabilities = vi.fn(async () => CAPABILITIES)

    const result = await getModelCenterCapabilities(
      { forceRefresh: true },
      {
        loadCapabilities,
        discoverCapabilities,
      }
    )

    expect(result).toBe(CAPABILITIES)
    expect(discoverCapabilities).toHaveBeenCalledTimes(1)
    expect(discoverCapabilities).toHaveBeenCalledWith({ refreshAuthRegistry: true, profile: 'bootstrap' })
    expect(loadCapabilities).not.toHaveBeenCalled()
  })

  it('times out without clearing the shared capabilities cache when a load never settles', async () => {
    vi.useFakeTimers()

    const loadCapabilities = vi.fn(
      () =>
        new Promise<OpenClawCapabilities>(() => {
          // Intentionally never settles so the timeout path can be verified.
        })
    )
    const resetCapabilitiesCache = vi.fn()

    const pendingResult = getModelCenterCapabilities(
      { timeoutMs: 50 } as any,
      {
        loadCapabilities,
        resetCapabilitiesCache,
      } as any
    )
    const rejection = expect(pendingResult).rejects.toThrow('timed out after 50ms')

    await vi.advanceTimersByTimeAsync(50)

    await rejection
    expect(loadCapabilities).toHaveBeenCalledTimes(1)
    expect(resetCapabilitiesCache).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('clears the shared capabilities cache when loading fails before the timeout', async () => {
    const loadCapabilities = vi.fn(async () => {
      throw new Error('registry unavailable')
    })
    const resetCapabilitiesCache = vi.fn()

    await expect(
      getModelCenterCapabilities(
        { timeoutMs: 50 } as any,
        {
          loadCapabilities,
          resetCapabilitiesCache,
        } as any
      )
    ).rejects.toThrow('registry unavailable')

    expect(loadCapabilities).toHaveBeenCalledTimes(1)
    expect(resetCapabilitiesCache).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })
})

describe('withModelCenterCapabilitiesInvalidatedOnSuccess', () => {
  it('clears the shared capabilities cache after a successful OpenClaw runtime change', async () => {
    const resetCapabilitiesCache = vi.fn()

    const result = await withModelCenterCapabilitiesInvalidatedOnSuccess(
      async () => ({ ok: true, message: 'updated' }),
      {
        resetCapabilitiesCache,
      }
    )

    expect(result).toEqual({ ok: true, message: 'updated' })
    expect(resetCapabilitiesCache).toHaveBeenCalledTimes(1)
  })

  it('keeps the shared capabilities cache when the runtime change fails', async () => {
    const resetCapabilitiesCache = vi.fn()

    const result = await withModelCenterCapabilitiesInvalidatedOnSuccess(
      async () => ({ ok: false, message: 'failed' }),
      {
        resetCapabilitiesCache,
      }
    )

    expect(result).toEqual({ ok: false, message: 'failed' })
    expect(resetCapabilitiesCache).not.toHaveBeenCalled()
  })
})

describe('refreshModelData', () => {
  it('uses cached capabilities and skips catalog refresh by default', async () => {
    const loadCapabilities = vi.fn(async () => CAPABILITIES)
    const discoverCapabilities = vi.fn(async () => ({
      ...CAPABILITIES,
      version: 'OpenClaw 2026.3.99',
    }))
    const getStatus = vi.fn(async () => ({
      ok: true,
      action: 'status',
      command: ['models', 'status', '--json'],
      stdout: '{"defaultModel":"openai/gpt-5.1-codex"}',
      stderr: '',
      code: 0,
      data: {
        defaultModel: 'openai/gpt-5.1-codex',
      },
    }))
    const getCatalog = vi.fn(async () => ({
      total: 1,
      items: [{ key: 'openai/gpt-5.1-codex' }],
      providers: ['openai'],
      updatedAt: '2026-03-12T00:00:00.000Z',
      source: 'live',
      stale: false,
    }))

    const result = await refreshModelData(
      {},
      {
        loadCapabilities,
        discoverCapabilities,
        getStatus,
        getCatalog,
      } as any
    )

    expect(loadCapabilities).toHaveBeenCalledTimes(1)
    expect(discoverCapabilities).not.toHaveBeenCalled()
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(getCatalog).not.toHaveBeenCalled()
    expect(result.capabilities).toBe(CAPABILITIES)
    expect(result.status?.ok).toBe(true)
    expect(result.catalog).toBeUndefined()
  })

  it('supports a fast models-page refresh without capabilities discovery', async () => {
    const loadCapabilities = vi.fn(async () => CAPABILITIES)
    const discoverCapabilities = vi.fn(async () => CAPABILITIES)
    const getStatus = vi.fn(async () => ({
      ok: true,
      action: 'status',
      command: ['models', 'status', '--json'],
      stdout: '{"defaultModel":"openai/gpt-5.1-codex"}',
      stderr: '',
      code: 0,
      data: {
        defaultModel: 'openai/gpt-5.1-codex',
      },
    }))
    const getAllCatalog = vi.fn(async () => ({
      total: 2,
      items: [
        { key: 'openai/gpt-5.1-codex' },
        { key: 'openai/gpt-4o' },
      ],
      providers: ['openai'],
      updatedAt: '2026-03-12T00:00:00.000Z',
      source: 'cache',
      stale: false,
    }))

    const result = await refreshModelData(
      {
        includeCapabilities: false,
        includeCatalog: true,
        fullCatalog: true,
        catalogQuery: {
          bypassCache: true,
        },
      },
      {
        loadCapabilities,
        discoverCapabilities,
        getStatus,
        getAllCatalog,
      } as any
    )

    expect(loadCapabilities).not.toHaveBeenCalled()
    expect(discoverCapabilities).not.toHaveBeenCalled()
    expect(getStatus).toHaveBeenCalledWith({}, expect.objectContaining({
      runCommandWithEnv: expect.any(Function),
    }))
    expect(getAllCatalog).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({
        bypassCache: true,
      }),
      runCommand: expect.any(Function),
    }))
    expect(result.capabilities).toBeUndefined()
    expect(result.catalog?.items).toHaveLength(2)
  })
})
