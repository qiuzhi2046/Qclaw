import { describe, expect, it, vi } from 'vitest'
import { applyAgentPrimaryModelWithGatewayReload, applyDefaultModelWithGatewayReload } from '../model-config-gateway'

describe('applyDefaultModelWithGatewayReload', () => {
  it('keeps legacy defaultModel as a read fallback without writing it back', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        defaultModel: 'openai/gpt-5',
      })
      .mockResolvedValueOnce({
        defaultModel: 'openai/gpt-5.4-pro',
      })
    const applyConfigPatchGuarded = vi.fn(async ({ afterConfig }) => {
      expect(afterConfig).toEqual({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.4-pro',
            },
          },
        },
      })
      return { ok: true, wrote: true }
    })

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'openai/gpt-5.4-pro',
        },
      }),
      reloadGatewayAfterModelChange: async () => ({ ok: true, running: true }),
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
  })

  it('writes config and confirms the model without reloading the gateway when status catches up', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
        defaultModel: 'openai/gpt-5',
      })
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.4-pro',
            },
          },
        },
      })
    const applyConfigPatchGuarded = vi.fn(async () => ({ ok: true, wrote: true }))
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'openai/gpt-5.4-pro',
      },
    }))
    const reloadGatewayAfterModelChange = vi.fn(async () => ({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    }))

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyConfigPatchGuarded,
      getModelStatus,
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
    expect(applyConfigPatchGuarded).toHaveBeenCalledWith({
      beforeConfig: {
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
        defaultModel: 'openai/gpt-5',
      },
      afterConfig: {
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.4-pro',
            },
          },
        },
      },
      reason: 'unknown',
    })
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })

  it('pins main as the default agent when saving the default model into a multi-agent config', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
            { id: 'main', model: 'openai/gpt-5' },
          ],
        },
      })
      .mockResolvedValue({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.4-pro',
            },
          },
          list: [
            { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
            { id: 'main', model: 'openai/gpt-5', default: true },
          ],
        },
      })

    const applyConfigPatchGuarded = vi.fn(async ({ afterConfig }) => {
      expect(afterConfig).toEqual({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.4-pro',
            },
          },
          list: [
            { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
            { id: 'main', model: 'openai/gpt-5', default: true },
          ],
        },
      })
      return { ok: true, wrote: true }
    })

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'openai/gpt-5.4-pro',
        },
      }),
      reloadGatewayAfterModelChange: async () => ({ ok: true, running: true }),
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(true)
  })

  it('treats a guarded config write failure as a hard failure', async () => {
    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig: async () => ({}),
      applyConfigPatchGuarded: async () => ({ ok: false, message: 'write failed' }),
      getModelStatus: async () => ({ ok: true, data: { defaultModel: 'openai/gpt-5.4-pro' } }),
      reloadGatewayAfterModelChange: async () => ({ ok: true, running: true }),
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.modelApplied).toBe(false)
    expect(result.gatewayReloaded).toBe(false)
    expect(result.message).toContain('write failed')
  })

  it('falls back to gateway reload when runtime status never catches up even though config is already updated', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
        defaultModel: 'openai/gpt-5',
      })
      .mockResolvedValue({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.4-pro',
            },
          },
        },
      })
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'openai/gpt-5',
      },
    }))
    const reloadGatewayAfterModelChange = vi.fn(async () => ({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    }))

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus,
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.modelApplied).toBe(true)
    expect(result.gatewayReloaded).toBe(true)
    expect(result.message).toContain('当前仍未确认模型状态刷新完成')
    expect(reloadGatewayAfterModelChange).toHaveBeenCalledTimes(1)
  })

  it('surfaces a partial-success warning when the fallback reload fails', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
      })
      .mockResolvedValue({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
      })

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus: async () => ({ ok: true, data: { defaultModel: 'openai/gpt-5' } }),
      reloadGatewayAfterModelChange: async () => ({ ok: false, stdout: '', stderr: 'restart failed', code: 1 }),
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.modelApplied).toBe(true)
    expect(result.gatewayReloaded).toBe(false)
    expect(result.message).toContain('运行状态尚未确认生效')
  })

  it('does not report success when runtime already matches but config never updates', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
        defaultModel: 'openai/gpt-5',
      })
      .mockResolvedValue({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
      })

    const reloadGatewayAfterModelChange = vi.fn(async () => ({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    }))

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus: async () => ({ ok: true, data: { defaultModel: 'openai/gpt-5.4-pro' } }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.modelApplied).toBe(true)
    expect(result.gatewayReloaded).toBe(true)
    expect(reloadGatewayAfterModelChange).toHaveBeenCalledTimes(1)
  })

  it('does not fail closed when a configured oauth alias covers the missing provider warning', async () => {
    let currentConfig: Record<string, any> | null = {}
    const readConfig = vi.fn(async () => currentConfig)
    const applyConfigPatchGuarded = vi.fn(async ({ afterConfig }: { afterConfig: Record<string, any> }) => {
      currentConfig = afterConfig
      return { ok: true, wrote: true }
    })
    const reloadGatewayAfterModelChange = vi.fn(async () => ({ ok: true, running: true }))

    const result = await applyDefaultModelWithGatewayReload({
      model: 'minimax/MiniMax-M2.1-highspeed',
      readConfig,
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'minimax/MiniMax-M2.1-highspeed',
          auth: {
            missingProvidersInUse: ['minimax'],
            oauth: {
              providers: [{ provider: 'minimax-portal', status: 'ok' }],
            },
          },
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.modelApplied).toBe(true)
    expect(result.gatewayReloaded).toBe(false)
    expect(applyConfigPatchGuarded).toHaveBeenCalledTimes(1)
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })

  it('does not hard block switching when the provider is marked missing in use', async () => {
    let currentConfig: Record<string, any> | null = {
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-4.1',
          },
        },
      },
    }
    const readConfig = vi.fn(async () => currentConfig)
    const applyConfigPatchGuarded = vi.fn(async ({ afterConfig }: { afterConfig: Record<string, any> }) => {
      currentConfig = afterConfig
      return { ok: true, wrote: true }
    })

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5',
      readConfig,
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'openai/gpt-5',
          auth: {
            missingProvidersInUse: ['openai'],
            providers: [],
          },
        },
      }),
      reloadGatewayAfterModelChange: async () => ({ ok: true, running: true }),
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
    expect(applyConfigPatchGuarded).toHaveBeenCalledTimes(1)
  })

  it('accepts alias-equivalent runtime confirmation without forcing a reload', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'minimax/MiniMax-M2.1',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'minimax-portal/MiniMax-M2.5',
            },
          },
        },
      })

    const reloadGatewayAfterModelChange = vi.fn(async () => ({ ok: true, running: true }))

    const result = await applyDefaultModelWithGatewayReload({
      model: 'minimax/MiniMax-M2.5',
      readConfig,
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'minimax-portal/MiniMax-M2.5',
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })

  it('prefers upstream status confirmation over stale CLI status after a local config write', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'minimax/MiniMax-M2.1',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'minimax-portal/MiniMax-M2.5',
            },
          },
        },
      })

    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'minimax/MiniMax-M2.1',
      },
    }))
    const reloadGatewayAfterModelChange = vi.fn(async () => ({ ok: true, running: true }))

    const result = await applyDefaultModelWithGatewayReload({
      model: 'minimax/MiniMax-M2.5',
      readConfig,
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
            defaultModel: 'minimax-portal/MiniMax-M2.5',
          },
        },
      }),
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus,
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
    expect(getModelStatus).toHaveBeenCalled()
  })

  it('prefers the upstream Control UI write path before falling back to local config mutation', async () => {
    const applyConfigPatchGuarded = vi.fn(async () => ({ ok: true, wrote: true }))
    const reloadGatewayAfterModelChange = vi.fn(async () => ({ ok: true, running: true }))
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.4-pro',
            },
          },
        },
      })

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyUpstreamModelWrite: async () => ({
        ok: true,
        wrote: true,
        gatewayReloaded: true,
        source: 'control-ui-config.apply',
      }),
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'openai/gpt-5.4-pro',
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: true,
      writeSource: 'control-ui-config.apply',
    })
    expect(applyConfigPatchGuarded).not.toHaveBeenCalled()
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })

  it('accepts upstream status confirmation after an upstream write even when CLI status is still stale', async () => {
    const applyConfigPatchGuarded = vi.fn(async () => ({ ok: true, wrote: true }))
    const reloadGatewayAfterModelChange = vi.fn(async () => ({ ok: true, running: true }))
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'minimax/MiniMax-M2.1',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: 'minimax-portal/MiniMax-M2.5',
            },
          },
        },
      })

    const result = await applyDefaultModelWithGatewayReload({
      model: 'minimax/MiniMax-M2.5',
      readConfig,
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
            defaultModel: 'minimax-portal/MiniMax-M2.5',
          },
        },
      }),
      applyUpstreamModelWrite: async () => ({
        ok: true,
        wrote: true,
        gatewayReloaded: true,
        source: 'control-ui-config.apply',
      }),
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'minimax/MiniMax-M2.1',
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: true,
      writeSource: 'control-ui-config.apply',
    })
    expect(applyConfigPatchGuarded).not.toHaveBeenCalled()
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })

  it('falls back to local config mutation when the upstream write path is unavailable', async () => {
    const applyConfigPatchGuarded = vi.fn(async () => ({ ok: true, wrote: true }))

    const result = await applyDefaultModelWithGatewayReload({
      model: 'openai/gpt-5.4-pro',
      readConfig: vi
        .fn()
        .mockResolvedValueOnce({
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5',
              },
            },
          },
        })
        .mockResolvedValueOnce({
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5.4-pro',
              },
            },
          },
        }),
      applyUpstreamModelWrite: async () => ({
        ok: false,
        wrote: false,
        gatewayReloaded: false,
        source: 'control-ui-config.apply',
        fallbackUsed: true,
        fallbackReason: 'config.apply-failed',
      }),
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'openai/gpt-5.4-pro',
        },
      }),
      reloadGatewayAfterModelChange: async () => ({ ok: true, running: true }),
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toMatchObject({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
      writeSource: 'local-config-patch',
      upstreamFallbackReason: 'config.apply-failed',
    })
    expect(applyConfigPatchGuarded).toHaveBeenCalledTimes(1)
  })
})

