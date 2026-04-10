import { describe, expect, it, vi } from 'vitest'
import {
  loadOpenClawCapabilities,
  resetOpenClawCapabilitiesCache,
  type OpenClawCapabilities,
} from '../openclaw-capabilities'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createCapabilities(version: string): OpenClawCapabilities {
  return {
    version,
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
}

describe('loadOpenClawCapabilities cache invalidation', () => {
  it('keeps bootstrap and full capability cache entries separate', async () => {
    resetOpenClawCapabilitiesCache()

    const discoverCapabilities = vi.fn(async (options?: { profile?: string }) =>
      createCapabilities(options?.profile === 'bootstrap' ? 'OpenClaw bootstrap-build' : 'OpenClaw full-build')
    )

    const bootstrapResult = await loadOpenClawCapabilities({
      profile: 'bootstrap',
      discoverCapabilities,
    } as any)
    const fullResult = await loadOpenClawCapabilities({
      profile: 'full',
      discoverCapabilities,
    } as any)

    expect(bootstrapResult.version).toBe('OpenClaw bootstrap-build')
    expect(fullResult.version).toBe('OpenClaw full-build')
    expect(discoverCapabilities).toHaveBeenCalledTimes(2)
    expect(discoverCapabilities).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profile: 'bootstrap',
      })
    )
    expect(discoverCapabilities).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        profile: 'full',
      })
    )
  })

  it('does not let an older in-flight discovery repopulate the shared cache after reset', async () => {
    resetOpenClawCapabilitiesCache()

    const barriers = {
      first: createDeferred<void>(),
      second: createDeferred<void>(),
    }
    let phase: 'first' | 'second' = 'first'

    const discoverCapabilities = async () => {
      const callPhase = phase
      await barriers[callPhase].promise
      return createCapabilities(callPhase === 'first' ? 'OpenClaw old-build' : 'OpenClaw new-build')
    }

    const firstLoadPromise = loadOpenClawCapabilities({
      discoverCapabilities,
    })
    await Promise.resolve()

    resetOpenClawCapabilitiesCache()
    phase = 'second'
    barriers.first.resolve()

    const firstResult = await firstLoadPromise
    expect(firstResult.version).toBe('OpenClaw old-build')

    const secondLoadPromise = loadOpenClawCapabilities({
      discoverCapabilities,
    })
    barriers.second.resolve()

    const secondResult = await secondLoadPromise
    expect(secondResult.version).toBe('OpenClaw new-build')
  })
})
