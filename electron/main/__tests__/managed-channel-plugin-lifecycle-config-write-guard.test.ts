import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  applyConfigPatchGuardedMock,
  reconcileManagedPluginConfigMock,
  dingtalkPreflightHookMock,
  sendRepairProgressMock,
} = vi.hoisted(() => ({
  applyConfigPatchGuardedMock: vi.fn(),
  reconcileManagedPluginConfigMock: vi.fn(),
  dingtalkPreflightHookMock: vi.fn(),
  sendRepairProgressMock: vi.fn(),
}))

vi.mock('../openclaw-config-coordinator', () => ({
  applyConfigPatchGuarded: applyConfigPatchGuardedMock,
}))

vi.mock('../managed-plugin-config-reconciler', () => ({
  reconcileManagedPluginConfig: reconcileManagedPluginConfigMock,
}))

vi.mock('../dingtalk-official-channel', () => ({
  dingtalkPreflightHook: dingtalkPreflightHookMock,
}))

vi.mock('../renderer-notification-bridge', () => ({
  sendRepairProgress: sendRepairProgressMock,
}))

import { createManagedChannelPluginLifecycleService } from '../managed-channel-plugin-lifecycle'

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
    isPluginInstalledOnDisk: vi.fn().mockResolvedValue(true),
    listRegisteredPlugins: vi.fn().mockResolvedValue(['wecom-openclaw-plugin']),
    readConfig: vi.fn().mockResolvedValue({
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {},
    }),
    writeConfig: vi.fn(),
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

describe('createManagedChannelPluginLifecycleService config write guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reconcileManagedPluginConfigMock.mockResolvedValue({
      changed: false,
      removedFrom: { allow: [], entries: [], installs: [], channels: [] },
      orphanedPluginIds: [],
    })
    dingtalkPreflightHookMock.mockResolvedValue({ ok: true })
    applyConfigPatchGuardedMock.mockResolvedValue({
      ok: false,
      blocked: true,
      wrote: false,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: '当前安装尚未完成首次基线备份，暂时不能修改当前配置。',
      errorCode: 'baseline_backup_required',
    })
  })

  it('stops repair and reports failure when config reconciliation cannot be written', async () => {
    const dependencies = createDependencies()
    const service = createManagedChannelPluginLifecycleService(dependencies)

    const result = await service.repairManagedChannelPlugin('wecom')

    expect(applyConfigPatchGuardedMock).toHaveBeenCalledTimes(1)
    expect(dependencies.reloadGatewayForConfigChange).not.toHaveBeenCalled()
    expect(sendRepairProgressMock).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: 'wecom',
      phase: 'config-write',
      status: 'failed',
    }))
    expect(result.kind).toBe('repair-failed')
    if (result.kind !== 'repair-failed') {
      throw new Error(`Expected repair-failed result, received ${result.kind}`)
    }
    expect(result.error).toContain('基线备份')
  })

  it('emits a success progress event after generic repair completes', async () => {
    applyConfigPatchGuardedMock.mockResolvedValueOnce({
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

    const dependencies = createDependencies()
    const service = createManagedChannelPluginLifecycleService(dependencies)

    const result = await service.repairManagedChannelPlugin('wecom')

    expect(result.kind).toBe('ok')
    expect(sendRepairProgressMock).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: 'wecom',
      phase: 'gateway-reload',
      status: 'success',
    }))
  })
})