describe('applyAgentPrimaryModelWithGatewayReload', () => {
  it('writes the target agent model and confirms it without reloading the gateway when status catches up', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        defaultModel: 'openai/gpt-legacy',
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
          ],
        },
      })
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.5' },
          ],
        },
      })
    const applyConfigPatchGuarded = vi.fn(async () => ({ ok: true, wrote: true }))
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'minimax/MiniMax-M2.5',
      },
    }))
    const reloadGatewayAfterModelChange = vi.fn(async () => ({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    }))

    const result = await applyAgentPrimaryModelWithGatewayReload({
      agentId: 'feishu-work',
      model: 'minimax/MiniMax-M2.5',
      readConfig,
      applyConfigPatchGuarded,
      getModelStatus,
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
    expect(applyConfigPatchGuarded).toHaveBeenCalledWith({
      beforeConfig: {
        defaultModel: 'openai/gpt-legacy',
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
          ],
        },
      },
      afterConfig: {
        session: {
          dmScope: 'per-account-channel-peer',
        },
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5', default: true },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.5' },
          ],
        },
        bindings: [],
      },
      reason: 'unknown',
    })
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })

  it('heals a missing feishu managed agent through the existing isolation model before writing the model', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        channels: {
          feishu: {
            enabled: true,
            accounts: {
              new: {
                enabled: true,
                name: '新 Bot',
                appId: 'cli_new',
                appSecret: 'secret-new',
              },
            },
          },
        },
        agents: {
          list: [{ id: 'main', model: 'openai/gpt-5' }],
        },
      })
      .mockResolvedValue({
        channels: {
          feishu: {
            enabled: true,
            accounts: {
              new: {
                enabled: true,
                name: '新 Bot',
                appId: 'cli_new',
                appSecret: 'secret-new',
              },
            },
          },
        },
        session: {
          dmScope: 'per-account-channel-peer',
        },
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            {
              id: 'feishu-new',
              name: '新 Bot Agent',
              workspace: '~/.openclaw/workspace-feishu-new',
              model: 'openai/gpt-5.4-pro',
            },
          ],
        },
        bindings: [
          {
            agentId: 'feishu-new',
            match: {
              channel: 'feishu',
              accountId: 'new',
            },
          },
        ],
      })

    const result = await applyAgentPrimaryModelWithGatewayReload({
      agentId: 'feishu-new',
      model: 'openai/gpt-5.4-pro',
      readConfig,
      applyConfigPatchGuarded: async ({ afterConfig }) => {
        expect(afterConfig).toEqual({
          channels: {
            feishu: {
              enabled: true,
              accounts: {
                new: {
                  enabled: true,
                  name: '新 Bot',
                  appId: 'cli_new',
                  appSecret: 'secret-new',
                },
              },
            },
          },
          session: {
            dmScope: 'per-account-channel-peer',
          },
          agents: {
            list: [
              { id: 'main', model: 'openai/gpt-5', default: true },
              {
                id: 'feishu-new',
                name: '新 Bot Agent',
                workspace: '~/.openclaw/workspace-feishu-new',
                model: 'openai/gpt-5.4-pro',
              },
            ],
          },
          bindings: [
            {
              agentId: 'feishu-new',
              match: {
                channel: 'feishu',
                accountId: 'new',
              },
            },
          ],
        })
        return { ok: true, wrote: true }
      },
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'openai/gpt-5.4-pro',
        },
      }),
      reloadGatewayAfterModelChange: async () => ({ ok: true, running: true }),
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
  })

  it('falls back to gateway reload when the bot config has updated but the bot runtime model is still stale', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
          ],
        },
      })
      .mockResolvedValue({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.5' },
          ],
        },
      })

    const reloadGatewayAfterModelChange = vi.fn(async () => ({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    }))

    const result = await applyAgentPrimaryModelWithGatewayReload({
      agentId: 'feishu-work',
      model: 'minimax/MiniMax-M2.5',
      readConfig,
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'minimax/MiniMax-M2.1',
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.modelApplied).toBe(true)
    expect(result.gatewayReloaded).toBe(true)
    expect(result.message).toContain('当前仍未确认模型状态刷新完成')
    expect(reloadGatewayAfterModelChange).toHaveBeenCalledTimes(1)
  })

  it('does not report bot-model success when runtime already matches but the agent config never updates', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
          ],
        },
      })
      .mockResolvedValue({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
          ],
        },
      })

    const reloadGatewayAfterModelChange = vi.fn(async () => ({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    }))

    const result = await applyAgentPrimaryModelWithGatewayReload({
      agentId: 'feishu-work',
      model: 'minimax/MiniMax-M2.5',
      readConfig,
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'minimax/MiniMax-M2.5',
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.modelApplied).toBe(true)
    expect(result.gatewayReloaded).toBe(true)
    expect(reloadGatewayAfterModelChange).toHaveBeenCalledTimes(1)
  })

  it('accepts alias-equivalent bot runtime confirmation without forcing a reload', async () => {
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
          ],
        },
      })
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax-portal/MiniMax-M2.5' },
          ],
        },
      })

    const reloadGatewayAfterModelChange = vi.fn(async () => ({ ok: true, running: true }))

    const result = await applyAgentPrimaryModelWithGatewayReload({
      agentId: 'feishu-work',
      model: 'minimax/MiniMax-M2.5',
      readConfig,
      applyConfigPatchGuarded: async () => ({ ok: true, wrote: true }),
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'minimax-portal/MiniMax-M2.5',
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
    })
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })

  it('prefers the upstream Control UI write path for bot model updates too', async () => {
    const applyConfigPatchGuarded = vi.fn(async () => ({ ok: true, wrote: true }))
    const reloadGatewayAfterModelChange = vi.fn(async () => ({ ok: true, running: true }))
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
          ],
        },
      })
      .mockResolvedValueOnce({
        agents: {
          list: [
            { id: 'main', model: 'openai/gpt-5' },
            { id: 'feishu-work', model: 'minimax/MiniMax-M2.5' },
          ],
        },
      })

    const result = await applyAgentPrimaryModelWithGatewayReload({
      agentId: 'feishu-work',
      model: 'minimax/MiniMax-M2.5',
      readConfig,
      applyUpstreamModelWrite: async () => ({
        ok: true,
        wrote: true,
        gatewayReloaded: true,
        source: 'control-ui-config.apply',
      }),
      applyConfigPatchGuarded,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'minimax/MiniMax-M2.5',
        },
      }),
      reloadGatewayAfterModelChange,
      confirmationPolicy: {
        timeoutMs: 1,
        initialIntervalMs: 1,
        maxIntervalMs: 1,
        backoffFactor: 1,
      },
    })

    expect(result).toEqual({
      ok: true,
      modelApplied: true,
      gatewayReloaded: true,
      writeSource: 'control-ui-config.apply',
    })
    expect(applyConfigPatchGuarded).not.toHaveBeenCalled()
    expect(reloadGatewayAfterModelChange).not.toHaveBeenCalled()
  })
})
