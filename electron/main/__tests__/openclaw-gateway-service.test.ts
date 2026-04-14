import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as windowsPlatformOps from '../platforms/windows/windows-platform-ops'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const { mkdtemp, rm } = fs.promises
const { tmpdir } = os
const { join } = process.getBuiltinModule('node:path') as typeof import('node:path')

const {
  applyConfigPatchGuardedMock,
  checkNodeMock,
  checkOpenClawMock,
  detectGatewayDeviceRequiredEvidenceMock,
  confirmRuntimeReconcileMock,
  detectGatewayPluginLoadFailureEvidenceMock,
  findAvailableLoopbackPortMock,
  gatewayRestartMock,
  gatewayHealthMock,
  gatewayStopMock,
  guardedWriteConfigMock,
  installPluginMock,
  installPluginNpxMock,
  inspectControlUiAppViaBrowserMock,
  isPluginInstalledOnDiskMock,
  getOpenClawPathsMock,
  readAuthoritativeWindowsChannelRuntimeSnapshotMock,
  issueDesiredRuntimeRevisionMock,
  markRuntimeRevisionInProgressMock,
  probeGatewayPortOwnerMock,
  repairManagedChannelPluginMock,
  repairDingtalkOfficialChannelMock,
  repairIncompatibleExtensionPluginsMock,
  recordObservedOpenClawVersionMock,
  resolveGatewayBlockingReasonFromStateMock,
  gatewayStartMock,
  installEnvMock,
  readConfigMock,
  refreshEnvironmentMock,
  runDoctorMock,
  runCliMock,
  runShellMock,
  uninstallPluginMock,
  pollWithBackoffMock,
  writeConfigMock,
} = vi.hoisted(() => ({
  applyConfigPatchGuardedMock: vi.fn(),
  checkNodeMock: vi.fn(),
  checkOpenClawMock: vi.fn(),
  detectGatewayDeviceRequiredEvidenceMock: vi.fn(),
  confirmRuntimeReconcileMock: vi.fn(),
  detectGatewayPluginLoadFailureEvidenceMock: vi.fn(),
  findAvailableLoopbackPortMock: vi.fn(),
  gatewayRestartMock: vi.fn(),
  gatewayHealthMock: vi.fn(),
  gatewayStopMock: vi.fn(),
  guardedWriteConfigMock: vi.fn(),
  installPluginMock: vi.fn(),
  installPluginNpxMock: vi.fn(),
  inspectControlUiAppViaBrowserMock: vi.fn(),
  isPluginInstalledOnDiskMock: vi.fn(),
  getOpenClawPathsMock: vi.fn(),
  readAuthoritativeWindowsChannelRuntimeSnapshotMock: vi.fn(),
  issueDesiredRuntimeRevisionMock: vi.fn(),
  markRuntimeRevisionInProgressMock: vi.fn(),
  probeGatewayPortOwnerMock: vi.fn(),
  repairManagedChannelPluginMock: vi.fn(),
  repairDingtalkOfficialChannelMock: vi.fn(),
  repairIncompatibleExtensionPluginsMock: vi.fn(),
  recordObservedOpenClawVersionMock: vi.fn(),
  resolveGatewayBlockingReasonFromStateMock: vi.fn(({ gatewayStateCode }: { gatewayStateCode?: string }) => {
    if (gatewayStateCode === 'auth_missing') return 'machine_local_auth_missing'
    if (gatewayStateCode === 'token_mismatch') return 'runtime_token_stale'
    if (gatewayStateCode === 'websocket_1006') return 'control_ui_handshake_failed'
    if (gatewayStateCode === 'plugin_load_failure') return 'provider_plugin_not_ready'
    if (
      gatewayStateCode === 'service_missing' ||
      gatewayStateCode === 'service_install_failed' ||
      gatewayStateCode === 'service_loaded_but_stale' ||
      gatewayStateCode === 'gateway_not_running' ||
      gatewayStateCode === 'port_conflict_same_gateway' ||
      gatewayStateCode === 'port_conflict_foreign_process'
    ) {
      return 'service_generation_stale'
    }
    return 'none'
  }),
  gatewayStartMock: vi.fn(),
  installEnvMock: vi.fn(),
  readConfigMock: vi.fn(),
  refreshEnvironmentMock: vi.fn(),
  runDoctorMock: vi.fn(),
  runCliMock: vi.fn(),
  runShellMock: vi.fn(),
  uninstallPluginMock: vi.fn(),
  pollWithBackoffMock: vi.fn(),
  writeConfigMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  checkNode: checkNodeMock,
  checkOpenClaw: checkOpenClawMock,
  gatewayHealth: gatewayHealthMock,
  gatewayRestart: gatewayRestartMock,
  gatewayStop: gatewayStopMock,
  getOpenClawPaths: getOpenClawPathsMock,
  readAuthoritativeWindowsChannelRuntimeSnapshot: readAuthoritativeWindowsChannelRuntimeSnapshotMock,
  gatewayStart: gatewayStartMock,
  installEnv: installEnvMock,
  installPlugin: installPluginMock,
  installPluginNpx: installPluginNpxMock,
  isPluginInstalledOnDisk: isPluginInstalledOnDiskMock,
  readConfig: readConfigMock,
  repairIncompatibleExtensionPlugins: repairIncompatibleExtensionPluginsMock,
  refreshEnvironment: refreshEnvironmentMock,
  runDoctor: runDoctorMock,
  runCli: runCliMock,
  runShell: runShellMock,
  uninstallPlugin: uninstallPluginMock,
  writeConfig: writeConfigMock,
}))

vi.mock('../openclaw-config-coordinator', () => ({
  applyConfigPatchGuarded: applyConfigPatchGuardedMock,
}))

vi.mock('../gateway-startup-log-diagnostics', () => ({
  detectGatewayDeviceRequiredEvidence: detectGatewayDeviceRequiredEvidenceMock,
  detectGatewayPluginLoadFailureEvidence: detectGatewayPluginLoadFailureEvidenceMock,
}))

vi.mock('../openclaw-config-guard', () => ({
  guardedWriteConfig: guardedWriteConfigMock,
}))

vi.mock('../openclaw-control-ui-rpc', () => ({
  inspectControlUiAppViaBrowser: inspectControlUiAppViaBrowserMock,
}))

vi.mock('../dingtalk-official-channel', () => ({
  repairDingtalkOfficialChannel: repairDingtalkOfficialChannelMock,
}))

vi.mock('../managed-channel-plugin-lifecycle', () => ({
  repairManagedChannelPlugin: repairManagedChannelPluginMock,
}))

vi.mock('../openclaw-runtime-reconcile', () => ({
  confirmRuntimeReconcile: confirmRuntimeReconcileMock,
  issueDesiredRuntimeRevision: issueDesiredRuntimeRevisionMock,
  markRuntimeRevisionInProgress: markRuntimeRevisionInProgressMock,
  recordObservedOpenClawVersion: recordObservedOpenClawVersionMock,
  resolveGatewayBlockingReasonFromState: resolveGatewayBlockingReasonFromStateMock,
}))

vi.mock('../openclaw-gateway-probes', () => ({
  findAvailableLoopbackPort: findAvailableLoopbackPortMock,
  probeGatewayPortOwner: probeGatewayPortOwnerMock,
}))

vi.mock('../../../src/shared/polling', () => ({
  pollWithBackoff: pollWithBackoffMock,
}))

import { classifyServiceInstallFailure, ensureGatewayRunning } from '../openclaw-gateway-service'

