import { describe, expect, it, vi } from 'vitest'

import type { ManagedChannelPluginStatusView } from '../../../src/shared/managed-channel-plugin-lifecycle'
import {
  getManagedChannelLifecycleSpec,
  listManagedChannelLifecycleSpecs,
} from '../../../src/shared/managed-channel-plugin-lifecycle'
import { createManagedChannelPluginLifecycleService } from '../managed-channel-plugin-lifecycle'
import { resetManagedOperationLocksForTests } from '../managed-operation-lock'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createStatus(params: Partial<ManagedChannelPluginStatusView> & Pick<ManagedChannelPluginStatusView, 'channelId' | 'pluginId' | 'summary'>): ManagedChannelPluginStatusView {
  return {
    channelId: params.channelId,
    pluginId: params.pluginId,
    summary: params.summary,
    stages: params.stages || [
      { id: 'installed', state: 'missing', source: 'test', message: 'missing' },
      { id: 'registered', state: 'unknown', source: 'test', message: 'unknown' },
      { id: 'loaded', state: 'unknown', source: 'test', message: 'unknown' },
      { id: 'ready', state: 'unknown', source: 'test', message: 'unknown' },
    ],
    evidence: params.evidence || [],
  }
}

function createDependencies() {
  return {
    getOfficialChannelStatus: vi.fn(),
    repairOfficialChannel: vi.fn(),
    repairIncompatiblePlugins: vi.fn().mockResolvedValue({
      ok: true,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '未发现坏插件。',
      stderr: '',
    }),
    installPlugin: vi.fn().mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    }),
    installPluginNpx: vi.fn().mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    }),
    isPluginInstalledOnDisk: vi.fn().mockResolvedValue(false),
    listRegisteredPlugins: vi.fn().mockResolvedValue([]),
    readConfig: vi.fn().mockResolvedValue({ channels: {}, plugins: {} }),
    writeConfig: vi.fn(async (_config: Record<string, any>) => {}),
    reloadGatewayForConfigChange: vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    }),
    now: vi.fn(() => 0),
  }
}

describe('managed channel lifecycle specs', () => {
  it('declares one canonical lifecycle spec per managed channel with explicit scope metadata', () => {
    expect(listManagedChannelLifecycleSpecs().map((item) => item.channelId)).toEqual([
      'feishu',
      'wecom',
      'dingtalk',
      'qqbot',
      'openclaw-weixin',
      'line',
      'telegram',
      'slack',
    ])

    expect(getManagedChannelLifecycleSpec('feishu')).toMatchObject({
      channelId: 'feishu',
      pluginScope: 'channel',
      entityScope: 'bot',
      canonicalPluginId: 'openclaw-lark',
      installStrategy: 'official-adapter',
    })
    expect(getManagedChannelLifecycleSpec('wecom')).toMatchObject({
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      canonicalPluginId: 'wecom-openclaw-plugin',
      installStrategy: 'npx',
    })
    expect(getManagedChannelLifecycleSpec('openclaw-weixin')).toMatchObject({
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      canonicalPluginId: 'openclaw-weixin',
      installStrategy: 'interactive-installer',
    })
  })
})

