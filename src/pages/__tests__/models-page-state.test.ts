import { describe, expect, it } from 'vitest'
import {
  buildModelsPageConfiguredProviders,
  canSwitchModelsPageCatalogItem,
  dedupeModelsPageCatalogByRuntimeKey,
  filterModelsPageCatalogByConfiguredProviders,
  filterConfiguredProvidersWithVisibleModels,
  getModelsPageProviderModels,
  resolveConfiguredProviderRuntimeState,
  resolveModelsPageCatalogState,
  resolveModelsPageActiveModel,
  resolveVisibleConfiguredActiveModel,
} from '../models-page-state'
import { filterCatalogForDisplay, reconcileCatalogAvailabilityWithStatus } from '../../lib/model-catalog-display'

describe('models page state helpers', () => {
  it('prefers status default model and falls back to config.defaultModel', () => {
    expect(
      resolveModelsPageActiveModel(
        {
          defaultModel: 'openai/gpt-5.4-pro',
        },
        {
          defaultModel: 'openai/gpt-5',
        }
      )
    ).toBe('openai/gpt-5.4-pro')

    expect(
      resolveModelsPageActiveModel(null, {
        defaultModel: 'openai/gpt-5',
      })
    ).toBe('openai/gpt-5')
  })

  it('canonicalizes oauth provider ids into a single configured provider card', () => {
    const providers = buildModelsPageConfiguredProviders({
      envVars: null,
      config: {
        auth: {
          profiles: {
            'openai-codex:default': {},
          },
        },
      },
      statusData: {
        auth: {
          providers: [{ provider: 'openai-codex', status: 'ok' }],
        },
        defaultModel: 'openai/gpt-5.4-pro',
      },
    })

    expect(providers).toEqual([
      expect.objectContaining({
        id: 'openai',
        name: 'OpenAI',
      }),
    ])
  })

  it('prefers locally saved provider snapshots over runtime status to keep cards stable', () => {
    const providers = buildModelsPageConfiguredProviders({
      envVars: {
        OPENAI_API_KEY: 'sk-stale',
      },
      config: {
        auth: {
          profiles: {
            'openai:default': {},
          },
        },
      },
      statusData: {
        auth: {
          providers: [{ provider: 'anthropic', status: 'ok' }],
        },
        defaultModel: 'anthropic/claude-sonnet-4-6',
      },
    })

    expect(providers).toEqual([
      expect.objectContaining({
        id: 'openai',
        name: 'OpenAI',
      }),
    ])
  })

  it('does not infer an OpenAI card from a shared env key when custom-openai is the saved provider snapshot', () => {
    const providers = buildModelsPageConfiguredProviders({
      envVars: {
        OPENAI_API_KEY: 'sk-shared',
      },
      config: {
        auth: {
          profiles: {
            'custom-openai:local': {
              provider: 'custom-openai',
            },
          },
        },
      },
      statusData: null,
    })

    expect(providers).toEqual([
      expect.objectContaining({
        id: 'custom-openai',
      }),
    ])
    expect(providers.find((provider) => provider.id === 'openai')).toBeUndefined()
  })

  it('falls back to config/env provider snapshots when status has no configured providers', () => {
    const providers = buildModelsPageConfiguredProviders({
      envVars: null,
      config: {
        models: {
          openai: {
            enabled: true,
          },
        },
      },
      statusData: {
        auth: {
          providers: [],
        },
        defaultModel: 'openai/gpt-5.1-codex',
      },
    })

    expect(providers).toEqual([
      expect.objectContaining({
        id: 'openai',
        name: 'OpenAI',
      }),
    ])
  })

  it('does not infer a configured provider card from a fallback active model alone', () => {
    const providers = buildModelsPageConfiguredProviders({
      envVars: null,
      config: null,
      statusData: {
        auth: {
          providers: [],
        },
        defaultModel: 'anthropic/claude-opus-4-6',
      },
    })

    expect(providers).toEqual([])
  })

  it('keeps only providers that have visible catalog models in the current mode', () => {
    const providers = filterConfiguredProvidersWithVisibleModels(
      [
        { id: 'anthropic', name: 'Anthropic', logo: '🔮' },
        { id: 'openai', name: 'OpenAI', logo: '🤖' },
      ],
      [
        { key: 'openai/gpt-5', provider: 'openai', available: true },
      ]
    )

    expect(providers).toEqual([
      expect.objectContaining({
        id: 'openai',
      }),
    ])
  })

  it('keeps configured providers before the catalog snapshot has loaded', () => {
    const providers = filterConfiguredProvidersWithVisibleModels(
      [
        { id: 'openai', name: 'OpenAI', logo: '🤖' },
      ],
      []
    )

    expect(providers).toEqual([
      expect.objectContaining({
        id: 'openai',
      }),
    ])
  })

  it('keeps configured providers visible when they only have unavailable models in the current mode', () => {
    const providers = filterConfiguredProvidersWithVisibleModels(
      [
        { id: 'openai', name: 'OpenAI', logo: '🤖' },
      ],
      [],
      [
        { key: 'openai/gpt-5', provider: 'openai', available: false },
      ]
    )

    expect(providers).toEqual([
      expect.objectContaining({
        id: 'openai',
      }),
    ])
  })

  it('scopes catalog counts to configured providers only', () => {
    const scopedCatalog = filterModelsPageCatalogByConfiguredProviders(
      [
        { key: 'openai/gpt-5', provider: 'openai', available: true },
        { key: 'anthropic/claude-opus-4-6', provider: 'anthropic', available: true },
      ],
      [
        { id: 'openai', name: 'OpenAI', logo: '🤖' },
      ]
    )

    expect(scopedCatalog).toEqual([
      {
        key: 'openai/gpt-5',
        provider: 'openai',
        available: true,
      },
    ])
  })

  it('deduplicates canonical and alias catalog records for the same runtime model', () => {
    const deduped = dedupeModelsPageCatalogByRuntimeKey([
      {
        key: 'openai/gpt-5.4',
        provider: 'openai',
        name: 'GPT-5.4',
        available: false,
      },
      {
        key: 'openai-codex/gpt-5.4',
        provider: 'openai-codex',
        name: 'GPT-5.4',
        available: true,
        tags: ['default', 'configured'],
      },
      {
        key: 'openai-codex/gpt-5.4-mini',
        provider: 'openai-codex',
        name: 'GPT-5.4 Mini',
        available: true,
      },
    ])

    expect(deduped).toEqual([
      {
        key: 'openai-codex/gpt-5.4',
        provider: 'openai-codex',
        name: 'GPT-5.4',
        available: true,
        tags: ['default', 'configured'],
      },
      {
        key: 'openai-codex/gpt-5.4-mini',
        provider: 'openai-codex',
        name: 'GPT-5.4 Mini',
        available: true,
      },
    ])
  })

  it('prefers the exact active model key when deduplicating alias-equivalent entries', () => {
    const deduped = dedupeModelsPageCatalogByRuntimeKey(
      [
        {
          key: 'minimax/MiniMax-M2.5',
          provider: 'minimax',
          name: 'MiniMax M2.5',
          available: true,
        },
        {
          key: 'minimax-portal/MiniMax-M2.5',
          provider: 'minimax-portal',
          name: 'MiniMax M2.5',
          available: true,
        },
      ],
      {
        preferredModelKey: 'minimax-portal/MiniMax-M2.5',
      }
    )

    expect(deduped).toEqual([
      {
        key: 'minimax-portal/MiniMax-M2.5',
        provider: 'minimax-portal',
        name: 'MiniMax M2.5',
        available: true,
      },
    ])
  })

  it('only shows the active model when its provider is configured and the model is available', () => {
    const activeModel = resolveVisibleConfiguredActiveModel({
      statusData: {
        auth: {
          providers: [],
        },
        defaultModel: 'anthropic/claude-opus-4-6',
      },
      configData: null,
      configuredProviders: [],
      visibleCatalog: [
        {
          key: 'anthropic/claude-opus-4-6',
          provider: 'anthropic',
          available: true,
        },
      ],
    })

    expect(activeModel).toBe('')

    expect(
      resolveVisibleConfiguredActiveModel({
        statusData: {
          auth: {
            providers: [{ provider: 'openai', status: 'ok' }],
          },
          defaultModel: 'openai/gpt-5',
        },
        configData: null,
        configuredProviders: [{ id: 'openai', name: 'OpenAI', logo: '🤖' }],
        visibleCatalog: [
          {
            key: 'openai/gpt-5',
            provider: 'openai',
            available: true,
          },
        ],
      })
    ).toBe('openai/gpt-5')
  })

  it('keeps showing a configured active model before the catalog snapshot has loaded', () => {
    expect(
      resolveVisibleConfiguredActiveModel({
        statusData: {
          defaultModel: 'openai/gpt-5.1-codex',
        },
        configData: {
          models: {
            openai: {
              enabled: true,
            },
          },
        },
        configuredProviders: [{ id: 'openai', name: 'OpenAI', logo: '🤖' }],
        visibleCatalog: [],
      })
    ).toBe('openai/gpt-5.1-codex')
  })

  it('keeps showing the active model in all-mode style views when it is only present in the full catalog', () => {
    expect(
      resolveVisibleConfiguredActiveModel({
        statusData: {
          defaultModel: 'openai/gpt-5',
        },
        configData: null,
        configuredProviders: [{ id: 'openai', name: 'OpenAI', logo: '🤖' }],
        visibleCatalog: [
          {
            key: 'openai/gpt-4.1',
            provider: 'openai',
            available: true,
          },
          {
            key: 'openai/gpt-5',
            provider: 'openai',
            available: false,
          },
        ],
        fullCatalog: [
          {
            key: 'openai/gpt-4.1',
            provider: 'openai',
            available: true,
          },
          {
            key: 'openai/gpt-5',
            provider: 'openai',
            available: false,
          },
        ],
      })
    ).toBe('openai/gpt-5')
  })

  it('maps alias-reported active models to the canonical visible catalog key', () => {
    expect(
      resolveVisibleConfiguredActiveModel({
        statusData: {
          defaultModel: 'minimax-portal/MiniMax-M2.5',
        },
        configData: null,
        configuredProviders: [{ id: 'minimax', name: 'MiniMax', logo: 'M' }],
        visibleCatalog: [
          {
            key: 'minimax/MiniMax-M2.5',
            provider: 'minimax',
            available: true,
          },
        ],
      })
    ).toBe('minimax/MiniMax-M2.5')
  })

  it('matches provider cards to catalog entries through canonicalized provider ids', () => {
    const models = getModelsPageProviderModels('google', [
      { key: 'google/gemini-2.5-pro', provider: 'google' },
      { key: 'openai/gpt-5', provider: 'openai' },
    ])

    expect(models).toEqual([{ key: 'google/gemini-2.5-pro', provider: 'google' }])
  })

  it('keeps minimax provider visible in available mode when local config exists but status.allowed only exposes minimax-portal aliases', () => {
    const statusData = {
      auth: {
        providers: [{ provider: 'minimax-portal', status: 'ok' }],
      },
      allowed: ['minimax-portal/MiniMax-M2.5'],
      defaultModel: 'minimax-portal/MiniMax-M2.5',
    }

    const providers = buildModelsPageConfiguredProviders({
      envVars: {
        MINIMAX_API_KEY: 'mm-local',
      },
      config: null,
      statusData,
    })
    const reconciledCatalog = reconcileCatalogAvailabilityWithStatus(
      [
        { key: 'minimax/MiniMax-M2.5', provider: 'minimax', available: false },
      ],
      statusData
    )
    const visibleCatalog = filterCatalogForDisplay(reconciledCatalog, 'available')

    expect(
      filterConfiguredProvidersWithVisibleModels(providers, visibleCatalog, reconciledCatalog)
    ).toEqual([
      expect.objectContaining({
        id: 'minimax',
        name: 'MiniMax',
      }),
    ])
  })

  it('keeps provider cards stable but only shows runtime-confirmed models in available mode', () => {
    const state = resolveModelsPageCatalogState({
      catalog: [
        { key: 'google/gemini-3-pro-preview', provider: 'google', available: true },
        { key: 'google/gemini-2.5-pro', provider: 'google', available: true },
        { key: 'google/gemini-1.5-flash', provider: 'google', available: false },
        { key: 'openai/gpt-5', provider: 'openai', available: true },
      ],
      envVars: {
        GEMINI_API_KEY: 'google-local',
      },
      config: null,
      statusData: {
        auth: {
          providers: [{ provider: 'google', status: 'ok' }],
        },
        allowed: ['google/gemini-3-pro-preview'],
        defaultModel: 'google/gemini-3-pro-preview',
      },
      mode: 'available',
    })

    expect(state.configuredProviders).toEqual([
      expect.objectContaining({
        id: 'google',
      }),
    ])
    expect(state.visibleCatalog).toEqual([
      {
        key: 'google/gemini-3-pro-preview',
        provider: 'google',
        available: true,
        verificationState: 'verified-available',
      },
    ])
    expect(state.scopedCatalog).toEqual([
      {
        key: 'google/gemini-3-pro-preview',
        provider: 'google',
        available: true,
        verificationState: 'verified-available',
      },
      {
        key: 'google/gemini-2.5-pro',
        provider: 'google',
        available: false,
        verificationState: 'unverified',
      },
      {
        key: 'google/gemini-1.5-flash',
        provider: 'google',
        available: false,
        verificationState: 'unverified',
      },
    ])
  })

  it('keeps locally saved provider cards even when runtime has not confirmed any models yet', () => {
    const state = resolveModelsPageCatalogState({
      catalog: [
        { key: 'zai/glm-4.5-flash', provider: 'zai', available: true },
        { key: 'zai/glm-4.5', provider: 'zai', available: true },
      ],
      envVars: {
        ZAI_API_KEY: 'zai-local',
      },
      config: null,
      statusData: {
        auth: {
          providers: [{ provider: 'zai', status: 'ok' }],
        },
        allowed: [],
      },
      mode: 'available',
    })

    expect(state.configuredProviders).toEqual([
      expect.objectContaining({
        id: 'zai',
      }),
    ])
    expect(state.visibleCatalog).toEqual([])
    expect(state.scopedCatalog).toEqual([
      {
        key: 'zai/glm-4.5-flash',
        provider: 'zai',
        available: false,
        verificationState: 'unverified',
      },
      {
        key: 'zai/glm-4.5',
        provider: 'zai',
        available: false,
        verificationState: 'unverified',
      },
    ])
  })

  it('treats configured provider catalog entries as unverified by default even when the raw catalog says available', () => {
    const state = resolveModelsPageCatalogState({
      catalog: [
        { key: 'openai/gpt-5', provider: 'openai', available: true },
        { key: 'openai/gpt-4.1', provider: 'openai', available: true },
      ],
      envVars: {
        OPENAI_API_KEY: 'openai-local',
      },
      config: null,
      statusData: null,
      mode: 'all',
    })

    expect(state.visibleCatalog).toEqual([
      {
        key: 'openai/gpt-5',
        provider: 'openai',
        available: false,
        verificationState: 'unverified',
      },
      {
        key: 'openai/gpt-4.1',
        provider: 'openai',
        available: false,
        verificationState: 'unverified',
      },
    ])
  })

  it('merges provider models from local config into the scoped catalog even when the runtime catalog is missing them', () => {
    const state = resolveModelsPageCatalogState({
      catalog: [
        { key: 'zai/glm-5', provider: 'zai', available: true },
      ],
      envVars: {
        ZAI_API_KEY: 'zai-local',
      },
      config: {
        models: {
          providers: {
            zai: {
              enabled: true,
              models: [
                { id: 'glm-5', name: 'GLM-5' },
                { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash' },
                { id: 'glm-4.5v', name: 'GLM-4.5V' },
              ],
            },
          },
        },
      },
      statusData: {
        auth: {
          providers: [{ provider: 'zai', status: 'ok' }],
        },
        allowed: ['zai/glm-5'],
        defaultModel: 'zai/glm-5',
      },
      mode: 'all',
    })

    expect(state.visibleCatalog).toEqual([
      {
        key: 'zai/glm-5',
        provider: 'zai',
        name: 'GLM-5',
        available: true,
        verificationState: 'verified-available',
        tags: ['configured'],
      },
      {
        key: 'zai/glm-4.5-flash',
        provider: 'zai',
        name: 'GLM-4.5 Flash',
        available: false,
        verificationState: 'unverified',
        tags: ['configured'],
      },
      {
        key: 'zai/glm-4.5v',
        provider: 'zai',
        name: 'GLM-4.5V',
        available: false,
        verificationState: 'unverified',
        tags: ['configured'],
      },
    ])
  })

  it('keeps custom-openai visible by merging runtime default models when the shared catalog has no provider entries yet', () => {
    const state = resolveModelsPageCatalogState({
      catalog: [],
      envVars: {
        OPENAI_BASE_URL: 'http://192.168.31.139:12995/v1',
      },
      config: null,
      statusData: {
        auth: {
          providers: [{ provider: 'custom-openai', status: 'static', profiles: [{ profileId: 'custom-openai:local' }] }],
        },
        defaultModel: 'custom-openai/gpt-4',
        resolvedDefault: 'custom-openai/gpt-4',
      },
      mode: 'all',
    })

    expect(state.configuredProviders).toEqual([
      expect.objectContaining({
        id: 'custom-openai',
        name: '自定义 OpenAI 兼容',
      }),
    ])
    expect(state.visibleCatalog).toEqual([
      {
        key: 'custom-openai/gpt-4',
        provider: 'custom-openai',
        name: 'gpt-4',
        available: true,
        verificationState: 'verified-available',
        tags: ['configured'],
      },
    ])
    expect(state.scopedCatalog).toEqual([
      {
        key: 'custom-openai/gpt-4',
        provider: 'custom-openai',
        name: 'gpt-4',
        available: true,
        verificationState: 'verified-available',
        tags: ['configured'],
      },
    ])
  })

  it('applies persisted verification records across alias-equivalent minimax models in the merged provider card', () => {
    const state = resolveModelsPageCatalogState({
      catalog: [
        { key: 'minimax/MiniMax-M2.5', provider: 'minimax', available: true },
        { key: 'minimax/MiniMax-M2.7', provider: 'minimax', available: true },
      ],
      envVars: {
        MINIMAX_API_KEY: 'minimax-local',
      },
      config: null,
      statusData: {
        auth: {
          providers: [{ provider: 'minimax-portal', status: 'ok' }],
        },
        allowed: ['minimax-portal/MiniMax-M2.7'],
        defaultModel: 'minimax-portal/MiniMax-M2.7',
      },
      verificationRecords: [
        {
          modelKey: 'minimax-portal/MiniMax-M2.5',
          runtimeKey: 'minimax/minimax-m2.5',
          verificationState: 'verified-unavailable',
          source: 'switch-failed',
          updatedAt: '2026-03-26T00:00:00.000Z',
        },
      ],
      mode: 'all',
    })

    expect(state.visibleCatalog).toEqual([
      {
        key: 'minimax/MiniMax-M2.5',
        provider: 'minimax',
        available: false,
        verificationState: 'verified-unavailable',
      },
      {
        key: 'minimax/MiniMax-M2.7',
        provider: 'minimax',
        available: true,
        verificationState: 'verified-available',
      },
    ])
  })

  it('allows switching configured, unverified, and verified unavailable models', () => {
    expect(
      canSwitchModelsPageCatalogItem({
        key: 'zai/glm-4.5-flash',
        provider: 'zai',
        available: false,
        tags: ['configured'],
      })
    ).toBe(true)

    expect(
      canSwitchModelsPageCatalogItem({
        key: 'zai/glm-4.5-flash',
        provider: 'zai',
        available: false,
        tags: [],
      })
    ).toBe(true)

    expect(
      canSwitchModelsPageCatalogItem({
        key: 'zai/glm-5',
        provider: 'zai',
        available: true,
      })
    ).toBe(true)

    expect(
      canSwitchModelsPageCatalogItem({
        key: 'openai/gpt-5',
        provider: 'openai',
        available: false,
        verificationState: 'verified-unavailable',
      })
    ).toBe(true)
  })

  it('does not show provider cards from runtime status alone when there is no local saved config', () => {
    const providers = buildModelsPageConfiguredProviders({
      envVars: null,
      config: null,
      statusData: {
        auth: {
          providers: [{ provider: 'google', status: 'ok' }],
        },
        defaultModel: 'google/gemini-2.5-pro',
      },
    })

    expect(providers).toEqual([])
  })

  it('marks providers as saved when local config exists but runtime status is unavailable', () => {
    expect(
      resolveConfiguredProviderRuntimeState({
        providerId: 'zai',
        statusData: null,
      })
    ).toEqual({
      code: 'saved',
      label: '已保存',
      color: 'gray',
    })
  })

  it('marks providers as syncing when runtime has not confirmed them yet', () => {
    expect(
      resolveConfiguredProviderRuntimeState({
        providerId: 'zai',
        statusData: {
          auth: {
            providers: [{ provider: 'zai', status: 'missing' }],
          },
        },
      })
    ).toEqual({
      code: 'syncing',
      label: '同步中',
      color: 'blue',
    })
  })

  it('marks providers as active when runtime confirms auth or models', () => {
    expect(
      resolveConfiguredProviderRuntimeState({
        providerId: 'google',
        statusData: {
          auth: {
            providers: [{ provider: 'google', status: 'ok' }],
          },
        },
      })
    ).toEqual({
      code: 'active',
      label: '已生效',
      color: 'green',
    })

    expect(
      resolveConfiguredProviderRuntimeState({
        providerId: 'zai',
        statusData: {
          allowed: ['zai/glm-4.5-flash'],
          defaultModel: 'zai/glm-4.5-flash',
        },
      })
    ).toEqual({
      code: 'active',
      label: '已生效',
      color: 'green',
    })
  })

  it('marks providers as active when the provider catalog already contains verified available models', () => {
    expect(
      resolveConfiguredProviderRuntimeState({
        providerId: 'ollama',
        statusData: {
          auth: {
            providers: [{ provider: 'ollama', status: 'missing' }],
          },
          allowed: [],
        },
        catalog: [
          {
            key: 'ollama/qwen2.5:7b',
            provider: 'ollama',
            available: true,
            verificationState: 'verified-available',
          },
        ],
      })
    ).toEqual({
      code: 'active',
      label: '已生效',
      color: 'green',
    })
  })

  it('keeps explicit runtime errors visible even when the catalog still has verified models', () => {
    expect(
      resolveConfiguredProviderRuntimeState({
        providerId: 'ollama',
        statusData: {
          auth: {
            providers: [{ provider: 'ollama', status: 'error' }],
          },
        },
        catalog: [
          {
            key: 'ollama/qwen2.5:7b',
            provider: 'ollama',
            available: true,
            verificationState: 'verified-available',
          },
        ],
      })
    ).toEqual({
      code: 'error',
      label: '异常',
      color: 'red',
    })
  })

  it('marks providers as error when runtime reports explicit failures', () => {
    expect(
      resolveConfiguredProviderRuntimeState({
        providerId: 'openai',
        statusData: {
          auth: {
            providers: [{ provider: 'openai', status: 'error' }],
          },
        },
      })
    ).toEqual({
      code: 'error',
      label: '异常',
      color: 'red',
    })
  })
})