describe('openclaw gateway service', () => {
  const itOnWindows = process.platform === 'win32' ? it : it.skip
  const tempDirs: string[] = []

  function createDeferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  async function createOpenClawHome() {
    const homeDir = await mkdtemp(join(tmpdir(), 'qclaw-gateway-feishu-'))
    tempDirs.push(homeDir)
    return homeDir
  }

  function createAuthoritativeWindowsChannelRuntimeSnapshot(input: {
    homeDir: string
    ownerKind?: string
    ownerLauncherPath?: string
    ownerTaskName?: string
  }) {
    return {
      hostPackageRoot: 'C:\\runtime\\node_modules\\openclaw',
      nodePath: 'C:\\runtime\\node.exe',
      openclawPath: 'C:\\runtime\\openclaw.cmd',
      stateDir: input.homeDir,
      gatewayOwner: {
        ownerKind: input.ownerKind || 'scheduled-task',
        ownerLauncherPath: input.ownerLauncherPath || '',
        ownerTaskName: input.ownerTaskName || '',
      },
      managedPlugin: {
        allowedInConfig: false,
        configured: false,
        installedOnDisk: false,
        loaded: false,
        ready: false,
        registered: false,
      },
      resolvedBinding: {
        accountId: '',
        agentId: '',
        channelId: '',
        source: '',
      },
    }
  }

  beforeEach(async () => {
    checkNodeMock.mockReset()
    checkOpenClawMock.mockReset()
    applyConfigPatchGuardedMock.mockReset()
    confirmRuntimeReconcileMock.mockReset()
    detectGatewayDeviceRequiredEvidenceMock.mockReset()
    detectGatewayPluginLoadFailureEvidenceMock.mockReset()
    findAvailableLoopbackPortMock.mockReset()
    gatewayRestartMock.mockReset()
    gatewayHealthMock.mockReset()
    gatewayStopMock.mockReset()
    guardedWriteConfigMock.mockReset()
    installPluginMock.mockReset()
    installPluginNpxMock.mockReset()
    inspectControlUiAppViaBrowserMock.mockReset()
    isPluginInstalledOnDiskMock.mockReset()
    getOpenClawPathsMock.mockReset()
    readAuthoritativeWindowsChannelRuntimeSnapshotMock.mockReset()
    issueDesiredRuntimeRevisionMock.mockReset()
    markRuntimeRevisionInProgressMock.mockReset()
    probeGatewayPortOwnerMock.mockReset()
    repairManagedChannelPluginMock.mockReset()
    repairDingtalkOfficialChannelMock.mockReset()
    repairIncompatibleExtensionPluginsMock.mockReset()
    recordObservedOpenClawVersionMock.mockReset()
    resolveGatewayBlockingReasonFromStateMock.mockClear()
    gatewayStartMock.mockReset()
    installEnvMock.mockReset()
    readConfigMock.mockReset()
    refreshEnvironmentMock.mockReset()
    runDoctorMock.mockReset()
    runCliMock.mockReset()
    runShellMock.mockReset()
    uninstallPluginMock.mockReset()
    pollWithBackoffMock.mockReset()
    writeConfigMock.mockReset()

    const defaultHomeDir = await createOpenClawHome()

    checkNodeMock.mockResolvedValue({
      installed: true,
      version: 'v22.22.1',
      needsUpgrade: false,
      meetsRequirement: true,
      requiredVersion: '22.16.0',
      targetVersion: 'v24.14.0',
      installStrategy: 'installer',
    })
    checkOpenClawMock.mockResolvedValue({
      installed: true,
      selectedRuntimeComplete: true,
      version: 'OpenClaw 2026.3.12',
    })
    confirmRuntimeReconcileMock.mockResolvedValue({
      runtime: {
        desiredRevision: 1,
      },
    })
    gatewayHealthMock.mockResolvedValue({
      running: false,
      raw: '',
    })
    gatewayRestartMock.mockResolvedValue({
      ok: true,
      stdout: 'restarted',
      stderr: '',
      code: 0,
    })
    gatewayStopMock.mockResolvedValue({
      ok: true,
      stdout: 'stopped',
      stderr: '',
      code: 0,
    })
    guardedWriteConfigMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['gateway.port'],
      ownershipSummary: null,
      message: 'written',
    })
    inspectControlUiAppViaBrowserMock.mockResolvedValue({
      connected: false,
      hasClient: false,
      lastError: '',
      appKeys: [],
    })
    getOpenClawPathsMock.mockResolvedValue({
      homeDir: defaultHomeDir,
    })
    applyConfigPatchGuardedMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['gateway.mode'],
      ownershipSummary: null,
      message: 'patched',
    })
    readAuthoritativeWindowsChannelRuntimeSnapshotMock.mockReturnValue(null)
    issueDesiredRuntimeRevisionMock.mockResolvedValue({
      runtime: {
        desiredRevision: 1,
        lastActions: [],
      },
    })
    markRuntimeRevisionInProgressMock.mockResolvedValue({
      runtime: {
        desiredRevision: 1,
      },
    })
    probeGatewayPortOwnerMock.mockResolvedValue({
      kind: 'none',
      port: 18789,
      source: 'lsof',
    })
    findAvailableLoopbackPortMock.mockResolvedValue(19876)
    gatewayStartMock.mockResolvedValue({
      ok: true,
      stdout: 'started',
      stderr: '',
      code: 0,
    })
    installEnvMock.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    installPluginMock.mockResolvedValue({
      ok: true,
      stdout: 'installed package plugin',
      stderr: '',
      code: 0,
    })
    installPluginNpxMock.mockResolvedValue({
      ok: true,
      stdout: 'installed npx plugin',
      stderr: '',
      code: 0,
    })
    runShellMock.mockResolvedValue({
      ok: true,
      stdout: 'openclaw-weixin-1.0.0.tgz\n',
      stderr: '',
      code: 0,
    })
    isPluginInstalledOnDiskMock.mockResolvedValue(true)
    repairDingtalkOfficialChannelMock.mockResolvedValue({
      ok: true,
      summary: '钉钉官方插件配置已完成',
      stderr: '',
      message: '',
    })
    readConfigMock.mockResolvedValue(null)
    repairIncompatibleExtensionPluginsMock.mockResolvedValue({
      ok: true,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '未发现坏插件。',
      stderr: '',
    })
    repairManagedChannelPluginMock.mockResolvedValue({
      kind: 'ok',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: {
        channelId: 'wecom',
        pluginId: 'wecom-openclaw-plugin',
        summary: '企微插件已修复。',
        stages: [],
        evidence: [],
      },
    })
    refreshEnvironmentMock.mockResolvedValue({ ok: true })
    runDoctorMock.mockResolvedValue({
      ok: true,
      stdout: 'doctor ok',
      stderr: '',
      code: 0,
    })
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: 'installed',
      stderr: '',
      code: 0,
    })
    uninstallPluginMock.mockResolvedValue({
      ok: true,
      stdout: 'uninstalled',
      stderr: '',
      code: 0,
    })
    writeConfigMock.mockResolvedValue(undefined)
    pollWithBackoffMock.mockImplementation(async ({ execute, isSuccess }) => {
      const value = await execute({ attempt: 1, elapsedMs: 0 })
      return {
        ok: isSuccess(value, { attempt: 1, elapsedMs: 0 }),
        attempts: 1,
        elapsedMs: 0,
        value,
        aborted: false,
      }
    })
    recordObservedOpenClawVersionMock.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((target) => rm(target, { recursive: true, force: true })))
  })

  it('auto-installs the gateway service when start reports service not loaded', async () => {
    gatewayStartMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Gateway service not loaded.',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'started after install',
        stderr: '',
        code: 0,
      })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const result = await ensureGatewayRunning()

    expect(runCliMock).toHaveBeenCalledWith(['gateway', 'install'], undefined, 'gateway')
    expect(gatewayStartMock).toHaveBeenCalledTimes(2)
    expect(issueDesiredRuntimeRevisionMock).toHaveBeenCalledWith(
      'gateway-bootstrap',
      'gateway_config_changed',
      expect.any(Object)
    )
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.stateCode).toBe('healthy')
    expect(result.autoInstalledGatewayService).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['gateway', 'start'],
      ['gateway', 'install'],
      ['gateway', 'start'],
      ])
  })

  it('auto-installs the gateway service when older CLI builds report the service as missing', async () => {
    gatewayStartMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Gateway service missing.',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'started after install',
        stderr: '',
        code: 0,
      })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const result = await ensureGatewayRunning()

    expect(runCliMock).toHaveBeenCalledWith(['gateway', 'install'], undefined, 'gateway')
    expect(gatewayStartMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.stateCode).toBe('healthy')
    expect(result.autoInstalledGatewayService).toBe(true)
  })

  it('confirms runtime reconcile when the gateway is already healthy without a new revision', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
    })
    gatewayHealthMock.mockResolvedValueOnce({
      running: true,
      raw: '{"ok":true}',
      stderr: '',
      code: 0,
    })

    const result = await ensureGatewayRunning()

    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(issueDesiredRuntimeRevisionMock).not.toHaveBeenCalled()
    expect(confirmRuntimeReconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: true,
        revision: undefined,
        blockingReason: 'none',
        safeToRetry: true,
        summary: '网关已确认可用，运行状态已通过健康探针确认。',
      })
    )
  })

  it('confirms runtime reconcile after applying a startup config patch to an already running gateway', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      plugins: {
        allow: [],
        entries: {
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    })
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
      })

    const result = await ensureGatewayRunning()

    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(issueDesiredRuntimeRevisionMock).toHaveBeenCalledWith(
      'gateway-bootstrap',
      'gateway_config_changed',
      expect.any(Object)
    )
    expect(confirmRuntimeReconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: true,
        revision: 1,
      })
    )
  })

  it('auto-installs missing runtime dependencies before starting the gateway', async () => {
    checkNodeMock
      .mockResolvedValueOnce({
        installed: false,
        version: '',
        needsUpgrade: false,
        meetsRequirement: false,
        requiredVersion: '22.16.0',
        targetVersion: 'v24.14.0',
        installStrategy: 'installer',
      })
      .mockResolvedValueOnce({
        installed: true,
        version: 'v24.14.0',
        needsUpgrade: false,
        meetsRequirement: true,
        requiredVersion: '22.16.0',
        targetVersion: 'v24.14.0',
        installStrategy: 'installer',
      })
    checkOpenClawMock
      .mockResolvedValueOnce({
        installed: false,
        version: '',
      })
      .mockResolvedValueOnce({
        installed: true,
        version: 'OpenClaw 2026.3.12',
      })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const result = await ensureGatewayRunning()

    expect(installEnvMock).toHaveBeenCalledWith({
      needNode: true,
      needOpenClaw: true,
    })
    expect(refreshEnvironmentMock).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.autoInstalledNode).toBe(true)
    expect(result.autoInstalledOpenClaw).toBe(true)
  })

  it('uses authoritative selected runtime completeness instead of a global host illusion', async () => {
    checkOpenClawMock
      .mockResolvedValueOnce({
        installed: true,
        selectedRuntimeComplete: false,
        version: 'OpenClaw 2026.3.12',
      })
      .mockResolvedValueOnce({
        installed: true,
        selectedRuntimeComplete: true,
        version: 'OpenClaw 2026.3.12',
      })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const result = await ensureGatewayRunning()

    expect(installEnvMock).toHaveBeenCalledWith({
      needNode: false,
      needOpenClaw: true,
    })
    expect(refreshEnvironmentMock).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.autoInstalledNode).toBe(false)
    expect(result.autoInstalledOpenClaw).toBe(true)
  })

  it('blocks gateway startup when Node.js is installed but below the minimum supported version', async () => {
    checkNodeMock.mockResolvedValueOnce({
      installed: true,
      version: 'v22.15.0',
      needsUpgrade: true,
      meetsRequirement: false,
      requiredVersion: '22.16.0',
      targetVersion: 'v24.14.0',
      installStrategy: 'installer',
    })

    const result = await ensureGatewayRunning()

    expect(installEnvMock).not.toHaveBeenCalled()
    expect(gatewayStartMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.running).toBe(false)
    expect(result.summary).toContain('Node.js 版本过低')
    expect(result.stderr).toContain('OpenClaw 需要 Node.js 22.16.0 或更高版本')
  })

  it('does not attempt plugin installation when config enables Feishu', async () => {
    const homeDir = await createOpenClawHome()
    getOpenClawPathsMock.mockResolvedValue({ homeDir })
    readConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            bot: {
              appId: 'cli_test',
              appSecret: 'secret',
            },
          },
        },
      },
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const result = await ensureGatewayRunning()

    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('falls back to npm pack archive install when weixin self-heal hits a ClawHub resolution failure', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      channels: {
        'openclaw-weixin': {
          enabled: true,
          accounts: {
            'wx-account': {
              enabled: true,
            },
          },
        },
      },
      plugins: {},
    })

    isPluginInstalledOnDiskMock
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: '- channels.openclaw-weixin: unknown channel id: openclaw-weixin',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway healthy',
      })
    repairManagedChannelPluginMock.mockResolvedValueOnce({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      status: {
        channelId: 'openclaw-weixin',
        pluginId: 'openclaw-weixin',
        summary: '微信插件仍待交互式安装器完成安装。',
        stages: [],
        evidence: [],
      },
    })
    installPluginMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'Resolving clawhub:@tencent-weixin/openclaw-weixin...\nfetch failed',
      code: 1,
    })
    installPluginMock.mockResolvedValueOnce({
      ok: true,
      stdout: 'installed archive plugin',
      stderr: '',
      code: 0,
    })

    const result = await ensureGatewayRunning()

    expect(installPluginMock).toHaveBeenCalledWith(
      '@tencent-weixin/openclaw-weixin',
      ['openclaw-weixin']
    )
    expect(runShellMock).toHaveBeenCalledWith(
      'npm',
      ['pack', '@tencent-weixin/openclaw-weixin', '--silent'],
      undefined,
      expect.objectContaining({
        controlDomain: 'plugin-install',
        env: expect.objectContaining({
          npm_config_cache: expect.any(String),
          NPM_CONFIG_CACHE: expect.any(String),
        }),
      })
    )
    expect(installPluginMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/openclaw-weixin-1\.0\.0\.tgz$/),
      ['openclaw-weixin']
    )
    expect(runCliMock).not.toHaveBeenCalledWith(
      ['plugins', 'install', expect.stringMatching(/openclaw-weixin-1\.0\.0\.tgz$/)],
      undefined,
      'plugin-install'
    )
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('heals an empty trusted plugin allowlist before starting the gateway', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      plugins: {
        allow: [],
        entries: {
          'minimax-portal-auth': { enabled: true },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const result = await ensureGatewayRunning()

    expect(applyConfigPatchGuardedMock).toHaveBeenCalledWith({
      beforeConfig: {
        gateway: {
          mode: 'local',
        },
        plugins: {
          allow: [],
          entries: {
            'minimax-portal-auth': { enabled: true },
            'openclaw-lark': { enabled: true },
          },
          installs: {
            'openclaw-lark': {
              spec: '@larksuite/openclaw-lark',
            },
          },
        },
      },
      afterConfig: {
        gateway: {
          mode: 'local',
        },
        plugins: {
          allow: ['minimax-portal-auth', 'openclaw-lark'],
          entries: {
            feishu: { enabled: false },
            'minimax-portal-auth': { enabled: true },
            'openclaw-lark': { enabled: true },
          },
          installs: {
            'openclaw-lark': {
              spec: '@larksuite/openclaw-lark',
            },
          },
        },
      },
      reason: 'unknown',
    }, undefined, { applyGatewayPolicy: false })
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('prioritizes the official doctor fix path when health reports config_invalid before startup', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      defaultModel: 'openai/gpt-5',
    })
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: 'Config invalid',
        stderr: 'Problem: <root>: Unrecognized key: "defaultModel"\nRun "openclaw doctor --fix"',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
      })
    runDoctorMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Unknown config keys: defaultModel\nRun "openclaw doctor --fix" to remove these keys',
        stderr: '',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'Removed defaultModel',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Unknown config keys: defaultModel\nRun "openclaw doctor --fix" to remove these keys',
        stderr: '',
        code: 1,
      })

    const result = await ensureGatewayRunning()

    expect(gatewayStartMock).not.toHaveBeenCalled()
    expect(issueDesiredRuntimeRevisionMock).toHaveBeenCalledWith(
      'gateway-bootstrap',
      'gateway_official_repair_required',
      expect.any(Object)
    )
    expect(runDoctorMock).toHaveBeenNthCalledWith(1, undefined)
    expect(runDoctorMock).toHaveBeenNthCalledWith(2, { fix: true })
    expect(runDoctorMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['doctor', '--non-interactive'],
      ['doctor', '--fix', '--non-interactive'],
    ])
  })

  it('prioritizes the official doctor fix path when gateway start itself returns config_invalid', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      defaultModel: 'openai/gpt-5',
    })
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: 'Gateway not running',
        code: 1,
        stateCode: 'gateway_not_running',
        summary: 'Gateway not running',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway 已确认可用',
      })
    gatewayStartMock.mockResolvedValueOnce({
      ok: false,
      stdout: 'Config invalid',
      stderr: 'Problem: <root>: Unrecognized key: "defaultModel"\nRun "openclaw doctor --fix"',
      code: 1,
    })
    runDoctorMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Unknown config keys: defaultModel\nRun "openclaw doctor --fix" to remove these keys',
        stderr: '',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'Removed defaultModel',
        stderr: '',
        code: 0,
      })

    const result = await ensureGatewayRunning()

    expect(gatewayStartMock).toHaveBeenCalledTimes(1)
    expect(runDoctorMock).toHaveBeenNthCalledWith(1, undefined)
    expect(runDoctorMock).toHaveBeenNthCalledWith(2, { fix: true })
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['gateway', 'start'],
      ['doctor', '--non-interactive'],
      ['doctor', '--fix', '--non-interactive'],
    ])
  })

  it('repairs unknown managed channel ids through the managed channel registry before doctor fallback', async () => {
    readConfigMock
      .mockResolvedValueOnce({
        gateway: {
          mode: 'local',
        },
        channels: {
          wecom: {
            enabled: true,
            botId: 'bot_123',
            secret: 'secret_456',
          },
          qqbot: {
            enabled: true,
            appId: 'app_qq',
            clientSecret: 'secret_qq',
          },
        },
      })
      .mockResolvedValueOnce({
        gateway: {
          mode: 'local',
        },
        channels: {
          wecom: {
            enabled: true,
            botId: 'bot_123',
            secret: 'secret_456',
          },
          qqbot: {
            enabled: true,
            appId: 'app_qq',
            clientSecret: 'secret_qq',
          },
        },
        plugins: {},
      })

    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: [
          'Config invalid',
          '- channels.wecom: unknown channel id: wecom',
          '- channels.qqbot: unknown channel id: qqbot',
        ].join('\n'),
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
      })

    repairManagedChannelPluginMock
      .mockResolvedValueOnce({
        kind: 'ok',
        channelId: 'wecom',
        pluginScope: 'channel',
        entityScope: 'channel',
        action: 'installed',
        status: {
          channelId: 'wecom',
          pluginId: 'wecom-openclaw-plugin',
          summary: '企微插件已修复。',
          stages: [],
          evidence: [],
        },
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        channelId: 'qqbot',
        pluginScope: 'channel',
        entityScope: 'channel',
        action: 'installed',
        status: {
          channelId: 'qqbot',
          pluginId: 'openclaw-qqbot',
          summary: 'QQ 插件已修复。',
          stages: [],
          evidence: [],
        },
      })

    const result = await ensureGatewayRunning()

    expect(repairManagedChannelPluginMock).toHaveBeenNthCalledWith(1, 'wecom')
    expect(repairManagedChannelPluginMock).toHaveBeenNthCalledWith(2, 'qqbot')
    expect(runDoctorMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('continues into the official doctor repair when managed channel repair still reports config_invalid', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      defaultModel: 'openai/gpt-5',
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
    })

    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: 'Config invalid',
        stderr: [
          '- channels.wecom: unknown channel id: wecom',
          'Problem: <root>: Unrecognized key: "defaultModel"',
          'Run "openclaw doctor --fix"',
        ].join('\n'),
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: false,
        raw: 'Config invalid',
        stderr: 'Problem: <root>: Unrecognized key: "defaultModel"\nRun "openclaw doctor --fix"',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
      })
    runDoctorMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Unknown config keys: defaultModel\nRun "openclaw doctor --fix" to remove these keys',
        stderr: '',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'Removed defaultModel',
        stderr: '',
        code: 0,
      })

    repairManagedChannelPluginMock.mockResolvedValueOnce({
      kind: 'ok',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: {
        channelId: 'wecom',
        pluginId: 'wecom-openclaw-plugin',
        summary: '企微插件已修复。',
        stages: [],
        evidence: [],
      },
    })

    const result = await ensureGatewayRunning()

    expect(repairManagedChannelPluginMock).toHaveBeenCalledWith('wecom')
    expect(gatewayStartMock).not.toHaveBeenCalled()
    expect(runDoctorMock).toHaveBeenNthCalledWith(1, undefined)
    expect(runDoctorMock).toHaveBeenNthCalledWith(2, { fix: true })
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('matches dingtalk legacy channel aliases and delegates to the dedicated repair flow', async () => {
    readConfigMock
      .mockResolvedValueOnce({
        gateway: {
          mode: 'local',
        },
        channels: {
          'dingtalk-connector': {
            enabled: true,
            clientId: 'cli_ding',
            clientSecret: 'secret_ding',
          },
        },
      })
      .mockResolvedValueOnce({
        gateway: {
          mode: 'local',
        },
        channels: {
          'dingtalk-connector': {
            enabled: true,
            clientId: 'cli_ding',
            clientSecret: 'secret_ding',
          },
        },
        plugins: {},
      })

    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: '- channels.dingtalk-connector: unknown channel id: dingtalk-connector',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
      })

    repairManagedChannelPluginMock.mockResolvedValueOnce({
      kind: 'ok',
      channelId: 'dingtalk',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: {
        channelId: 'dingtalk',
        pluginId: 'dingtalk-connector',
        summary: '钉钉插件已修复。',
        stages: [],
        evidence: [],
      },
    })

    const result = await ensureGatewayRunning()

    expect(repairManagedChannelPluginMock).toHaveBeenCalledWith('dingtalk')
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('self-heals personal weixin unknown-channel failures by installing the managed plugin and retrying health', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      channels: {
        'openclaw-weixin': {
          enabled: true,
          accounts: {
            'wx-account': {
              enabled: true,
            },
          },
        },
      },
      plugins: {},
    })

    isPluginInstalledOnDiskMock
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: '- channels.openclaw-weixin: unknown channel id: openclaw-weixin',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway healthy',
      })
    repairManagedChannelPluginMock.mockResolvedValueOnce({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      status: {
        channelId: 'openclaw-weixin',
        pluginId: 'openclaw-weixin',
        summary: '微信插件仍待交互式安装器完成安装。',
        stages: [],
        evidence: [],
      },
    })

    const result = await ensureGatewayRunning()

    expect(repairManagedChannelPluginMock).toHaveBeenCalledWith('openclaw-weixin')
    expect(installPluginMock).toHaveBeenCalledWith(
      '@tencent-weixin/openclaw-weixin',
      ['openclaw-weixin']
    )
    expect(guardedWriteConfigMock).toHaveBeenCalledWith({
      config: {
        gateway: {
          mode: 'local',
        },
        channels: {
          'openclaw-weixin': {
            enabled: true,
            accounts: {
              'wx-account': {
                enabled: true,
              },
            },
          },
        },
        plugins: {
          allow: ['openclaw-weixin'],
        },
      },
      reason: 'managed-channel-plugin-repair',
    })
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('classifies post-weixin-self-heal startup failures from the new startup error instead of the stale initial config_invalid state', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      channels: {
        'openclaw-weixin': {
          enabled: true,
          accounts: {
            'wx-account': {
              enabled: true,
            },
          },
        },
      },
      plugins: {},
    })

    isPluginInstalledOnDiskMock
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: '- channels.openclaw-weixin: unknown channel id: openclaw-weixin',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: 'Gateway not running',
        code: 1,
        stateCode: 'gateway_not_running',
        summary: 'Gateway not running',
      })

    repairManagedChannelPluginMock.mockResolvedValueOnce({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      status: {
        channelId: 'openclaw-weixin',
        pluginId: 'openclaw-weixin',
        summary: '微信插件仍待交互式安装器完成安装。',
        stages: [],
        evidence: [],
      },
    })
    gatewayStartMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'authentication required: api key missing',
      code: 1,
    })

    const result = await ensureGatewayRunning()

    expect(result.ok).toBe(false)
    expect(result.running).toBe(false)
    expect(result.stateCode).toBe('auth_missing')
    expect(result.safeToRetry).toBe(false)
  })

  it('still enters the weixin self-heal path when the initial health failure also includes a follow-up websocket 1006 closure', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
      channels: {
        'openclaw-weixin': {
          enabled: true,
          accounts: {
            'wx-account': {
              enabled: true,
            },
          },
        },
      },
      plugins: {},
    })

    isPluginInstalledOnDiskMock
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: [
          'Config invalid',
          'File: ~/.openclaw/openclaw.json',
          'Problem:',
          '  - channels.openclaw-weixin: unknown channel id: openclaw-weixin',
          'Run: openclaw doctor --fix',
          '[openclaw] Failed to start CLI: Error: gateway closed (1006 abnormal closure (no close frame)): no close reason',
        ].join('\n'),
        code: 1,
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway healthy',
      })

    repairManagedChannelPluginMock.mockResolvedValueOnce({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      status: {
        channelId: 'openclaw-weixin',
        pluginId: 'openclaw-weixin',
        summary: '微信插件仍待交互式安装器完成安装。',
        stages: [],
        evidence: [],
      },
    })

    const result = await ensureGatewayRunning()

    expect(repairManagedChannelPluginMock).toHaveBeenCalledWith('openclaw-weixin')
    expect(installPluginMock).toHaveBeenCalledWith(
      '@tencent-weixin/openclaw-weixin',
      ['openclaw-weixin']
    )
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('returns a blocking failure when managed channel config healing cannot be written', async () => {
    readConfigMock
      .mockResolvedValueOnce({
        gateway: {
          mode: 'local',
        },
        channels: {
          wecom: {
            enabled: true,
            botId: 'bot_123',
            secret: 'secret_456',
          },
        },
      })
      .mockResolvedValueOnce({
        gateway: {
          mode: 'local',
        },
        channels: {
          wecom: {
            enabled: true,
            botId: 'bot_123',
            secret: 'secret_456',
          },
        },
        plugins: {},
      })

    gatewayHealthMock.mockResolvedValueOnce({
      running: false,
      raw: '',
      stderr: '- channels.wecom: unknown channel id: wecom',
      code: 1,
      stateCode: 'config_invalid',
      summary: 'Config invalid',
    })

    repairManagedChannelPluginMock.mockResolvedValueOnce({
      kind: 'repair-failed',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      status: {
        channelId: 'wecom',
        pluginId: 'wecom-openclaw-plugin',
        summary: '企微插件修复失败。',
        stages: [],
        evidence: [],
      },
      error: 'write denied',
    })

    const result = await ensureGatewayRunning()

    expect(result.ok).toBe(false)
    expect(result.running).toBe(false)
    expect(result.summary).toContain('write denied')
    expect(runDoctorMock).not.toHaveBeenCalled()
    expect(gatewayStartMock).not.toHaveBeenCalled()
  })

  it('quarantines incompatible plugins and re-checks health when the initial probe reports plugin_load_failure', async () => {
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: 'Failed to load plugin bad-plugin',
        stderr: 'failed to load plugin bad-plugin',
        code: 1,
        stateCode: 'plugin_load_failure',
        summary: 'Plugin load failure',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway 已确认可用',
      })

    repairIncompatibleExtensionPluginsMock.mockResolvedValueOnce({
      ok: true,
      repaired: true,
      incompatiblePlugins: [
        {
          pluginId: 'bad-plugin',
          packageName: '@example/bad-plugin',
          installPath: '/tmp/bad-plugin',
          displayInstallPath: '/tmp/bad-plugin',
          reason: 'manifest invalid',
        },
      ],
      quarantinedPluginIds: ['bad-plugin'],
      prunedPluginIds: [],
      summary: '已隔离 bad-plugin',
      stderr: '',
    })

    const result = await ensureGatewayRunning()

    expect(repairIncompatibleExtensionPluginsMock).toHaveBeenCalledWith({
      quarantineOfficialManagedPlugins: true,
    })
    expect(repairIncompatibleExtensionPluginsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        restoreConfiguredManagedChannels: true,
      })
    )
    expect(gatewayHealthMock).toHaveBeenCalledTimes(2)
    expect(gatewayStartMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('quarantines incompatible plugins when websocket 1006 is backed by plugin failure log evidence', async () => {
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: 'Error: gateway closed (1006 abnormal closure (no close frame)): no close reason',
        code: 1,
        summary: 'Gateway handshake failed',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway 已确认可用',
      })

    detectGatewayPluginLoadFailureEvidenceMock.mockResolvedValueOnce({
      source: 'service',
      message: '网关日志显示扩展插件加载失败',
      detail:
        '[plugins] openai failed to load from C:/Users/test/.openclaw/extensions/openclaw-lark/index.js: TypeError: Cannot read properties of undefined (reading "add")',
    })

    repairIncompatibleExtensionPluginsMock.mockResolvedValueOnce({
      ok: true,
      repaired: true,
      incompatiblePlugins: [
        {
          pluginId: 'openclaw-lark',
          packageName: '@larksuite/openclaw-lark',
          installPath: '/tmp/openclaw-lark',
          displayInstallPath: '/tmp/openclaw-lark',
          reason: 'nested openclaw runtime mismatch',
        },
      ],
      quarantinedPluginIds: ['openclaw-lark'],
      prunedPluginIds: [],
      summary: '已隔离 openclaw-lark',
      stderr: '',
    })

    const result = await ensureGatewayRunning()

    expect(detectGatewayPluginLoadFailureEvidenceMock).toHaveBeenCalledTimes(1)
    expect(repairIncompatibleExtensionPluginsMock).toHaveBeenCalledWith({
      quarantineOfficialManagedPlugins: true,
    })
    expect(gatewayHealthMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.stateCode).toBe('healthy')
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'service',
          message: '网关日志显示扩展插件加载失败',
        }),
      ])
    )
  })

  it('rolls back to the pre-repair config snapshot when the official doctor fix fails at runtime', async () => {
    const preRepairConfig = {
      gateway: {
        mode: 'local',
      },
      defaultModel: 'openai/gpt-5',
    }
    readConfigMock.mockResolvedValue(preRepairConfig)
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: 'Config invalid',
        stderr: 'Problem: <root>: Unrecognized key: "defaultModel"\nRun "openclaw doctor --fix"',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
      .mockResolvedValueOnce({
        running: false,
        raw: 'Config invalid',
        stderr: 'repair failed',
        code: 1,
        stateCode: 'config_invalid',
        summary: 'Config invalid',
      })
    runDoctorMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Unknown config keys: defaultModel\nRun "openclaw doctor --fix" to remove these keys',
        stderr: '',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'repair failed',
        code: 1,
      })

    const result = await ensureGatewayRunning()

    expect(runDoctorMock).toHaveBeenNthCalledWith(1, undefined)
    expect(runDoctorMock).toHaveBeenNthCalledWith(2, { fix: true })
    expect(guardedWriteConfigMock).toHaveBeenCalledWith({
      config: preRepairConfig,
      reason: 'unknown',
    })
    expect(result.ok).toBe(false)
    expect(result.running).toBe(false)
    expect(result.summary).toContain('已回滚到修复前配置快照')
    expect(result.diagnostics?.doctor?.stderr).toContain('repair failed')
  })

  it('runs doctor and returns diagnostics when the gateway still is not healthy after the wait window', async () => {
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: false, raw: '', stderr: 'missing api key', code: 1 })
      .mockResolvedValueOnce({ running: false, raw: '', stderr: 'missing api key', code: 1 })

    runDoctorMock.mockResolvedValue({
      ok: false,
      stdout: 'doctor: provider auth missing',
      stderr: '',
      code: 1,
    })

    const progressStates: Array<{ phase?: string }> = []
    const result = await ensureGatewayRunning({
      onStateChange: (state) => progressStates.push(state),
    })

    expect(runDoctorMock).toHaveBeenCalledTimes(1)
    expect(progressStates.some((state) => state.phase === 'doctor-check')).toBe(true)
    expect(result.diagnostics?.lastHealth?.stderr).toContain('missing api key')
    expect(result.diagnostics?.doctor?.stdout).toContain('provider auth missing')
    expect(result.stateCode).toBe('auth_missing')
    expect(result.ok).toBe(false)
    expect(result.running).toBe(false)
    expect(result.stderr).toContain('官方诊断')
  })

  it('treats the gateway as ready when the extra post-doctor recheck becomes healthy', async () => {
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: false, raw: '', stderr: 'warming up', code: 1 })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })

    const result = await ensureGatewayRunning()

    expect(runDoctorMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('returns service_install_failed with attempted commands when gateway install fails', async () => {
    gatewayStartMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'Gateway service missing.',
      code: 1,
    })
    runCliMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'install failed: permission denied',
      code: 1,
    })

    const result = await ensureGatewayRunning()

    expect(result.ok).toBe(false)
    expect(result.stateCode).toBe('service_install_failed')
    expect(result.attemptedCommands).toEqual([
      ['gateway', 'start'],
      ['gateway', 'install'],
    ])
    expect(result.stderr).toContain('permission denied')
  })

  it('restarts the gateway once when readiness evidence shows token mismatch', async () => {
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: false, raw: '', stderr: 'gateway token mismatch', code: 1 })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })

    const result = await ensureGatewayRunning()

    expect(gatewayRestartMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.repairActionsTried).toContain('restart-gateway')
  })

  it('treats device-required websocket 1006 as a startup transition and waits a bit longer before repairing', async () => {
    let readinessPollCount = 0
    pollWithBackoffMock.mockImplementation(async ({ execute, isSuccess }) => {
      readinessPollCount += 1

      if (readinessPollCount === 1) {
        const value = await execute({ attempt: 1, elapsedMs: 0 })
        expect(value).toEqual(
          expect.objectContaining({
            running: false,
            stateCode: 'websocket_1006',
          })
        )
        return {
          ok: isSuccess(value, { attempt: 1, elapsedMs: 0 }),
          attempts: 1,
          elapsedMs: 0,
          value,
          aborted: false,
        }
      }

      const value = await execute({ attempt: 2, elapsedMs: 8_000 })
      expect(value).toEqual(
        expect.objectContaining({
          running: true,
          stateCode: 'healthy',
        })
      )
      return {
        ok: isSuccess(value, { attempt: 2, elapsedMs: 8_000 }),
        attempts: 2,
        elapsedMs: 8_000,
        value,
        aborted: false,
      }
    })

    gatewayStartMock.mockResolvedValue({
      ok: true,
      stdout: 'started',
      stderr: '',
      code: 0,
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: 'gateway closed (1006 abnormal closure (no close frame))',
        code: 1,
        stateCode: 'websocket_1006',
        summary: 'Gateway handshake failed',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway 已确认可用',
      })
    detectGatewayDeviceRequiredEvidenceMock.mockResolvedValueOnce({
      source: 'service',
      message: '网关日志显示本地设备身份仍在配对，握手尚未就绪',
      detail: 'cause=device-required',
    })

    const result = await ensureGatewayRunning()

    expect(detectGatewayDeviceRequiredEvidenceMock).toHaveBeenCalledTimes(1)
    expect(gatewayRestartMock).not.toHaveBeenCalled()
    expect(runDoctorMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: '网关日志显示本地设备身份仍在配对，握手尚未就绪',
        }),
      ])
    )
  })

  it('still falls back to restart repair when the device-required grace window does not recover', async () => {
    let readinessPollCount = 0
    pollWithBackoffMock.mockImplementation(async ({ execute, isSuccess }) => {
      readinessPollCount += 1

      if (readinessPollCount <= 2) {
        const value = await execute({ attempt: readinessPollCount, elapsedMs: readinessPollCount * 4_000 })
        expect(value).toEqual(
          expect.objectContaining({
            running: false,
            stateCode: 'websocket_1006',
          })
        )
        return {
          ok: isSuccess(value, { attempt: readinessPollCount, elapsedMs: readinessPollCount * 4_000 }),
          attempts: readinessPollCount,
          elapsedMs: readinessPollCount * 4_000,
          value,
          aborted: false,
        }
      }

      const value = await execute({ attempt: 3, elapsedMs: 12_000 })
      expect(value).toEqual(
        expect.objectContaining({
          running: true,
          stateCode: 'healthy',
        })
      )
      return {
        ok: isSuccess(value, { attempt: 3, elapsedMs: 12_000 }),
        attempts: 3,
        elapsedMs: 12_000,
        value,
        aborted: false,
      }
    })

    gatewayStartMock.mockResolvedValue({
      ok: true,
      stdout: 'started',
      stderr: '',
      code: 0,
    })
    gatewayRestartMock.mockResolvedValue({
      ok: true,
      stdout: 'restarted',
      stderr: '',
      code: 0,
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: 'gateway closed (1006 abnormal closure (no close frame))',
        code: 1,
        stateCode: 'websocket_1006',
        summary: 'Gateway handshake failed',
      })
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: 'gateway closed (1006 abnormal closure (no close frame))',
        code: 1,
        stateCode: 'websocket_1006',
        summary: 'Gateway handshake failed',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway 已确认可用',
      })
    detectGatewayDeviceRequiredEvidenceMock.mockResolvedValueOnce({
      source: 'service',
      message: '网关日志显示本地设备身份仍在配对，握手尚未就绪',
      detail: 'cause=device-required',
    })

    const result = await ensureGatewayRunning()

    expect(detectGatewayDeviceRequiredEvidenceMock).toHaveBeenCalledTimes(1)
    expect(gatewayRestartMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.repairActionsTried).toContain('restart-gateway')
  })

  it('auto-migrates the managed gateway port when a foreign process owns the default port', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        port: 18789,
      },
    })
    if (process.platform === 'win32') {
      gatewayStartMock.mockResolvedValue({
        ok: true,
        stdout: 'started on migrated port',
        stderr: '',
        code: 0,
      })
    } else {
      gatewayStartMock
        .mockResolvedValueOnce({
          ok: false,
          stdout: '',
          stderr: 'Port 18789 is already in use',
          code: 1,
        })
        .mockResolvedValueOnce({
          ok: true,
          stdout: 'started on migrated port',
          stderr: '',
          code: 0,
        })
    }
    probeGatewayPortOwnerMock.mockResolvedValue({
      kind: 'foreign',
      port: 18789,
      processName: 'python3',
      pid: 2451,
      command: 'python3 -m http.server',
      source: process.platform === 'win32' ? 'powershell' : 'lsof',
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })

    const result = await ensureGatewayRunning()

    expect(guardedWriteConfigMock).toHaveBeenCalledWith({
      config: {
        gateway: {
          port: 19876,
        },
      },
      reason: 'gateway-port-recovery',
    })
    expect(result.ok).toBe(true)
    expect(result.autoPortMigrated).toBe(true)
    expect(result.effectivePort).toBe(19876)
    expect(result.repairActionsTried).toContain('migrate-port')
  })

  itOnWindows('recovers a Windows port conflict before the first gateway start attempt', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
        port: 18789,
      },
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })
    probeGatewayPortOwnerMock.mockResolvedValue({
      kind: 'foreign',
      port: 18789,
      processName: 'python.exe',
      pid: 2451,
      command: 'python.exe -m http.server',
      source: 'powershell',
    })
    gatewayStartMock.mockResolvedValue({
      ok: true,
      stdout: 'started on migrated port',
      stderr: '',
      code: 0,
    })

    const result = await ensureGatewayRunning()

    expect(guardedWriteConfigMock).toHaveBeenCalledWith({
      config: {
        gateway: {
          mode: 'local',
          port: 19876,
        },
      },
      reason: 'gateway-port-recovery',
    })
    expect(gatewayStartMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.autoPortMigrated).toBe(true)
    expect(result.effectivePort).toBe(19876)
  })

  itOnWindows('authoritative snapshot attaches to the existing scheduled-task owner without starting a second owner', async () => {
    const homeDir = await createOpenClawHome()
    const launcherPath = join(homeDir, 'gateway.cmd')
    await fs.promises.writeFile(launcherPath, '@echo off\r\n')

    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
        port: 18789,
      },
    })
    readAuthoritativeWindowsChannelRuntimeSnapshotMock.mockReturnValue(
      createAuthoritativeWindowsChannelRuntimeSnapshot({
        homeDir,
        ownerKind: 'scheduled-task',
        ownerLauncherPath: launcherPath,
        ownerTaskName: '\\OpenClaw Gateway',
      })
    )
    runShellMock.mockResolvedValueOnce({
      ok: true,
      stdout: [
        'TaskName: \\OpenClaw Gateway',
        `Task To Run: ${launcherPath}`,
      ].join('\n'),
      stderr: '',
      code: 0,
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })

    const result = await ensureGatewayRunning()

    expect(gatewayStartMock).not.toHaveBeenCalled()
    expect(runCliMock).not.toHaveBeenCalledWith(['gateway', 'install', '--force'], undefined, 'gateway')
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  itOnWindows('removes a stale startup launcher when the scheduled-task owner is healthy', async () => {
    const homeDir = await createOpenClawHome()
    const launcherPath = join(homeDir, 'gateway.cmd')
    const startupEntryPath = join(
      homeDir,
      'AppData',
      'Roaming',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'OpenClaw Gateway.cmd'
    )
    await fs.promises.mkdir(join(homeDir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true })
    await fs.promises.writeFile(launcherPath, '@echo off\r\n')
    await fs.promises.writeFile(
      startupEntryPath,
      [
        '@echo off',
        'rem OpenClaw Gateway (v2026.4.12)',
        `start "" /min cmd.exe /d /c ${launcherPath}`,
      ].join('\r\n')
    )

    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
        port: 18789,
      },
    })
    readAuthoritativeWindowsChannelRuntimeSnapshotMock.mockReturnValue(
      createAuthoritativeWindowsChannelRuntimeSnapshot({
        homeDir,
        ownerKind: 'scheduled-task',
        ownerLauncherPath: launcherPath,
        ownerTaskName: '\\OpenClaw Gateway',
      })
    )
    runShellMock.mockResolvedValueOnce({
      ok: true,
      stdout: [
        'TaskName: \\OpenClaw Gateway',
        `Task To Run: ${launcherPath}`,
      ].join('\n'),
      stderr: '',
      code: 0,
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })

    const result = await ensureGatewayRunning()

    await expect(fs.promises.access(startupEntryPath)).rejects.toBeTruthy()
    expect(gatewayStartMock).not.toHaveBeenCalled()
    expect(runCliMock).not.toHaveBeenCalledWith(['gateway', 'install', '--force'], undefined, 'gateway')
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  itOnWindows('patches a healthy startup-folder launcher after successful ensure', async () => {
    const ensureHiddenSpy = vi.spyOn(windowsPlatformOps, 'ensureWindowsStartupLauncherHidden')
    const homeDir = await createOpenClawHome()
    const launcherPath = join(homeDir, 'gateway.cmd')
    const appDataDir = join(homeDir, 'AppData', 'Roaming')
    const previousAppData = process.env.APPDATA
    const startupEntryPath = join(
      appDataDir,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'OpenClaw Gateway.cmd'
    )
    process.env.APPDATA = appDataDir
    try {
      await fs.promises.mkdir(
        join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
        { recursive: true }
      )
      await fs.promises.writeFile(launcherPath, '@echo off\r\n')
      await fs.promises.writeFile(
        startupEntryPath,
        [
          '@echo off',
          'rem OpenClaw Gateway (v2026.4.12)',
          `start "" /min cmd.exe /d /c ${launcherPath}`,
        ].join('\r\n')
      )

      readConfigMock.mockResolvedValue({
        gateway: {
          mode: 'local',
          port: 18789,
        },
      })
      readAuthoritativeWindowsChannelRuntimeSnapshotMock.mockReturnValue(
        createAuthoritativeWindowsChannelRuntimeSnapshot({
          homeDir,
          ownerKind: 'startup-folder',
          ownerLauncherPath: launcherPath,
          ownerTaskName: '',
        })
      )
      runShellMock.mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'ERROR: The system cannot find the path specified.',
        code: 1,
      })
      gatewayHealthMock
        .mockResolvedValueOnce({ running: false, raw: '', stderr: '', code: 1 })
        .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })

      const result = await ensureGatewayRunning()
      const startupContent = await fs.promises.readFile(startupEntryPath, 'utf8')

      expect(ensureHiddenSpy).toHaveBeenCalled()
      expect(ensureHiddenSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          appDataDir,
          homeDir,
          launcherIntegrity: expect.objectContaining({
            launcherPath,
          }),
        })
      )
      expect(startupContent).toContain('WindowStyle Hidden')
      expect(startupContent).toContain(`rem QClaw startup launcher target: ${launcherPath}`)
      expect(gatewayStartMock).not.toHaveBeenCalled()
      expect(runCliMock).not.toHaveBeenCalledWith(['gateway', 'install', '--force'], undefined, 'gateway')
      expect(result.ok).toBe(true)
      expect(result.running).toBe(true)
    } finally {
      if (previousAppData === undefined) {
        delete process.env.APPDATA
      } else {
        process.env.APPDATA = previousAppData
      }
    }
  })

  itOnWindows('authoritative snapshot marks a stale launcher for reinstall before startup', async () => {
    const homeDir = await createOpenClawHome()
    const missingLauncherPath = join(homeDir, 'missing-gateway.cmd')

    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
        port: 18789,
      },
    })
    readAuthoritativeWindowsChannelRuntimeSnapshotMock.mockReturnValue(
      createAuthoritativeWindowsChannelRuntimeSnapshot({
        homeDir,
        ownerKind: 'scheduled-task',
        ownerLauncherPath: missingLauncherPath,
        ownerTaskName: '\\OpenClaw Gateway',
      })
    )
    runShellMock.mockResolvedValueOnce({
      ok: true,
      stdout: [
        'TaskName: \\OpenClaw Gateway',
        `Task To Run: ${missingLauncherPath}`,
      ].join('\n'),
      stderr: '',
      code: 0,
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })
    gatewayStartMock.mockResolvedValueOnce({
      ok: true,
      stdout: 'started after authoritative reinstall',
      stderr: '',
      code: 0,
    })

    const result = await ensureGatewayRunning()

    expect(runCliMock).toHaveBeenCalledWith(['gateway', 'install', '--force'], undefined, 'gateway')
    expect(gatewayStartMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.autoInstalledGatewayService).toBe(true)
  })

  itOnWindows('reinstalls the gateway service before the first start when the scheduled task launcher is missing', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
        port: 18789,
      },
    })
    runShellMock.mockResolvedValueOnce({
      ok: true,
      stdout: [
        'Folder: \\',
        'TaskName: \\OpenClaw Gateway',
        'Task To Run: C:\\missing\\gateway.cmd',
      ].join('\n'),
      stderr: '',
      code: 0,
    })
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}', stderr: '', code: 0 })
    gatewayStartMock.mockResolvedValueOnce({
      ok: true,
      stdout: 'started after launcher repair',
      stderr: '',
      code: 0,
    })

    const result = await ensureGatewayRunning()

    expect(runCliMock).toHaveBeenCalledWith(['gateway', 'install', '--force'], undefined, 'gateway')
    expect(gatewayStopMock).toHaveBeenCalledTimes(1)
    expect(gatewayStartMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
    expect(result.autoInstalledGatewayService).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['gateway', 'install', '--force'],
      ['gateway', 'start'],
    ])
  })

  itOnWindows('repairs missing gateway.mode via explicit config-path read without runtime-path ensure', async () => {
    readConfigMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        auth: {
          profiles: {
            'zai:default': {
              provider: 'zai',
            },
          },
        },
        models: {
          providers: {
            zai: {
              api: 'openai-completions',
            },
          },
        },
      })
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: false,
        raw: '',
        stderr: 'not running',
        code: 1,
        stateCode: 'gateway_not_running',
        summary: 'gateway not running',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'gateway ready',
      })

    const result = await ensureGatewayRunning({ skipRuntimePrecheck: true })

    expect(readConfigMock).toHaveBeenNthCalledWith(1)
    expect(readConfigMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        configPath: expect.stringContaining('.openclaw'),
      })
    )
    expect(getOpenClawPathsMock).not.toHaveBeenCalled()
    expect(applyConfigPatchGuardedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeConfig: expect.objectContaining({
          auth: expect.any(Object),
          models: expect.any(Object),
        }),
        afterConfig: expect.objectContaining({
          auth: expect.any(Object),
          models: expect.any(Object),
          gateway: expect.objectContaining({
            mode: 'local',
          }),
        }),
      }),
      undefined,
      { applyGatewayPolicy: false }
    )
    expect(result.ok).toBe(true)
    expect(result.running).toBe(true)
  })

  it('reuses in-flight ensure and fan-outs progress updates to late subscribers', async () => {
    const deferredConfig = createDeferred<Record<string, any> | null>()
    readConfigMock.mockImplementationOnce(() => deferredConfig.promise)
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const firstStates: string[] = []
    const secondStates: string[] = []

    const first = ensureGatewayRunning({
      onStateChange: (state) => firstStates.push(state.phase),
    })
    await Promise.resolve()
    const second = ensureGatewayRunning({
      onStateChange: (state) => secondStates.push(state.phase),
    })

    deferredConfig.resolve(null)
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(true)
    expect(checkNodeMock).toHaveBeenCalledTimes(1)
    expect(gatewayStartMock).toHaveBeenCalledTimes(1)
    expect(firstStates.length).toBeGreaterThan(0)
    expect(secondStates.length).toBeGreaterThan(0)
    expect(secondStates).toContain('runtime-check')
  })

  it('does not downgrade strict ensure callers when a skip-runtime ensure is in flight', async () => {
    const deferredConfig = createDeferred<Record<string, any> | null>()
    readConfigMock
      .mockImplementationOnce(() => deferredConfig.promise)
      .mockResolvedValueOnce(null)
    gatewayHealthMock
      .mockResolvedValueOnce({ running: false, raw: '' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })
      .mockResolvedValueOnce({ running: true, raw: '{"ok":true}' })

    const skipPromise = ensureGatewayRunning({ skipRuntimePrecheck: true })
    await Promise.resolve()
    const strictPromise = ensureGatewayRunning()

    await Promise.resolve()
    expect(checkNodeMock).toHaveBeenCalledTimes(0)

    deferredConfig.resolve(null)
    const [skipResult, strictResult] = await Promise.all([skipPromise, strictPromise])

    expect(skipResult.ok).toBe(true)
    expect(strictResult.ok).toBe(true)
    expect(checkNodeMock).toHaveBeenCalledTimes(1)
    expect(gatewayStartMock).toHaveBeenCalledTimes(1)
  })
})