describe('createManagedChannelPluginLifecycleService', () => {
  it('returns plugin-ready-channel-not-ready when the plugin is healthy but runtime/account proof is still missing', async () => {
    const dependencies = createDependencies()
    dependencies.getOfficialChannelStatus.mockResolvedValue(
      createStatus({
        channelId: 'feishu',
        pluginId: 'openclaw-lark',
        summary: '飞书官方插件已安装并已注册；loaded / ready 仍待上游证据。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
      })
    )

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.inspectManagedChannelPlugin('feishu')

    expect(result.kind).toBe('plugin-ready-channel-not-ready')
    expect(result.channelId).toBe('feishu')
  })

  it('quarantines incompatible interactive-installer plugins before setup preflight falls back to manual action', async () => {
    const dependencies = createDependencies()
    const service = createManagedChannelPluginLifecycleService(dependencies)

    const result = await service.prepareManagedChannelPluginForSetup('openclaw-weixin')

    expect(result).toMatchObject({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      action: 'launch-interactive-installer',
    })
    expect(dependencies.repairIncompatiblePlugins).toHaveBeenCalledWith({
      scopePluginIds: ['openclaw-weixin'],
      quarantineOfficialManagedPlugins: true,
    })
  })

  it('hands personal weixin setup to the interactive installer without running package install preflight', async () => {
    const dependencies = createDependencies()

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.prepareManagedChannelPluginForSetup('openclaw-weixin')

    expect(dependencies.installPlugin).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      action: 'launch-interactive-installer',
      status: {
        channelId: 'openclaw-weixin',
        pluginId: 'openclaw-weixin',
        stages: expect.arrayContaining([
          expect.objectContaining({ id: 'installed', state: 'missing' }),
          expect.objectContaining({ id: 'registered', state: 'missing' }),
        ]),
      },
    })
  })

  it('repairs config drift for an already-installed managed plugin during setup preflight instead of forcing reinstall', async () => {
    const dependencies = createDependencies()
    let currentConfig: Record<string, any> = {
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {},
    }
    dependencies.isPluginInstalledOnDisk.mockResolvedValue(true)
    dependencies.listRegisteredPlugins.mockResolvedValue(['wecom-openclaw-plugin'])
    dependencies.readConfig.mockImplementation(async () => currentConfig)
    dependencies.writeConfig.mockImplementation(async (config: Record<string, any>) => {
      currentConfig = config
    })

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.prepareManagedChannelPluginForSetup('wecom')

    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'wecom',
      action: 'repair-before-setup',
    })
    expect(dependencies.installPluginNpx).not.toHaveBeenCalled()
    expect(dependencies.writeConfig).toHaveBeenCalledWith({
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {
        allow: ['wecom-openclaw-plugin'],
      },
    })
    expect(dependencies.reloadGatewayForConfigChange).toHaveBeenCalledTimes(1)
  })

  it('treats hidden install-stage metadata as config drift for an already-installed managed plugin during setup preflight', async () => {
    const dependencies = createDependencies()
    let currentConfig: Record<string, any> = {
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {
        allow: ['wecom-openclaw-plugin'],
        installs: {
          'wecom-openclaw-plugin': {
            installPath: '/Users/demo/.openclaw/extensions/.openclaw-install-stage-abcd1234',
          },
        },
      },
    }
    dependencies.isPluginInstalledOnDisk.mockResolvedValue(true)
    dependencies.listRegisteredPlugins.mockResolvedValue(['wecom-openclaw-plugin'])
    dependencies.readConfig.mockImplementation(async () => currentConfig)
    dependencies.writeConfig.mockImplementation(async (config: Record<string, any>) => {
      currentConfig = config
    })

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.prepareManagedChannelPluginForSetup('wecom')

    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'wecom',
      action: 'repair-before-setup',
    })
    expect(dependencies.repairIncompatiblePlugins).toHaveBeenCalledWith({
      scopePluginIds: ['wecom-openclaw-plugin', 'wecom'],
      quarantineOfficialManagedPlugins: true,
    })
    expect(dependencies.writeConfig).toHaveBeenCalledWith({
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {
        allow: ['wecom-openclaw-plugin'],
        installs: {},
      },
    })
  })

  it('treats hidden install-stage metadata as config drift for qqbot too', async () => {
    const dependencies = createDependencies()
    let currentConfig: Record<string, any> = {
      channels: {
        qqbot: {
          enabled: true,
          appId: 'bot_123',
          clientSecret: 'secret_456',
          allowFrom: ['*'],
        },
      },
      plugins: {
        allow: ['openclaw-qqbot'],
        entries: {
          'openclaw-qqbot': {
            enabled: true,
            installPath: '/Users/demo/.openclaw/extensions/.openclaw-install-stage-qqbot999',
          },
        },
      },
    }
    dependencies.isPluginInstalledOnDisk.mockResolvedValue(true)
    dependencies.listRegisteredPlugins.mockResolvedValue(['openclaw-qqbot'])
    dependencies.readConfig.mockImplementation(async () => currentConfig)
    dependencies.writeConfig.mockImplementation(async (config: Record<string, any>) => {
      currentConfig = config
    })

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.prepareManagedChannelPluginForSetup('qqbot')

    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'qqbot',
      action: 'repair-before-setup',
    })
    expect(dependencies.repairIncompatiblePlugins).toHaveBeenCalledWith({
      scopePluginIds: ['openclaw-qqbot', 'qqbot', 'openclaw-qq', '@sliverp/qqbot', '@tencent-connect/qqbot', '@tencent-connect/openclaw-qq', '@tencent-connect/openclaw-qqbot'],
      quarantineOfficialManagedPlugins: true,
    })
    expect(dependencies.writeConfig).toHaveBeenCalledWith({
      channels: {
        qqbot: {
          enabled: true,
          appId: 'bot_123',
          clientSecret: 'secret_456',
          allowFrom: ['*'],
        },
      },
      plugins: {
        allow: ['openclaw-qqbot'],
        entries: {},
      },
    })
  })

  it('reuses an installed managed plugin during setup preflight when the current config is unreadable', async () => {
    const dependencies = createDependencies()
    dependencies.isPluginInstalledOnDisk.mockResolvedValue(true)
    dependencies.listRegisteredPlugins.mockResolvedValue(['wecom-openclaw-plugin'])
    dependencies.readConfig.mockResolvedValue(null)

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.prepareManagedChannelPluginForSetup('wecom')

    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'wecom',
      action: 'reuse-installed',
    })
    expect(dependencies.installPluginNpx).not.toHaveBeenCalled()
    expect(dependencies.writeConfig).not.toHaveBeenCalled()
    expect(dependencies.reloadGatewayForConfigChange).not.toHaveBeenCalled()
  })

  it('quarantines incompatible interactive-installer plugins before returning foreground repair guidance', async () => {
    const dependencies = createDependencies()
    const service = createManagedChannelPluginLifecycleService(dependencies)

    const result = await service.repairManagedChannelPlugin('openclaw-weixin')

    expect(result).toMatchObject({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      action: 'launch-interactive-installer',
    })
    expect(dependencies.repairIncompatiblePlugins).toHaveBeenCalledWith({
      scopePluginIds: ['openclaw-weixin'],
      quarantineOfficialManagedPlugins: true,
    })
    expect(dependencies.installPluginNpx).not.toHaveBeenCalled()
    expect(dependencies.reloadGatewayForConfigChange).not.toHaveBeenCalled()
  })

  it('serializes interactive-installer preflight repairs through the managed channel lock', async () => {
    resetManagedOperationLocksForTests()
    const dependencies = createDependencies()
    const trace: string[] = []
    let callCount = 0
    dependencies.repairIncompatiblePlugins.mockImplementation(async () => {
      callCount += 1
      const callId = callCount
      trace.push(`${callId}:start`)
      await delay(20)
      trace.push(`${callId}:end`)
      return {
        ok: true,
        repaired: false,
        incompatiblePlugins: [],
        quarantinedPluginIds: [],
        prunedPluginIds: [],
        summary: '未发现坏插件。',
        stderr: '',
      }
    })

    const service = createManagedChannelPluginLifecycleService(dependencies)
    await Promise.all([
      service.prepareManagedChannelPluginForSetup('openclaw-weixin'),
      service.prepareManagedChannelPluginForSetup('openclaw-weixin'),
    ])

    expect(trace).toEqual(['1:start', '1:end', '2:start', '2:end'])
  })

  it('maps quarantine permission failures into a dedicated repair result and stops before install or reload', async () => {
    const dependencies = createDependencies()
    dependencies.repairIncompatiblePlugins.mockResolvedValue({
      ok: false,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '隔离失败',
      stderr: 'permission denied',
      failureKind: 'permission-denied',
      failedPluginIds: ['wecom-openclaw-plugin'],
      failedPaths: ['/tmp/openclaw/extensions/wecom-openclaw-plugin'],
    })

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.repairManagedChannelPlugin('wecom')

    expect(result).toMatchObject({
      kind: 'quarantine-failed',
      channelId: 'wecom',
      failureKind: 'permission-denied',
      failedPluginIds: ['wecom-openclaw-plugin'],
    })
    expect(dependencies.installPluginNpx).not.toHaveBeenCalled()
    expect(dependencies.reloadGatewayForConfigChange).not.toHaveBeenCalled()
  })

  it('installs and normalizes generic managed plugins through the shared repair pipeline', async () => {
    const dependencies = createDependencies()
    dependencies.readConfig.mockResolvedValue({
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {},
    })
    dependencies.listRegisteredPlugins.mockResolvedValue(['wecom-openclaw-plugin'])

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.repairManagedChannelPlugin('wecom')

    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'wecom',
      action: 'installed',
    })
    expect(dependencies.installPluginNpx).toHaveBeenCalledWith('@wecom/wecom-openclaw-cli', ['wecom-openclaw-plugin'])
    expect(dependencies.writeConfig).toHaveBeenCalledWith({
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {
        allow: ['wecom-openclaw-plugin'],
      },
    })
    expect(dependencies.reloadGatewayForConfigChange).toHaveBeenCalledTimes(1)
  })

  it('fails safe instead of overwriting config when config sync is needed but the current config cannot be read', async () => {
    const dependencies = createDependencies()
    dependencies.isPluginInstalledOnDisk.mockResolvedValue(true)
    dependencies.listRegisteredPlugins.mockResolvedValue(['wecom-openclaw-plugin'])
    dependencies.readConfig.mockResolvedValue(null)

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.repairManagedChannelPlugin('wecom')

    expect(result.kind).toBe('repair-failed')
    expect(result.channelId).toBe('wecom')
    if (result.kind !== 'repair-failed') {
      throw new Error(`Expected repair-failed result, received ${result.kind}`)
    }
    expect(result.error).toContain('配置')
    expect(dependencies.writeConfig).not.toHaveBeenCalled()
    expect(dependencies.reloadGatewayForConfigChange).not.toHaveBeenCalled()
  })

  it('reuses a managed plugin when install returns already exists but the plugin is confirmed on disk afterwards', async () => {
    const dependencies = createDependencies()
    dependencies.isPluginInstalledOnDisk
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    dependencies.installPluginNpx.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'plugin already exists',
      code: 1,
    })
    dependencies.readConfig.mockResolvedValue({
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {},
    })
    dependencies.listRegisteredPlugins.mockResolvedValue(['wecom-openclaw-plugin'])

    const service = createManagedChannelPluginLifecycleService(dependencies)
    const result = await service.repairManagedChannelPlugin('wecom')

    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'wecom',
      action: 'reused-existing',
    })
    expect(dependencies.installPluginNpx).toHaveBeenCalledWith('@wecom/wecom-openclaw-cli', ['wecom-openclaw-plugin'])
    expect(dependencies.writeConfig).toHaveBeenCalled()
    expect(dependencies.reloadGatewayForConfigChange).toHaveBeenCalledTimes(1)
  })
})
