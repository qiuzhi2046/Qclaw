import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  applyConfigPatchGuardedMock,
  getOpenClawPathsMock,
  installPluginNpxMock,
  reconcileManagedPluginConfigMock,
  readConfigMock,
  repairIncompatibleExtensionPluginsMock,
  reloadGatewayForConfigChangeMock,
} = vi.hoisted(() => ({
  applyConfigPatchGuardedMock: vi.fn(),
  getOpenClawPathsMock: vi.fn(),
  installPluginNpxMock: vi.fn(),
  reconcileManagedPluginConfigMock: vi.fn(),
  readConfigMock: vi.fn(),
  repairIncompatibleExtensionPluginsMock: vi.fn(),
  reloadGatewayForConfigChangeMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  getOpenClawPaths: getOpenClawPathsMock,
  installPluginNpx: installPluginNpxMock,
  readConfig: readConfigMock,
  repairIncompatibleExtensionPlugins: repairIncompatibleExtensionPluginsMock,
}))

vi.mock('../openclaw-config-coordinator', () => ({
  applyConfigPatchGuarded: applyConfigPatchGuardedMock,
}))

vi.mock('../managed-plugin-config-reconciler', () => ({
  reconcileManagedPluginConfig: reconcileManagedPluginConfigMock,
}))

vi.mock('../gateway-lifecycle-controller', () => ({
  reloadGatewayForConfigChange: reloadGatewayForConfigChangeMock,
}))

vi.mock('../plugin-install-npx', () => ({
  FEISHU_PLUGIN_NPX_SPECIFIER: '@larksuite/openclaw-lark-tools',
}))