describe('classifyServiceInstallFailure', () => {
  it('detects English "Access is denied"', () => {
    expect(
      classifyServiceInstallFailure({
        ok: false,
        stdout: '',
        stderr: 'Gateway install failed: Error: schtasks create failed: Access is denied.',
        code: 1,
      })
    ).toBe('access-denied')
  })

  it('detects English "Access Denied" variant', () => {
    expect(
      classifyServiceInstallFailure({
        ok: false,
        stdout: '',
        stderr: 'schtasks: ERROR: Access Denied',
        code: 1,
      })
    ).toBe('access-denied')
  })

  it('detects Chinese "拒绝访问" error message', () => {
    expect(
      classifyServiceInstallFailure({
        ok: false,
        stdout: '',
        stderr: 'Gateway install failed: Error: schtasks create failed: 错误: 拒绝访问。',
        code: 1,
      })
    ).toBe('access-denied')
  })

  it('detects GBK garbled output via schtasks create failed + exit code 1', () => {
    expect(
      classifyServiceInstallFailure({
        ok: false,
        stdout: '',
        stderr: 'Gateway install failed: Error: schtasks create failed: \ufffd\ufffd: \u00dc\u00be\ufffd\ufffd\u00ca\u00a1\ufffd',
        code: 1,
      })
    ).toBe('access-denied')
  })

  it('returns "other" for non-permission errors', () => {
    expect(
      classifyServiceInstallFailure({
        ok: false,
        stdout: '',
        stderr: 'Gateway install failed: Error: task name already exists',
        code: 1,
      })
    ).toBe('other')
  })

  it('returns "other" for null/undefined result', () => {
    expect(classifyServiceInstallFailure(null)).toBe('other')
    expect(classifyServiceInstallFailure(undefined)).toBe('other')
  })

  it('returns "other" for empty output', () => {
    expect(
      classifyServiceInstallFailure({ ok: false, stdout: '', stderr: '', code: 1 })
    ).toBe('other')
  })

  it('detects access-denied in stdout when stderr is empty', () => {
    expect(
      classifyServiceInstallFailure({
        ok: false,
        stdout: 'Error: Access is denied',
        stderr: '',
        code: 1,
      })
    ).toBe('access-denied')
  })
})
