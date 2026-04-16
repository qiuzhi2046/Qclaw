import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  applyConfigPatchGuardedMock,
  installPluginMock,
  isPluginInstalledOnDiskMock,
  readConfigMock,
  reloadGatewayForConfigChangeMock,
  repairIncompatibleExtensionPluginsMock,
  runDoctorMock,
  uninstallPluginMock,
} = vi.hoisted(() => ({
  applyConfigPatchGuardedMock: vi.fn(),
  installPluginMock: vi.fn(),
  isPluginInstalledOnDiskMock: vi.fn(),
  readConfigMock: vi.fn(),
  reloadGatewayForConfigChangeMock: vi.fn(),
  repairIncompatibleExtensionPluginsMock: vi.fn(),
  runDoctorMock: vi.fn(),
  uninstallPluginMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  installPlugin: installPluginMock,
  isPluginInstalledOnDisk: isPluginInstalledOnDiskMock,
  readConfig: readConfigMock,
  repairIncompatibleExtensionPlugins: repairIncompatibleExtensionPluginsMock,
  runDoctor: runDoctorMock,
  uninstallPlugin: uninstallPluginMock,
}))

vi.mock('../openclaw-config-coordinator', () => ({
  applyConfigPatchGuarded: applyConfigPatchGuardedMock,
}))

vi.mock('../gateway-lifecycle-controller', () => ({
  reloadGatewayForConfigChange: reloadGatewayForConfigChangeMock,
}))