describe('getFeishuOfficialPluginState', () => {
  beforeEach(() => {
    applyConfigPatchGuardedMock.mockReset()
    getOpenClawPathsMock.mockReset()
    installPluginNpxMock.mockReset()
    reconcileManagedPluginConfigMock.mockReset()
    readConfigMock.mockReset()
    repairIncompatibleExtensionPluginsMock.mockReset()
    reloadGatewayForConfigChangeMock.mockReset()
    applyConfigPatchGuardedMock.mockResolvedValue({ ok: true })
    reconcileManagedPluginConfigMock.mockImplementation(async (options) => ({
      ok: true,
      channelId: options.channelId,
      scope: options.scope || 'plugins-only',
      apply: options.apply === true,
      changed: true,
      written: options.apply === true,
      configReadFailed: false,
      retryable: false,
      message: 'ok',
      beforeConfig: options.currentConfig || null,
      afterConfig: options.desiredConfig || options.currentConfig || {},
      removedFrom: {
        allow: [],
        entries: [],
        installs: [],
        channels: [],
      },
      orphanedPluginIds: [],
      prunedPluginIds: [],
      manifest: {
        channelId: options.channelId,
        scope: options.scope || 'plugins-only',
        apply: options.apply === true,
        changed: true,
        written: options.apply === true,
        retryable: false,
        removedFrom: {
          allow: [],
          entries: [],
          installs: [],
          channels: [],
        },
        orphanedPluginIds: [],
        prunedPluginIds: [],
        runtime: {
          configPath: options.runtimeContext?.configPath || null,
          homeDir: options.runtimeContext?.homeDir || null,
          openclawVersion: options.runtimeContext?.openclawVersion || null,
        },
      },
      writeResult: {
        ok: true,
        blocked: false,
        wrote: options.apply === true,
        target: 'config',
        snapshotCreated: false,
        snapshot: null,
        changedJsonPaths: ['$.plugins'],
        ownershipSummary: null,
        gatewayApply: {
          ok: true,
          requestedAction: 'restart',
          appliedAction: 'restart',
        },
      },
    }))
    repairIncompatibleExtensionPluginsMock.mockResolvedValue({
      ok: true,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '',
      stderr: '',
    })
    reloadGatewayForConfigChangeMock.mockResolvedValue({
      ok: true,
      running: true,
      stdout: '',
      stderr: '',
      code: 0,
      summary: 'Gateway 已重载',
    })
  })

  it('strips legacy and official plugin config when the official plugin is not installed on disk', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      plugins: {
        allow: ['feishu', 'openclaw-lark', 'copilot-proxy'],
        entries: {
          feishu: { enabled: false },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'feishu-openclaw-plugin': { spec: '@legacy/feishu' },
          'openclaw-lark': { spec: '@larksuite/openclaw-lark' },
        },
      },
    })

    const { getFeishuOfficialPluginState } = await import('../feishu-official-plugin-state')
    const result = await getFeishuOfficialPluginState()

    expect(result.installedOnDisk).toBe(false)
    expect(result.legacyPluginIdsPresent).toEqual(['feishu', 'feishu-openclaw-plugin'])
    expect(result.officialPluginConfigured).toBe(false)
    expect(result.configChanged).toBe(true)
    expect(result.normalizedConfig.plugins.allow).toEqual(['copilot-proxy'])
    expect(result.normalizedConfig.plugins.entries).toEqual({
      feishu: { enabled: false },
    })
    expect(result.normalizedConfig.plugins.installs).toEqual({})
  })

  it('does not synthesize a writable config when the current config cannot be read', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockRejectedValue(new Error('temporarily unavailable'))

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)

    try {
      const { getFeishuOfficialPluginState } = await import('../feishu-official-plugin-state')
      const result = await getFeishuOfficialPluginState()

      expect(result.installedOnDisk).toBe(true)
      expect(result.configAvailable).toBe(false)
      expect(result.configChanged).toBe(false)
      expect(result.officialPluginConfigured).toBe(false)
      expect(result.legacyPluginIdsPresent).toEqual([])
      expect(result.normalizedConfig).toEqual({})
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('keeps official plugin config when the plugin is installed on disk while still removing legacy residue', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      plugins: {
        allow: ['feishu', 'openclaw-lark'],
        entries: {
          feishu: { enabled: false },
          'openclaw-lark': { enabled: true },
        },
      },
    })

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)

    try {
      const { getFeishuOfficialPluginState } = await import('../feishu-official-plugin-state')
      const result = await getFeishuOfficialPluginState()

      expect(result.installedOnDisk).toBe(true)
      expect(result.legacyPluginIdsPresent).toEqual(['feishu'])
      expect(result.officialPluginConfigured).toBe(true)
      expect(result.configChanged).toBe(true)
      expect(result.normalizedConfig.plugins.allow).toEqual(['openclaw-lark'])
      expect(result.normalizedConfig.plugins.entries).toEqual({
        feishu: { enabled: false },
        'openclaw-lark': { enabled: true },
      })
      expect(result.normalizedConfig.session.dmScope).toBe('per-account-channel-peer')
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('normalizes feishu routing state even before the official plugin is installed on disk', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
        ],
      },
      bindings: [
        { agentId: 'feishu-bot', match: { channel: 'feishu', accountId: 'default' } },
      ],
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
      plugins: {
        allow: ['feishu'],
      },
    })

    const { getFeishuOfficialPluginState } = await import('../feishu-official-plugin-state')
    const result = await getFeishuOfficialPluginState()

    expect(result.installedOnDisk).toBe(false)
    expect(result.officialPluginConfigured).toBe(false)
    expect(result.normalizedConfig.plugins.allow).toEqual([])
    expect(result.normalizedConfig.agents.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'feishu-default', model: 'minimax/MiniMax-M2.1' }),
      ])
    )
    expect(result.normalizedConfig.agents.list).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ id: 'feishu-bot' }),
      ])
    )
    expect(result.normalizedConfig.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'feishu-default', match: { channel: 'feishu', accountId: 'default' } }),
      ])
    )
  })

  it('rebuilds install metadata, allowlist, and managed feishu isolation when the plugin exists on disk', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
        ],
      },
      bindings: [
        { agentId: 'feishu-bot', match: { channel: 'feishu', accountId: 'default' } },
      ],
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
          accounts: {
            work: {
              enabled: true,
              name: 'Work Bot',
              appId: 'cli_work',
              appSecret: 'secret-work',
            },
          },
        },
      },
    })

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)

    try {
      const { getFeishuOfficialPluginState } = await import('../feishu-official-plugin-state')
      const result = await getFeishuOfficialPluginState()

      expect(result.installedOnDisk).toBe(true)
      expect(result.officialPluginConfigured).toBe(true)
      expect(result.configChanged).toBe(true)
      expect(result.normalizedConfig.plugins.allow).toContain('openclaw-lark')
      expect(result.normalizedConfig.plugins.installs['openclaw-lark']).toEqual(
        expect.objectContaining({
          source: 'npm',
          spec: '@larksuite/openclaw-lark',
          installPath: expect.stringMatching(/[\\/]openclaw-lark$/),
        })
      )
      expect(result.normalizedConfig.session.dmScope).toBe('per-account-channel-peer')
      expect(result.normalizedConfig.agents.list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'feishu-default' }),
          expect.objectContaining({ id: 'feishu-work' }),
        ])
      )
      const migratedDefaultAgent = result.normalizedConfig.agents.list.find((agent: Record<string, any>) => agent.id === 'feishu-default')
      expect(migratedDefaultAgent).toEqual(
        expect.objectContaining({
          id: 'feishu-default',
          model: 'minimax/MiniMax-M2.1',
        })
      )
      expect(result.normalizedConfig.agents.list).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ id: 'feishu-bot' }),
        ])
      )
      expect(result.normalizedConfig.bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: 'feishu-default', match: { channel: 'feishu', accountId: 'default' } }),
          expect.objectContaining({ agentId: 'feishu-work', match: { channel: 'feishu', accountId: 'work' } }),
        ])
      )
      expect(result.normalizedConfig.bindings).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ agentId: 'feishu-bot' }),
        ])
      )
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('installs the official plugin on demand when it is missing for link preparation', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
      plugins: {
        allow: ['feishu'],
      },
    })

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi
      .spyOn(fs.promises, 'access')
      .mockRejectedValueOnce(new Error('missing'))
      .mockRejectedValueOnce(new Error('still-missing-before-install'))
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined)

    installPluginNpxMock.mockResolvedValue({
      ok: true,
      stdout: 'installed',
      stderr: '',
      code: 0,
    })

    try {
      const { ensureFeishuOfficialPluginReady } = await import('../feishu-official-plugin-state')
      const result = await ensureFeishuOfficialPluginReady()

      expect(result.ok).toBe(true)
      expect(result.installedThisRun).toBe(true)
      expect(installPluginNpxMock).toHaveBeenCalledWith(
        '@larksuite/openclaw-lark-tools',
        ['openclaw-lark']
      )
      expect(result.state.installedOnDisk).toBe(true)
      expect(reconcileManagedPluginConfigMock).toHaveBeenCalled()
      expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith('feishu-official-plugin-install')
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('stops readiness repair without writing or reinstalling when config cannot be read', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockRejectedValue(new Error('temporarily unavailable'))

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)

    try {
      const { ensureFeishuOfficialPluginReady } = await import('../feishu-official-plugin-state')
      const result = await ensureFeishuOfficialPluginReady()

      expect(result.ok).toBe(false)
      expect(result.state.configAvailable).toBe(false)
      expect(result.message).toBe('飞书插件预检查失败')
      expect(result.stderr).toContain('配置读取失败')
      expect(reconcileManagedPluginConfigMock).not.toHaveBeenCalled()
      expect(repairIncompatibleExtensionPluginsMock).not.toHaveBeenCalled()
      expect(installPluginNpxMock).not.toHaveBeenCalled()
      expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('heals config and skips reinstallation when the official plugin already exists on disk', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
    })

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)

    try {
      const { ensureFeishuOfficialPluginReady } = await import('../feishu-official-plugin-state')
      const result = await ensureFeishuOfficialPluginReady()

      expect(result.ok).toBe(true)
      expect(result.installedThisRun).toBe(false)
      expect(installPluginNpxMock).not.toHaveBeenCalled()
      expect(result.state.installedOnDisk).toBe(true)
      expect(result.state.officialPluginConfigured).toBe(true)
      expect(reconcileManagedPluginConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'feishu',
          apply: true,
          applyGatewayPolicy: true,
          scope: 'plugins-only',
        })
      )
      expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('stops Feishu readiness when strict reconciler rejects final sync', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
      configFile: '/Users/alice/.openclaw/openclaw.json',
    })
    readConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
    })
    reconcileManagedPluginConfigMock.mockResolvedValue({
      ok: false,
      channelId: 'feishu',
      scope: 'plugins-only',
      apply: true,
      changed: true,
      written: false,
      configReadFailed: true,
      retryable: true,
      failureReason: 'config-read-failed',
      message: 'OpenClaw 配置读取失败，已停止写入。',
      beforeConfig: null,
      afterConfig: null,
      removedFrom: {
        allow: [],
        entries: [],
        installs: [],
        channels: [],
      },
      orphanedPluginIds: [],
      prunedPluginIds: [],
      manifest: {
        channelId: 'feishu',
        scope: 'plugins-only',
        apply: true,
        changed: true,
        written: false,
        retryable: true,
        removedFrom: {
          allow: [],
          entries: [],
          installs: [],
          channels: [],
        },
        orphanedPluginIds: [],
        prunedPluginIds: [],
        runtime: {
          configPath: '/Users/alice/.openclaw/openclaw.json',
          homeDir: '/Users/alice/.openclaw',
          openclawVersion: null,
        },
      },
    })

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)

    try {
      const { ensureFeishuOfficialPluginReady } = await import('../feishu-official-plugin-state')
      const result = await ensureFeishuOfficialPluginReady()

      expect(result.ok).toBe(false)
      expect(result.message).toBe('飞书插件预检查失败')
      expect(result.stderr).toContain('配置读取失败')
      expect(reconcileManagedPluginConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'feishu',
          scope: 'plugins-only',
          apply: true,
          applyGatewayPolicy: true,
          runtimeContext: expect.objectContaining({
            configPath: '/Users/alice/.openclaw/openclaw.json',
            homeDir: '/Users/alice/.openclaw',
          }),
        })
      )
      expect(repairIncompatibleExtensionPluginsMock).not.toHaveBeenCalled()
      expect(installPluginNpxMock).not.toHaveBeenCalled()
      expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('quarantines incompatible official plugin residue before reinstalling the managed plugin', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      session: {
        dmScope: 'per-account-channel-peer',
      },
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          feishu: { enabled: false },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            source: 'npm',
            spec: '@larksuite/openclaw-lark',
            installPath: '/Users/alice/.openclaw/extensions/openclaw-lark',
          },
        },
      },
    })

    repairIncompatibleExtensionPluginsMock.mockResolvedValue({
      ok: true,
      repaired: true,
      incompatiblePlugins: [
        {
          pluginId: 'openclaw-lark',
          packageName: '@larksuite/openclaw-lark',
          installPath: '/Users/alice/.openclaw/extensions/openclaw-lark',
          displayInstallPath: '/Users/alice/.openclaw/extensions/openclaw-lark',
          reason: '插件导入 smoke test 失败：TypeError: normalizeAccountId is not a function',
        },
      ],
      quarantinedPluginIds: ['openclaw-lark'],
      prunedPluginIds: ['openclaw-lark'],
      summary: '已自动隔离 1 个坏插件并清理相关配置。',
      stderr: '',
    })

    installPluginNpxMock.mockResolvedValue({
      ok: true,
      stdout: 'installed',
      stderr: '',
      code: 0,
    })

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)
    accessSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('quarantined'))

    try {
      const { ensureFeishuOfficialPluginReady } = await import('../feishu-official-plugin-state')
      const result = await ensureFeishuOfficialPluginReady()

      expect(repairIncompatibleExtensionPluginsMock).toHaveBeenCalledWith({
        scopePluginIds: ['openclaw-lark', 'feishu', 'feishu-openclaw-plugin'],
        quarantineOfficialManagedPlugins: true,
      })
      expect(installPluginNpxMock).toHaveBeenCalledWith(
        '@larksuite/openclaw-lark-tools',
        ['openclaw-lark']
      )
      expect(result.ok).toBe(true)
      expect(result.installedThisRun).toBe(true)
      expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith('feishu-official-plugin-install')
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('applies config healing before surfacing install failure when the official plugin is missing', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock.mockResolvedValue({
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
        ],
      },
      bindings: [
        { agentId: 'feishu-bot', match: { channel: 'feishu', accountId: 'default' } },
      ],
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
    })

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockRejectedValue(new Error('missing'))

    installPluginNpxMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'network failed',
      code: 1,
    })

    try {
      const { ensureFeishuOfficialPluginReady } = await import('../feishu-official-plugin-state')
      const result = await ensureFeishuOfficialPluginReady()

      expect(result.ok).toBe(false)
      expect(result.installedThisRun).toBe(false)
      expect(reconcileManagedPluginConfigMock).toHaveBeenCalledTimes(1)
      expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
      expect(result.state.normalizedConfig.agents.list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'feishu-default', model: 'minimax/MiniMax-M2.1' }),
        ])
      )
    } finally {
      accessSpy.mockRestore()
    }
  })

  it('does not claim the plugin was installed when post-install config healing fails after a failed install', async () => {
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: '/Users/alice/.openclaw',
    })
    readConfigMock
      .mockResolvedValueOnce({})
      .mockResolvedValue({
        agents: {
          list: [
            { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          ],
        },
        bindings: [
          { agentId: 'feishu-bot', match: { channel: 'feishu', accountId: 'default' } },
        ],
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
          },
        },
      })

    reconcileManagedPluginConfigMock
      .mockResolvedValueOnce({
        ok: true,
        channelId: 'feishu',
        scope: 'plugins-only',
        apply: true,
        changed: true,
        written: true,
        configReadFailed: false,
        retryable: false,
        message: 'ok',
        beforeConfig: {},
        afterConfig: {},
        removedFrom: {
          allow: [],
          entries: [],
          installs: [],
          channels: [],
        },
        orphanedPluginIds: [],
        prunedPluginIds: [],
        manifest: {
          channelId: 'feishu',
          scope: 'plugins-only',
          apply: true,
          changed: true,
          written: true,
          retryable: false,
          removedFrom: {
            allow: [],
            entries: [],
            installs: [],
            channels: [],
          },
          orphanedPluginIds: [],
          prunedPluginIds: [],
          runtime: {
            configPath: null,
            homeDir: null,
            openclawVersion: null,
          },
        },
        writeResult: {
          ok: true,
          blocked: false,
          wrote: true,
          target: 'config',
          snapshotCreated: false,
          snapshot: null,
          changedJsonPaths: ['$.plugins'],
          ownershipSummary: null,
        },
      })
      .mockRejectedValueOnce(new Error('after-install-patch-failed'))

    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const accessSpy = vi.spyOn(fs.promises, 'access').mockRejectedValue(new Error('missing'))

    installPluginNpxMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'network failed',
      code: 1,
    })

    try {
      const { ensureFeishuOfficialPluginReady } = await import('../feishu-official-plugin-state')
      const result = await ensureFeishuOfficialPluginReady()

      expect(result.ok).toBe(false)
      expect(result.installedThisRun).toBe(false)
      expect(result.message).toBe('飞书官方插件安装失败，且配置归一化失败')
      expect(result.stderr).toContain('network failed')
      expect(result.stderr).toContain('after-install-patch-failed')
      expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
    } finally {
      accessSpy.mockRestore()
    }
  })
})
