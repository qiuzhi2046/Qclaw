import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagedChannelPluginStatusView } from '../../../src/shared/managed-channel-plugin-lifecycle'

const {
  applyConfigPatchGuardedMock,
  dingtalkPreflightHookMock,
  getOfficialChannelStatusMock,
  getOpenClawPathsMock,
  installPluginMock,
  installPluginNpxMock,
  isPluginInstalledOnDiskMock,
  parseJsonFromCommandResultMock,
  readConfigMock,
  reconcileManagedPluginConfigMock,
  reloadGatewayForConfigChangeMock,
  repairIncompatibleExtensionPluginsMock,
  repairOfficialChannelMock,
  runCliMock,
  sendRepairProgressMock,
  writeConfigMock,
} = vi.hoisted(() => ({
  applyConfigPatchGuardedMock: vi.fn(),
  dingtalkPreflightHookMock: vi.fn(),
  getOfficialChannelStatusMock: vi.fn(),
  getOpenClawPathsMock: vi.fn(),
  installPluginMock: vi.fn(),
  installPluginNpxMock: vi.fn(),
  isPluginInstalledOnDiskMock: vi.fn(),
  parseJsonFromCommandResultMock: vi.fn(),
  readConfigMock: vi.fn(),
  reconcileManagedPluginConfigMock: vi.fn(),
  reloadGatewayForConfigChangeMock: vi.fn(),
  repairIncompatibleExtensionPluginsMock: vi.fn(),
  repairOfficialChannelMock: vi.fn(),
  runCliMock: vi.fn(),
  sendRepairProgressMock: vi.fn(),
  writeConfigMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  getOpenClawPaths: getOpenClawPathsMock,
  installPlugin: installPluginMock,
  installPluginNpx: installPluginNpxMock,
  isPluginInstalledOnDisk: isPluginInstalledOnDiskMock,
  readConfig: readConfigMock,
  repairIncompatibleExtensionPlugins: repairIncompatibleExtensionPluginsMock,
  runCli: runCliMock,
  writeConfig: writeConfigMock,
}))

vi.mock('../gateway-lifecycle-controller', () => ({
  reloadGatewayForConfigChange: reloadGatewayForConfigChangeMock,
}))

vi.mock('../official-channel-adapters', () => ({
  getOfficialChannelStatus: getOfficialChannelStatusMock,
  repairOfficialChannel: repairOfficialChannelMock,
}))

vi.mock('../openclaw-command-output', () => ({
  parseJsonFromCommandResult: parseJsonFromCommandResultMock,
}))

vi.mock('../dingtalk-official-channel', () => ({
  dingtalkPreflightHook: dingtalkPreflightHookMock,
}))

vi.mock('../renderer-notification-bridge', () => ({
  sendRepairProgress: sendRepairProgressMock,
}))

vi.mock('../managed-plugin-config-reconciler', () => ({
  reconcileManagedPluginConfig: reconcileManagedPluginConfigMock,
}))

vi.mock('../openclaw-config-coordinator', () => ({
  applyConfigPatchGuarded: applyConfigPatchGuardedMock,
}))