describe('setupDingtalkOfficialChannel', () => {
  beforeEach(() => {
    applyConfigPatchGuardedMock.mockReset()
    installPluginMock.mockReset()
    isPluginInstalledOnDiskMock.mockReset()
    readConfigMock.mockReset()
    reloadGatewayForConfigChangeMock.mockReset()
    repairIncompatibleExtensionPluginsMock.mockReset()
    runDoctorMock.mockReset()
    uninstallPluginMock.mockReset()

    readConfigMock.mockResolvedValue({
      gateway: {
        auth: {
          token: 'gw-token',
        },
      },
      channels: {},
    })
    runDoctorMock.mockResolvedValue({
      ok: true,
      stdout: 'doctor ok',
      stderr: '',
      code: 0,
    })
    repairIncompatibleExtensionPluginsMock.mockResolvedValue({
      ok: true,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '',
      stderr: '',
    })
    uninstallPluginMock.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    reloadGatewayForConfigChangeMock.mockResolvedValue({
      ok: true,
      running: true,
      stdout: '',
      stderr: '',
      code: 0,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
    })
  })

  it('installs the managed DingTalk plugin, writes the transitional config patch, and confirms gateway readiness', async () => {
    isPluginInstalledOnDiskMock.mockResolvedValue(false)
    installPluginMock.mockResolvedValue({
      ok: true,
      stdout: 'installed',
      stderr: '',
      code: 0,
    })
    applyConfigPatchGuardedMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: [
        '$.channels.dingtalk-connector',
        '$.gateway.http.endpoints.chatCompletions.enabled',
      ],
      ownershipSummary: null,
      message: '写入成功',
    })

    const { setupDingtalkOfficialChannel } = await import('../dingtalk-official-channel')
    const result = await setupDingtalkOfficialChannel({
      clientId: 'cli_ding',
      clientSecret: 'ding-secret',
    })

    expect(repairIncompatibleExtensionPluginsMock).toHaveBeenCalledWith({
      scopePluginIds: ['dingtalk-connector', 'dingtalk'],
      quarantineOfficialManagedPlugins: true,
    })
    expect(uninstallPluginMock).toHaveBeenNthCalledWith(1, 'dingtalk-connector')
    expect(uninstallPluginMock).toHaveBeenNthCalledWith(2, 'dingtalk')
    expect(installPluginMock).toHaveBeenCalledWith(
      '@dingtalk-real-ai/dingtalk-connector',
      ['dingtalk-connector']
    )
    expect(applyConfigPatchGuardedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeConfig: {
          gateway: {
            auth: {
              token: 'gw-token',
            },
          },
          channels: {},
        },
        afterConfig: expect.objectContaining({
          channels: {
            'dingtalk-connector': expect.objectContaining({
              enabled: true,
              clientId: 'cli_ding',
              clientSecret: 'ding-secret',
            }),
          },
        }),
        reason: 'channel-connect-configure',
      }),
      undefined,
      {
        applyGatewayPolicy: false,
      }
    )
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith(
      'dingtalk-official-channel-setup',
      {
        preferEnsureWhenNotRunning: true,
      }
    )
    expect(result.ok).toBe(true)
    expect(result.installedThisRun).toBe(true)
    expect(result.changedPaths).toEqual([
      '$.channels.dingtalk-connector',
      '$.gateway.http.endpoints.chatCompletions.enabled',
    ])
    expect(result.gatewayResult).toEqual({
      ok: true,
      running: true,
      requestedAction: 'reload-after-setup',
      summary: 'Gateway 已确认可用',
      stateCode: 'healthy',
    })
    expect(result.evidence.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        '已完成钉钉官方预检修复',
        '已安装钉钉官方插件',
        '已写入钉钉最小配置补丁',
        'Gateway 已确认可用',
      ])
    )
  })

  it('reuses an on-disk official plugin, removes legacy gatewayToken, and reloads gateway', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        auth: {
          token: 'gw-token',
        },
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true,
            },
          },
        },
      },
      channels: {
        'dingtalk-connector': {
          enabled: true,
          clientId: 'cli_ding',
          clientSecret: 'ding-secret',
          gatewayToken: 'gw-token',
        },
      },
    })
    isPluginInstalledOnDiskMock.mockResolvedValue(true)
    applyConfigPatchGuardedMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: false,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: '配置没有发生变化，无需写入。',
    })

    const { setupDingtalkOfficialChannel } = await import('../dingtalk-official-channel')
    const result = await setupDingtalkOfficialChannel({
      clientId: 'cli_ding',
      clientSecret: 'ding-secret',
    })

    expect(repairIncompatibleExtensionPluginsMock).toHaveBeenCalledWith({
      scopePluginIds: ['dingtalk-connector', 'dingtalk'],
      quarantineOfficialManagedPlugins: true,
    })
    expect(installPluginMock).not.toHaveBeenCalled()
    expect(uninstallPluginMock).not.toHaveBeenCalled()
    expect(applyConfigPatchGuardedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        afterConfig: expect.objectContaining({
          channels: {
            'dingtalk-connector': expect.not.objectContaining({
              gatewayToken: expect.anything(),
            }),
          },
        }),
      }),
      undefined,
      {
        applyGatewayPolicy: false,
      }
    )
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.installedThisRun).toBe(false)
    expect(result.applySummary).toBe('配置没有发生变化，无需写入。')
    expect(result.evidence.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        '已复用已安装的钉钉官方插件',
        '钉钉最小配置补丁已确认，无需重复写入',
      ])
    )
  })

  it('keeps the legacy root-key sanitize step before doctor and setup writes', async () => {
    const legacyConfig = {
      streaming: {
        legacy: true,
      },
      gateway: {
        auth: {
          token: 'gw-token',
        },
      },
      channels: {},
    }
    const sanitizedConfig = {
      gateway: {
        auth: {
          token: 'gw-token',
        },
      },
      channels: {},
    }
    readConfigMock
      .mockResolvedValueOnce(legacyConfig)
      .mockResolvedValueOnce(sanitizedConfig)
    isPluginInstalledOnDiskMock.mockResolvedValue(true)
    applyConfigPatchGuardedMock
      .mockResolvedValueOnce({
        ok: true,
        blocked: false,
        wrote: true,
        target: 'config',
        snapshotCreated: false,
        snapshot: null,
        changedJsonPaths: ['$.streaming'],
        ownershipSummary: null,
        message: '已清理历史 root 级别渠道键',
      })
      .mockResolvedValueOnce({
        ok: true,
        blocked: false,
        wrote: true,
        target: 'config',
        snapshotCreated: false,
        snapshot: null,
        changedJsonPaths: ['$.channels.dingtalk-connector'],
        ownershipSummary: null,
        message: '写入成功',
      })

    const { setupDingtalkOfficialChannel } = await import('../dingtalk-official-channel')
    const result = await setupDingtalkOfficialChannel({
      clientId: 'cli_ding',
      clientSecret: 'ding-secret',
    })

    expect(applyConfigPatchGuardedMock).toHaveBeenNthCalledWith(
      1,
      {
        beforeConfig: legacyConfig,
        afterConfig: sanitizedConfig,
        reason: 'channel-connect-sanitize',
      },
      undefined,
      {
        applyGatewayPolicy: false,
      }
    )
    expect(applyConfigPatchGuardedMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        beforeConfig: sanitizedConfig,
        reason: 'channel-connect-configure',
      }),
      undefined,
      {
        applyGatewayPolicy: false,
      }
    )
    expect(applyConfigPatchGuardedMock.mock.invocationCallOrder[0]).toBeLessThan(
      runDoctorMock.mock.invocationCallOrder[0]
    )
    expect(runDoctorMock.mock.invocationCallOrder[0]).toBeLessThan(
      applyConfigPatchGuardedMock.mock.invocationCallOrder[1]
    )
    expect(result.ok).toBe(true)
    expect(result.evidence.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        '已清理历史 root 级别渠道键',
        '已完成钉钉官方预检修复',
        '已写入钉钉最小配置补丁',
      ])
    )
  })

  it('stops before plugin install when doctor fix fails', async () => {
    readConfigMock.mockResolvedValue(null)
    runDoctorMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'doctor failed',
      code: 1,
    })

    const { setupDingtalkOfficialChannel } = await import('../dingtalk-official-channel')
    const result = await setupDingtalkOfficialChannel({
      clientId: 'cli_ding',
      clientSecret: 'ding-secret',
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('钉钉预检修复失败')
    expect(installPluginMock).not.toHaveBeenCalled()
    expect(applyConfigPatchGuardedMock).not.toHaveBeenCalled()
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
  })

  it('surfaces setup config patch failures without reloading gateway', async () => {
    isPluginInstalledOnDiskMock.mockResolvedValue(true)
    applyConfigPatchGuardedMock.mockResolvedValue({
      ok: false,
      blocked: true,
      wrote: false,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: '配置文件正被其他流程处理，请稍后重试。',
    })

    const { setupDingtalkOfficialChannel } = await import('../dingtalk-official-channel')
    const result = await setupDingtalkOfficialChannel({
      clientId: 'cli_ding',
      clientSecret: 'ding-secret',
    })

    expect(result.ok).toBe(false)
    expect(result.summary).toBe('钉钉配置写入失败，请检查当前 OpenClaw 配置后重试。')
    expect(result.message).toBe('配置文件正被其他流程处理，请稍后重试。')
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
  })

  it('keeps repair on the legacy doctor / repair / install / gateway pipeline without fallback config writes', async () => {
    isPluginInstalledOnDiskMock.mockResolvedValue(true)

    const { repairDingtalkOfficialChannel } = await import('../dingtalk-official-channel')
    const result = await repairDingtalkOfficialChannel()

    expect(runDoctorMock).toHaveBeenCalledWith({ fix: true, nonInteractive: true })
    expect(repairIncompatibleExtensionPluginsMock).toHaveBeenCalledWith({
      scopePluginIds: ['dingtalk-connector', 'dingtalk'],
      quarantineOfficialManagedPlugins: true,
    })
    expect(installPluginMock).not.toHaveBeenCalled()
    expect(applyConfigPatchGuardedMock).not.toHaveBeenCalled()
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith(
      'dingtalk-official-channel-repair',
      {
        preferEnsureWhenNotRunning: true,
      }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('钉钉官方插件已修复；loaded / ready 仍待上游证据。')
  })
})
