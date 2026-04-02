import { describe, expect, it } from 'vitest'

import {
  collectProviderBoundEnvKeysFromStatus,
  detectResidualProviderConfiguration,
  removeResolvedErrorMessages,
  removeProviderFromConfig,
  removeProviderFromStatus,
  verifyProviderRemovalState,
} from '../ModelsPage'

describe('models-page provider cleanup', () => {
  it('removes provider models from allow/deny/aliases and model defaults', () => {
    const sourceConfig = {
      defaultModel: 'openai/gpt-4o',
      model: 'openai/gpt-4.1',
      allowed: ['openai/gpt-4o', 'anthropic/claude-3-7-sonnet'],
      allow: ['openai/o1', 'xai/grok-3'],
      denied: ['openai/o3'],
      deny: ['openai/gpt-4.1-mini', 'google/gemini-2.5-pro'],
      aliases: {
        best: 'openai/gpt-4o',
        stable: 'anthropic/claude-3-7-sonnet',
      },
      models: {
        providers: {
          openai: { enabled: true },
          anthropic: { enabled: true },
        },
        default: 'openai/gpt-4o',
        main: 'openai/gpt-4.1',
        image: 'openai/gpt-image-1',
        imageDefault: 'openai/gpt-image-1',
        allowed: ['openai/gpt-4o', 'anthropic/claude-3-7-sonnet'],
        allow: ['openai/o1'],
        denied: ['openai/o3'],
        deny: ['openai/gpt-4.1'],
        aliases: {
          code: 'openai/gpt-4.1',
          writer: 'anthropic/claude-3-7-sonnet',
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-4o',
            image: 'openai/gpt-image-1',
            fallbacks: ['openai/gpt-4.1', 'anthropic/claude-3-7-sonnet'],
          },
          models: {
            'openai/gpt-4.1': { enabled: true },
            'anthropic/claude-3-7-sonnet': { enabled: true },
          },
        },
      },
      auth: {
        profiles: {
          'openai:primary': {
            provider: 'openai',
            label: 'OpenAI',
          },
          'anthropic:backup': {
            provider: 'anthropic',
            label: 'Anthropic',
          },
        },
      },
    }

    const { nextConfig, removed } = removeProviderFromConfig(sourceConfig, 'openai')

    expect(removed).toBe(true)
    expect(nextConfig.defaultModel).toBeUndefined()
    expect(nextConfig.model).toBeUndefined()
    expect(nextConfig.allowed).toEqual(['anthropic/claude-3-7-sonnet'])
    expect(nextConfig.allow).toEqual(['xai/grok-3'])
    expect(nextConfig.denied).toEqual([])
    expect(nextConfig.deny).toEqual(['google/gemini-2.5-pro'])
    expect(nextConfig.aliases).toEqual({ stable: 'anthropic/claude-3-7-sonnet' })

    expect(nextConfig.models.providers.openai).toBeUndefined()
    expect(nextConfig.models.providers.anthropic).toEqual({ enabled: true })
    expect(nextConfig.models.default).toBeUndefined()
    expect(nextConfig.models.main).toBeUndefined()
    expect(nextConfig.models.image).toBeUndefined()
    expect(nextConfig.models.imageDefault).toBeUndefined()
    expect(nextConfig.models.allowed).toEqual(['anthropic/claude-3-7-sonnet'])
    expect(nextConfig.models.allow).toEqual([])
    expect(nextConfig.models.denied).toEqual([])
    expect(nextConfig.models.deny).toEqual([])
    expect(nextConfig.models.aliases).toEqual({ writer: 'anthropic/claude-3-7-sonnet' })
    expect(nextConfig.agents.defaults.model.primary).toBeUndefined()
    expect(nextConfig.agents.defaults.model.image).toBeUndefined()
    expect(nextConfig.agents.defaults.model.fallbacks).toEqual(['anthropic/claude-3-7-sonnet'])
    expect(nextConfig.agents.defaults.models['openai/gpt-4.1']).toBeUndefined()
    expect(nextConfig.agents.defaults.models['anthropic/claude-3-7-sonnet']).toEqual({ enabled: true })
    expect(nextConfig.auth.profiles['openai:primary']).toBeUndefined()
    expect(nextConfig.auth.profiles['anthropic:backup']).toEqual({
      provider: 'anthropic',
      label: 'Anthropic',
    })
  })

  it('treats openai-codex as openai alias during cleanup', () => {
    const sourceConfig = {
      defaultModel: 'openai/gpt-4o',
      aliases: {
        coding: 'openai/gpt-4.1',
      },
      models: {
        providers: {
          openai: { enabled: true },
          anthropic: { enabled: true },
        },
      },
    }

    const { nextConfig, removed } = removeProviderFromConfig(sourceConfig, 'openai-codex')

    expect(removed).toBe(true)
    expect(nextConfig.defaultModel).toBeUndefined()
    expect(nextConfig.aliases).toEqual({})
    expect(nextConfig.models.providers.openai).toBeUndefined()
    expect(nextConfig.models.providers.anthropic).toEqual({ enabled: true })
  })

  it('preserves unrelated legacy top-level defaultModel when removing another provider', () => {
    const sourceConfig = {
      defaultModel: 'openai/gpt-4o',
      models: {
        providers: {
          openai: { enabled: true },
          anthropic: { enabled: true },
        },
      },
    }

    const { nextConfig, removed } = removeProviderFromConfig(sourceConfig, 'anthropic')

    expect(removed).toBe(true)
    expect(nextConfig.defaultModel).toBe('openai/gpt-4o')
    expect(nextConfig.models.providers.openai).toEqual({ enabled: true })
    expect(nextConfig.models.providers.anthropic).toBeUndefined()
  })

  it('removes provider entries from oauth status snapshots', () => {
    const sourceStatus = {
      defaultModel: 'openai/gpt-5',
      model: 'openai/gpt-5',
      auth: {
        providers: [
          { provider: 'anthropic', status: 'ok' },
        ],
        oauth: {
          providers: [
            { provider: 'openai', status: 'ok', profiles: [{ profileId: 'openai:default' }] },
            { provider: 'anthropic', status: 'ok', profiles: [{ profileId: 'anthropic:default' }] },
          ],
        },
      },
    }

    const { nextStatus, removed } = removeProviderFromStatus(sourceStatus, 'openai')

    expect(removed).toBe(true)
    expect(nextStatus?.defaultModel).toBeUndefined()
    expect(nextStatus?.model).toBeUndefined()
    expect(nextStatus?.auth?.oauth?.providers).toEqual([
      { provider: 'anthropic', status: 'ok', profiles: [{ profileId: 'anthropic:default' }] },
    ])
    expect(nextStatus?.auth?.providers).toEqual([
      { provider: 'anthropic', status: 'ok' },
    ])
  })

  it('detects residual runtime auth when a canonical alias remains in model status', () => {
    const residual = detectResidualProviderConfiguration({
      providerId: 'openai',
      envVars: {
        OPENAI_API_KEY: '',
      },
      config: {
        auth: { profiles: {} },
        models: { providers: {} },
      },
      modelStatus: {
        auth: {
          storePath: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
          oauth: {
            providers: [
              {
                provider: 'openai-codex',
                status: 'ok',
                profiles: [{ profileId: 'openai-codex:default' }],
              },
            ],
          },
        },
      },
    })

    expect(residual).toEqual({
      present: true,
      source: 'status',
      authStorePath: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
    })
  })

  it('detects residual runtime provider from upstream allowed models when auth providers are absent', () => {
    const residual = detectResidualProviderConfiguration({
      providerId: 'minimax',
      envVars: {},
      config: {
        auth: { profiles: {} },
        models: { providers: {} },
      },
      modelStatus: {
        allowed: ['minimax-portal/MiniMax-M2.7', 'openai-codex/gpt-5.4'],
        defaultModel: 'minimax-portal/MiniMax-M2.7',
      },
    })

    expect(residual).toEqual({
      present: true,
      source: 'status',
      authStorePath: undefined,
    })
  })

  it('extracts exact env keys from runtime auth status instead of relying on static provider mappings', () => {
    expect(
      collectProviderBoundEnvKeysFromStatus({
        providerId: 'kimi',
        modelStatus: {
          auth: {
            providers: [
              {
                provider: 'kimi',
                effective: {
                  kind: 'env',
                  detail: 'env: KIMI_API_KEY',
                },
                env: {
                  source: 'env: KIMI_API_KEY',
                },
              },
            ],
          },
        },
      })
    ).toEqual(['KIMI_API_KEY'])
  })

  it('detects residual env keys from observed runtime bindings even when the provider is not in the static registry map', () => {
    const residual = detectResidualProviderConfiguration({
      providerId: 'kimi',
      envVars: {
        KIMI_API_KEY: 'sk-kimi-live',
      },
      config: {
        auth: { profiles: {} },
        models: { providers: {} },
      },
      modelStatus: null,
      observedEnvKeys: ['KIMI_API_KEY'],
    } as any)

    expect(residual).toEqual({
      present: true,
      source: 'env',
    })
  })

  it('fails removal verification when a known provider env key still exists even if runtime omits env binding details', async () => {
    const verification = await verifyProviderRemovalState(
      {
        provider: {
          id: 'openai',
          name: 'OpenAI',
        },
        currentStatusSnapshot: {
          auth: {
            providers: [{ provider: 'openai', status: 'ok' }],
          },
        },
      },
      {
        readEnvFile: async () => ({
          OPENAI_API_KEY: 'sk-openai-still-there',
        }),
        readConfig: async () => ({
          auth: { profiles: {} },
          models: { providers: {} },
        }),
        readUpstreamState: async () => ({
          ok: true,
          source: 'control-ui-app',
          fallbackUsed: false,
          diagnostics: {
            upstreamAvailable: true,
            connected: true,
            hasClient: true,
            hasHelloSnapshot: true,
            hasHealthResult: true,
            hasSessionsState: false,
            hasModelCatalogState: false,
            appKeys: [],
          },
          data: {
            source: 'control-ui-app',
            connected: true,
            hasClient: true,
            appKeys: [],
            modelStatusLike: {
              auth: {
                providers: [{ provider: 'anthropic', status: 'ok' }],
              },
            },
          },
        }),
        inspectAuthStore: async () => ({
          ok: true,
          present: false,
          matchedProfileIds: [],
          matchedLastGoodKeys: [],
        }),
      }
    )

    expect(verification).toEqual({
      ok: false,
      message: 'AI 提供商「OpenAI」的环境变量密钥仍未清空',
    })
  })

  it('does not clear a shared env key when another configured provider still needs it', async () => {
    const modelsPageModule = await import('../ModelsPage')
    const resolveProviderRemovalEnvKeys = (modelsPageModule as any).resolveProviderRemovalEnvKeys

    expect(typeof resolveProviderRemovalEnvKeys).toBe('function')
    expect(
      resolveProviderRemovalEnvKeys({
        providerId: 'openai',
        candidateEnvKeys: ['OPENAI_API_KEY'],
        config: {
          auth: {
            profiles: {
              'custom-openai:local': {
                provider: 'custom-openai',
              },
            },
          },
        },
        modelStatus: {
          auth: {
            providers: [{ provider: 'custom-openai', status: 'ok' }],
          },
        },
      })
    ).toEqual([])
  })

  it('ignores a shared env key during openai removal verification when custom-openai is still configured', async () => {
    const verification = await verifyProviderRemovalState(
      {
        provider: {
          id: 'openai',
          name: 'OpenAI',
        },
        currentStatusSnapshot: {
          auth: {
            providers: [{ provider: 'openai', status: 'ok' }],
          },
        },
      },
      {
        readEnvFile: async () => ({
          OPENAI_API_KEY: 'sk-shared',
        }),
        readConfig: async () => ({
          auth: {
            profiles: {
              'custom-openai:local': {
                provider: 'custom-openai',
              },
            },
          },
          models: { providers: {} },
        }),
        readUpstreamState: async () => ({
          ok: true,
          source: 'control-ui-app',
          fallbackUsed: false,
          diagnostics: {
            upstreamAvailable: true,
            connected: true,
            hasClient: true,
            hasHelloSnapshot: true,
            hasHealthResult: true,
            hasSessionsState: false,
            hasModelCatalogState: false,
            appKeys: [],
          },
          data: {
            source: 'control-ui-app',
            connected: true,
            hasClient: true,
            appKeys: [],
            modelStatusLike: {
              auth: {
                providers: [{ provider: 'custom-openai', status: 'ok' }],
              },
            },
          },
        }),
        inspectAuthStore: async () => ({
          ok: true,
          present: false,
          matchedProfileIds: [],
          matchedLastGoodKeys: [],
        }),
      }
    )

    expect(verification).toEqual({
      ok: true,
      authStorePath: undefined,
    })
  })

  it('accepts provider removal when upstream model catalog no longer includes that provider', async () => {
    const verification = await verifyProviderRemovalState(
      {
        provider: {
          id: 'minimax',
          name: 'MiniMax',
        },
        currentStatusSnapshot: null,
      },
      {
        readEnvFile: async () => ({
          MINIMAX_API_KEY: '',
        }),
        readConfig: async () => ({
          auth: { profiles: {} },
          models: { providers: {} },
        }),
        readUpstreamState: async () => ({
          ok: true,
          source: 'control-ui-app',
          fallbackUsed: false,
          diagnostics: {
            upstreamAvailable: true,
            connected: true,
            hasClient: true,
            hasHelloSnapshot: true,
            hasHealthResult: true,
            hasSessionsState: false,
            hasModelCatalogState: false,
            appKeys: [],
          },
          data: {
            source: 'control-ui-app',
            connected: true,
            hasClient: true,
            appKeys: [],
            modelStatusLike: {
              allowed: ['openai-codex/gpt-5.4'],
            },
            catalogItemsLike: [
              {
                key: 'openai-codex/gpt-5.4',
                provider: 'openai-codex',
                available: true,
              },
            ],
            catalogSummaryLike: {
              totalItems: 1,
              availableItems: 1,
              providerKeys: ['openai-codex'],
            },
          },
        }),
        inspectAuthStore: async () => ({
          ok: true,
          present: false,
          matchedProfileIds: [],
          matchedLastGoodKeys: [],
        }),
      }
    )

    expect(verification).toEqual({
      ok: true,
      authStorePath: undefined,
    })
  })

  it('fails closed when upstream runtime state is unavailable after local cleanup', async () => {
    const verification = await verifyProviderRemovalState(
      {
        provider: {
          id: 'openai',
          name: 'OpenAI',
        },
        currentStatusSnapshot: {
          auth: {
            storePath: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
          },
        },
      },
      {
        readEnvFile: async () => ({
          OPENAI_API_KEY: '',
        }),
        readConfig: async () => ({
          auth: { profiles: {} },
          models: { providers: {} },
        }),
        readUpstreamState: async () => ({
          ok: false,
          source: 'control-ui-app',
          fallbackUsed: true,
          fallbackReason: 'control-ui unavailable',
          diagnostics: {
            upstreamAvailable: false,
            connected: false,
            hasClient: false,
            hasHelloSnapshot: false,
            hasHealthResult: false,
            hasSessionsState: false,
            hasModelCatalogState: false,
            appKeys: [],
            lastError: 'control-ui unavailable',
          },
        }),
        inspectAuthStore: async () => ({
          ok: true,
          present: false,
          matchedProfileIds: [],
          matchedLastGoodKeys: [],
          authStorePath: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
        }),
      }
    )

    expect(verification.ok).toBe(false)
    expect(verification.authStorePath).toBe('/Users/example/.openclaw/agents/main/agent/auth-profiles.json')
    expect(verification.message).toContain('无法确认运行状态')
  })

  it('keeps auth store hints when upstream still reports the provider but omits storePath', async () => {
    const verification = await verifyProviderRemovalState(
      {
        provider: {
          id: 'openai',
          name: 'OpenAI',
        },
        currentStatusSnapshot: {
          auth: {
            storePath: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
          },
        },
        authStorePathHint: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
      },
      {
        readEnvFile: async () => ({
          OPENAI_API_KEY: '',
        }),
        readConfig: async () => ({
          auth: { profiles: {} },
          models: { providers: {} },
        }),
        readUpstreamState: async () => ({
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
          data: {
            source: 'control-ui-app',
            connected: true,
            hasClient: true,
            appKeys: [],
            modelStatusLike: {
              allowed: ['openai-codex/gpt-5.4'],
              defaultModel: 'openai-codex/gpt-5.4',
            },
          },
        }),
        inspectAuthStore: async () => ({
          ok: true,
          present: false,
          matchedProfileIds: [],
          matchedLastGoodKeys: [],
          authStorePath: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
        }),
      }
    )

    expect(verification).toEqual({
      ok: false,
      message: 'AI 提供商「OpenAI」的本地配置已删除，但运行状态仍检测到认证信息',
      authStorePath: '/Users/example/.openclaw/agents/main/agent/auth-profiles.json',
    })
  })

  it('removes resolved non-blocking cleanup errors while preserving unrelated issues', () => {
    const nextError = removeResolvedErrorMessages(
      'AI 提供商配置已删除，但认证配置清理失败：请稍后重试；网关重载失败：请手动处理',
      ['AI 提供商配置已删除，但认证配置清理失败：请稍后重试']
    )

    expect(nextError).toBe('网关重载失败：请手动处理')
  })

  it('builds an optimistic configured snapshot so a newly added provider stays visible during refresh', async () => {
    const modelsPageModule = await import('../ModelsPage')
    const applyOptimisticConfiguredProviderState = (modelsPageModule as any).applyOptimisticConfiguredProviderState

    expect(typeof applyOptimisticConfiguredProviderState).toBe('function')

    const result = applyOptimisticConfiguredProviderState({
      config: null,
      statusData: null,
      catalog: [],
      context: {
        providerId: 'zai',
        methodId: 'zai-api-key',
        methodType: 'apiKey',
        providerStatusIds: ['zai'],
        needsInitialization: false,
        preferredModelKey: 'zai/glm-4.6',
      },
    })

    expect(result.nextConfig).toEqual({
      models: {
        providers: {
          zai: {
            enabled: true,
            models: [
              {
                id: 'glm-4.6',
                name: 'glm-4.6',
              },
            ],
          },
        },
      },
    })
    expect(result.nextStatus).toEqual({
      auth: {
        providers: [
          {
            provider: 'zai',
            status: 'ok',
          },
        ],
      },
      defaultModel: 'zai/glm-4.6',
      resolvedDefault: 'zai/glm-4.6',
    })
    expect(result.nextCatalog).toEqual([
      {
        key: 'zai/glm-4.6',
        name: 'glm-4.6',
        provider: 'zai',
        local: false,
        available: true,
        tags: ['configured'],
        missing: [],
      },
    ])
  })
})