function createStatus(
  params: Partial<ManagedChannelPluginStatusView> & Pick<ManagedChannelPluginStatusView, 'channelId' | 'pluginId' | 'summary'>
): ManagedChannelPluginStatusView {
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

async function loadModule() {
  const mod = await import('../managed-channel-plugin-lifecycle')
  mod.resetManagedChannelPluginLifecycleServiceForTests()
  return mod
}

describe('managed channel lifecycle default service wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    getOpenClawPathsMock.mockResolvedValue({ homeDir: '/tmp/openclaw-home' })
    repairIncompatibleExtensionPluginsMock.mockResolvedValue({
      ok: true,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '未发现坏插件。',
      stderr: '',
    })
    installPluginMock.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    installPluginNpxMock.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    isPluginInstalledOnDiskMock.mockResolvedValue(true)
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: '{"plugins":[]}',
      stderr: '',
      code: 0,
    })
    parseJsonFromCommandResultMock.mockReturnValue({
      plugins: [],
    })
    readConfigMock.mockResolvedValue({ channels: {}, plugins: {} })
    writeConfigMock.mockResolvedValue(undefined)
    reloadGatewayForConfigChangeMock.mockResolvedValue({
      ok: true,
      running: true,
      summary: 'Gateway 已确认可用',
      stdout: '',
      stderr: '',
      code: 0,
    })
    getOfficialChannelStatusMock.mockResolvedValue(
      createStatus({
        channelId: 'dingtalk',
        pluginId: 'dingtalk-connector',
        summary: '钉钉官方插件已安装并已注册；loaded / ready 仍待上游证据。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
      })
    )
    repairOfficialChannelMock.mockResolvedValue({
      ok: true,
      channelId: 'dingtalk',
      pluginId: 'dingtalk-connector',
      summary: '钉钉官方插件已修复；loaded / ready 仍待上游证据。',
      installedThisRun: false,
      gatewayResult: null,
      evidence: [],
      stdout: '',
      stderr: '',
      code: 0,
      message: 'repaired',
    })
    dingtalkPreflightHookMock.mockResolvedValue({ ok: true })
    reconcileManagedPluginConfigMock.mockResolvedValue({
      changed: false,
      removedFrom: { allow: [], entries: [], installs: [], channels: [] },
      orphanedPluginIds: [],
    })
    applyConfigPatchGuardedMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['plugins.allow'],
      ownershipSummary: null,
      message: 'written',
    })
  })

  it('runs dingtalk preflight through the default service wiring', async () => {
    const mod = await loadModule()

    const result = await mod.prepareManagedChannelPluginForSetup('dingtalk')

    expect(dingtalkPreflightHookMock).toHaveBeenCalledWith({
      homeDir: '/tmp/openclaw-home',
      config: { channels: {}, plugins: {} },
    })
    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'dingtalk',
      action: 'reuse-installed',
    })
  })

  it('does not run dingtalk preflight for non-dingtalk channels on the default service path', async () => {
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: '{"plugins":[{"id":"wecom-openclaw-plugin"}]}',
      stderr: '',
      code: 0,
    })
    parseJsonFromCommandResultMock.mockReturnValue({
      plugins: [{ id: 'wecom-openclaw-plugin' }],
    })
    readConfigMock.mockResolvedValue({
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

    const mod = await loadModule()
    const result = await mod.prepareManagedChannelPluginForSetup('wecom')

    expect(reconcileManagedPluginConfigMock).toHaveBeenCalledWith(
      'wecom',
      '/tmp/openclaw-home',
      { scope: 'plugins-only', checkDisk: true, detectOrphans: true, apply: true, caller: 'preflight' }
    )
    expect(dingtalkPreflightHookMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'wecom',
      action: 'reuse-installed',
    })
  })

  it('keeps repair progress notifications synchronous on the default service path', async () => {
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: '{"plugins":[{"id":"wecom-openclaw-plugin"}]}',
      stderr: '',
      code: 0,
    })
    parseJsonFromCommandResultMock.mockReturnValue({
      plugins: [{ id: 'wecom-openclaw-plugin' }],
    })
    readConfigMock.mockResolvedValue({
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {},
    })

    const mod = await loadModule()
    const result = await mod.repairManagedChannelPlugin('wecom')

    expect(result).toMatchObject({
      kind: 'ok',
      channelId: 'wecom',
    })
    expect(sendRepairProgressMock).toHaveBeenCalledTimes(3)
    expect(sendRepairProgressMock.mock.calls[0]?.[0]).toMatchObject({
      channelId: 'wecom',
      phase: 'config-write',
      status: 'in-progress',
    })
    expect(sendRepairProgressMock.mock.calls[1]?.[0]).toMatchObject({
      channelId: 'wecom',
      phase: 'gateway-reload',
      status: 'in-progress',
    })
    expect(sendRepairProgressMock.mock.calls[2]?.[0]).toMatchObject({
      channelId: 'wecom',
      phase: 'gateway-reload',
      status: 'success',
    })
    expect(reloadGatewayForConfigChangeMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendRepairProgressMock.mock.invocationCallOrder[1]
    )
    expect(sendRepairProgressMock.mock.invocationCallOrder[2]).toBeGreaterThan(
      reloadGatewayForConfigChangeMock.mock.invocationCallOrder[0]
    )
  })
})
