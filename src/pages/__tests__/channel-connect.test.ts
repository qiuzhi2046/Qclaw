import { describe, expect, it, vi } from 'vitest'
import * as ChannelConnectModule from '../ChannelConnect'
import {
  buildManagedPluginScopedRepairOptions,
  buildDingtalkOfficialSetupLog,
  buildChannelConnectCompletionCopy,
  canFinalizeWeixinSetup,
  canPrepareFeishuManualBindingWithoutInstall,
  canFinishFeishuCreateMode,
  captureFeishuBotConfigSnapshot,
  ensureGatewayReadyForChannelConnect,
  hasRecoveredFeishuCreateMode,
  hasFeishuManualCredentialInput,
  isFeishuManualBindingReady,
  mergeFeishuCreateModeBots,
  resolveChannelConnectBindingStrategy,
  resolveFeishuAutoRecoveryTarget,
  resolveFeishuManualBindingPreparationCopy,
  resolveFeishuPairingTarget,
  resolveFeishuCreateModeFinishStrategy,
  isSafeAlreadyInstalledManagedPluginInstallError,
  resolveManagedPluginInstallPreflight,
  resolveManagedPluginInstallStrategy,
  retryPluginInstallWithOfficialConfigRepair,
  restoreCapturedFeishuBotConfig,
  shouldAttemptOfficialConfigRepairForPluginInstall,
  shouldValidateFeishuManualCredentials,
} from '../ChannelConnect'
import { getChannelDefinition, listChannelDefinitions, applyChannelConfig } from '../../lib/openclaw-channel-registry'

describe('shouldShowChannelConnectSkipButton', () => {
  it('stays hidden by default when the channel has not earned skip availability yet', () => {
    expect(
      ChannelConnectModule.shouldShowChannelConnectSkipButton?.({
        canSkip: false,
        forceShowSkip: false,
      })
    ).toBe(false)
  })

  it('lets the setup wizard force the skip button visible without changing dashboard defaults', () => {
    expect(
      ChannelConnectModule.shouldShowChannelConnectSkipButton?.({
        canSkip: false,
        forceShowSkip: true,
      })
    ).toBe(true)
  })
})

describe('ensureGatewayReadyForChannelConnect', () => {
  it('uses the channel-change reload entry instead of a plain ensure-only success path', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: false,
      effectivePort: 18789,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
      attemptedCommands: [['gateway', 'start']],
      evidence: [],
      repairActionsTried: ['start-gateway'],
      repairOutcome: 'recovered',
      safeToRetry: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    const appendLog = vi.fn()

    const result = await ensureGatewayReadyForChannelConnect(
      { reloadGatewayAfterChannelChange } as Pick<typeof window.api, 'reloadGatewayAfterChannelChange'>,
      appendLog
    )

    expect(result).toEqual({ ok: true })
    expect(reloadGatewayAfterChannelChange).toHaveBeenCalledTimes(1)
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('surfaces auto port migration in the channel connect log', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: true,
      effectivePort: 19876,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
      attemptedCommands: [['gateway', 'start']],
      evidence: [],
      repairActionsTried: ['migrate-port'],
      repairOutcome: 'recovered',
      safeToRetry: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    const appendLog = vi.fn()

    const result = await ensureGatewayReadyForChannelConnect(
      { reloadGatewayAfterChannelChange } as Pick<typeof window.api, 'reloadGatewayAfterChannelChange'>,
      appendLog
    )

    expect(result.ok).toBe(true)
    expect(appendLog).toHaveBeenCalledWith(
      '⚠️ Gateway 端口已自动切换到 19876，程序会继续使用新端口。\n\n'
    )
  })

  it('requires running confirmation instead of treating a plain reload ok as ready', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: true,
      stdout: 'Gateway restarted',
      stderr: '',
      code: 0,
    })

    const appendLog = vi.fn()
    const result = await ensureGatewayReadyForChannelConnect(
      { reloadGatewayAfterChannelChange } as Pick<typeof window.api, 'reloadGatewayAfterChannelChange'>,
      appendLog
    )

    expect(result).toEqual({ ok: false, message: 'Gateway 启动失败' })
    expect(reloadGatewayAfterChannelChange).toHaveBeenCalledTimes(1)
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('repairs a managed-channel plugin load failure and then re-confirms Gateway readiness before succeeding', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      stateCode: 'plugin_load_failure',
      summary: 'Gateway 依赖的插件没有正常加载',
      stdout: '',
      stderr: 'failed to load plugin',
      code: 1,
    })
    const repairManagedChannelPlugin = vi.fn().mockResolvedValue({
      kind: 'ok',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: {
        channelId: 'wecom',
        pluginId: 'wecom-openclaw-plugin',
        summary: '企微官方插件已修复。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: false,
      effectivePort: 18789,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
      attemptedCommands: [],
      evidence: [],
      repairActionsTried: ['repair-bad-plugin'],
      repairOutcome: 'recovered',
      safeToRetry: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    const getManagedChannelPluginStatus = vi.fn().mockResolvedValue({
      channelId: 'wecom',
      pluginId: 'wecom-openclaw-plugin',
      summary: '企微官方插件已安装并已注册；loaded / ready 仍待上游证据。',
      stages: [
        { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
        { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
        { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
        { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
      ],
      evidence: [],
    })

    const appendLog = vi.fn()
    const result = await ensureGatewayReadyForChannelConnect(
      {
        reloadGatewayAfterChannelChange,
        repairManagedChannelPlugin,
        ensureGatewayRunning,
        getManagedChannelPluginStatus,
      } as any,
      appendLog,
      { channelId: 'wecom' }
    )

    expect(result).toEqual({ ok: true })
    expect(repairManagedChannelPlugin).toHaveBeenCalledWith('wecom')
    expect(ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(getManagedChannelPluginStatus).toHaveBeenCalledWith('wecom')
  })

  it('fails after targeted repair when Gateway still does not come back up', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      stateCode: 'config_invalid',
      summary: 'Gateway 配置不完整或格式无效',
      stdout: '',
      stderr: 'unknown channel id',
      code: 1,
    })
    const repairManagedChannelPlugin = vi.fn().mockResolvedValue({
      kind: 'ok',
      channelId: 'dingtalk',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: {
        channelId: 'dingtalk',
        pluginId: 'dingtalk-connector',
        summary: '钉钉官方插件已修复。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: false,
      effectivePort: 18789,
      stateCode: 'plugin_load_failure',
      summary: 'Gateway 依赖的插件没有正常加载',
      attemptedCommands: [],
      evidence: [],
      repairActionsTried: ['repair-bad-plugin'],
      repairOutcome: 'failed',
      safeToRetry: false,
      stdout: '',
      stderr: 'failed to load plugin bad-plugin',
      code: 1,
    })
    const getManagedChannelPluginStatus = vi.fn()

    const appendLog = vi.fn()
    const result = await ensureGatewayReadyForChannelConnect(
      {
        reloadGatewayAfterChannelChange,
        repairManagedChannelPlugin,
        ensureGatewayRunning,
        getManagedChannelPluginStatus,
      } as any,
      appendLog,
      { channelId: 'dingtalk' }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Gateway 依赖的插件没有正常加载')
    expect(repairManagedChannelPlugin).toHaveBeenCalledWith('dingtalk')
    expect(ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(getManagedChannelPluginStatus).not.toHaveBeenCalled()
  })

  it('fails recovery when the managed plugin is only installed on disk but still not registered', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      stateCode: 'plugin_load_failure',
      summary: 'Gateway 依赖的插件没有正常加载',
      stdout: '',
      stderr: 'failed to load plugin',
      code: 1,
    })
    const repairManagedChannelPlugin = vi.fn().mockResolvedValue({
      kind: 'ok',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: {
        channelId: 'wecom',
        pluginId: 'wecom-openclaw-plugin',
        summary: '企微官方插件已修复。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: false,
      effectivePort: 18789,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
      attemptedCommands: [],
      evidence: [],
      repairActionsTried: ['repair-bad-plugin'],
      repairOutcome: 'recovered',
      safeToRetry: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    const getManagedChannelPluginStatus = vi.fn().mockResolvedValue({
      channelId: 'wecom',
      pluginId: 'wecom-openclaw-plugin',
      summary: '企微官方插件已落盘，但仍未重新注册。',
      stages: [
        { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
        { id: 'registered', state: 'missing', source: 'plugins-list', message: 'missing' },
        { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
        { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
      ],
      evidence: [],
    })

    const appendLog = vi.fn()
    const result = await ensureGatewayReadyForChannelConnect(
      {
        reloadGatewayAfterChannelChange,
        repairManagedChannelPlugin,
        ensureGatewayRunning,
        getManagedChannelPluginStatus,
      } as any,
      appendLog,
      { channelId: 'wecom' }
    )

    expect(result).toEqual({ ok: false, message: '企微官方插件已落盘，但仍未重新注册。' })
    expect(repairManagedChannelPlugin).toHaveBeenCalledWith('wecom')
    expect(ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(getManagedChannelPluginStatus).toHaveBeenCalledWith('wecom')
  })

  it('keeps non-repairable reload failures on the current direct error path', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      stateCode: 'auth_missing',
      summary: '当前机器缺少可用的模型认证信息',
      stdout: '',
      stderr: 'auth missing',
      code: 1,
    })
    const repairManagedChannelPlugin = vi.fn()
    const ensureGatewayRunning = vi.fn()
    const getManagedChannelPluginStatus = vi.fn()

    const appendLog = vi.fn()
    const result = await ensureGatewayReadyForChannelConnect(
      {
        reloadGatewayAfterChannelChange,
        repairManagedChannelPlugin,
        ensureGatewayRunning,
        getManagedChannelPluginStatus,
      } as any,
      appendLog,
      { channelId: 'wecom' }
    )

    expect(result).toEqual({ ok: false, message: '当前机器缺少可用的模型认证信息' })
    expect(repairManagedChannelPlugin).not.toHaveBeenCalled()
    expect(ensureGatewayRunning).not.toHaveBeenCalled()
    expect(getManagedChannelPluginStatus).not.toHaveBeenCalled()
  })

  it('skips targeted managed repair for personal weixin and falls through to strict ensure recovery', async () => {
    const reloadGatewayAfterChannelChange = vi.fn().mockResolvedValue({
      ok: false,
      running: false,
      stateCode: 'plugin_load_failure',
      summary: 'Gateway 依赖的插件没有正常加载',
      stdout: '',
      stderr: 'failed to load plugin',
      code: 1,
    })
    const repairManagedChannelPlugin = vi.fn().mockResolvedValue({
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
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: false,
      effectivePort: 18789,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
      attemptedCommands: [],
      evidence: [],
      repairActionsTried: ['repair-bad-plugin'],
      repairOutcome: 'recovered',
      safeToRetry: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    const getManagedChannelPluginStatus = vi.fn().mockResolvedValue({
      channelId: 'openclaw-weixin',
      pluginId: 'openclaw-weixin',
      summary: '微信插件已安装并已注册；loaded / ready 仍待上游证据。',
      stages: [
        { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
        { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
        { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
        { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
      ],
      evidence: [],
    })

    const appendLog = vi.fn()
    const result = await ensureGatewayReadyForChannelConnect(
      {
        reloadGatewayAfterChannelChange,
        repairManagedChannelPlugin,
        ensureGatewayRunning,
        getManagedChannelPluginStatus,
      } as any,
      appendLog,
      { channelId: 'openclaw-weixin' }
    )

    expect(result).toEqual({ ok: true })
    expect(repairManagedChannelPlugin).not.toHaveBeenCalled()
    expect(ensureGatewayRunning).toHaveBeenCalledWith({ skipRuntimePrecheck: true })
    expect(getManagedChannelPluginStatus).toHaveBeenCalledWith('openclaw-weixin')
  })
})

describe('QQ channel connect flow', () => {
  it('routes qqbot through direct config writes instead of openclaw channels add', () => {
    expect(resolveChannelConnectBindingStrategy(getChannelDefinition('qqbot'))).toBe('config-write')
  })

  it('reinstalls managed plugins when only openclaw.json records remain but the plugin is missing on disk', () => {
    expect(
      resolveManagedPluginInstallStrategy({
        pluginConfigured: true,
        pluginInstalledOnDisk: false,
        forceInstall: false,
      })
    ).toBe('install-plugin')

    expect(
      resolveManagedPluginInstallStrategy({
        pluginConfigured: false,
        pluginInstalledOnDisk: true,
        forceInstall: false,
      })
    ).toBe('reuse-installed-plugin')
  })

  it('forces reinstall when preflight already quarantined the selected managed plugin scope', () => {
    expect(
      resolveManagedPluginInstallStrategy({
        pluginConfigured: false,
        pluginInstalledOnDisk: true,
        forceInstall: true,
      })
    ).toBe('install-plugin')
  })

  it('builds scoped repair options from the canonical plugin id and cleanup aliases', () => {
    expect(buildManagedPluginScopedRepairOptions(getChannelDefinition('qqbot'))).toEqual({
      scopePluginIds: [
        'openclaw-qqbot',
        'qqbot',
        'openclaw-qq',
        '@sliverp/qqbot',
        '@tencent-connect/qqbot',
        '@tencent-connect/openclaw-qq',
        '@tencent-connect/openclaw-qqbot',
      ],
      quarantineOfficialManagedPlugins: true,
    })
  })

  it('forces reinstall after scoped preflight quarantines a legacy managed plugin alias', async () => {
    const prepareManagedChannelPluginForSetup = vi.fn().mockResolvedValue({
      kind: 'ok',
      channelId: 'qqbot',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'install-before-setup',
      status: {
        channelId: 'qqbot',
        pluginId: 'openclaw-qqbot',
        summary: 'QQ 官方插件当前需要重新安装。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'missing', source: 'plugins-list', message: 'missing' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })

    const result = await resolveManagedPluginInstallPreflight(
      {
        prepareManagedChannelPluginForSetup,
      } as Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>,
      {
        channel: getChannelDefinition('qqbot'),
        pluginConfigured: false,
      }
    )

    expect(prepareManagedChannelPluginForSetup).toHaveBeenCalledWith('qqbot')
    expect(result.pluginInstallStrategy).toBe('install-plugin')
    expect(result.pluginInstalledOnDisk).toBe(true)
  })

  it('reuses a managed plugin only when scoped preflight leaves a compatible install on disk', async () => {
    const prepareManagedChannelPluginForSetup = vi.fn().mockResolvedValue({
      kind: 'ok',
      channelId: 'qqbot',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'reuse-installed',
      status: {
        channelId: 'qqbot',
        pluginId: 'openclaw-qqbot',
        summary: 'QQ 官方插件已安装。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })

    const result = await resolveManagedPluginInstallPreflight(
      {
        prepareManagedChannelPluginForSetup,
      } as Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>,
      {
        channel: getChannelDefinition('qqbot'),
        pluginConfigured: false,
      }
    )

    expect(prepareManagedChannelPluginForSetup).toHaveBeenCalledWith('qqbot')
    expect(result.pluginInstallStrategy).toBe('reuse-installed-plugin')
    expect(result.pluginInstalledOnDisk).toBe(true)
  })

  it('reuses an installed managed plugin after setup preflight already repaired config drift', async () => {
    const prepareManagedChannelPluginForSetup = vi.fn().mockResolvedValue({
      kind: 'ok',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'repair-before-setup',
      status: {
        channelId: 'wecom',
        pluginId: 'wecom-openclaw-plugin',
        summary: '企微官方插件配置已同步。',
        stages: [
          { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
          { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })

    const result = await resolveManagedPluginInstallPreflight(
      {
        prepareManagedChannelPluginForSetup,
      } as Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>,
      {
        channel: getChannelDefinition('wecom'),
        pluginConfigured: false,
      }
    )

    expect(prepareManagedChannelPluginForSetup).toHaveBeenCalledWith('wecom')
    expect(result.pluginInstallStrategy).toBe('reuse-installed-plugin')
    expect(result.pluginInstalledOnDisk).toBe(true)
  })

  it('keeps personal weixin setup on the interactive installer path after managed preflight', async () => {
    const prepareManagedChannelPluginForSetup = vi.fn().mockResolvedValue({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能在后台自动安装。',
      status: {
        channelId: 'openclaw-weixin',
        pluginId: 'openclaw-weixin',
        summary: '微信插件仍待交互式安装器完成安装。',
        stages: [
          { id: 'installed', state: 'missing', source: 'disk', message: 'missing' },
          { id: 'registered', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
          { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
        ],
        evidence: [],
      },
    })

    const result = await resolveManagedPluginInstallPreflight(
      {
        prepareManagedChannelPluginForSetup,
      } as Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>,
      {
        channel: getChannelDefinition('openclaw-weixin'),
        pluginConfigured: false,
      }
    )

    expect(result.pluginInstallStrategy).toBe('install-plugin')
    expect(result.pluginInstalledOnDisk).toBe(false)
  })

  it('skips managed plugin preflight entirely for direct-config channels like LINE', async () => {
    const prepareManagedChannelPluginForSetup = vi.fn()

    const result = await resolveManagedPluginInstallPreflight(
      {
        prepareManagedChannelPluginForSetup,
      } as Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>,
      {
        channel: getChannelDefinition('line'),
        pluginConfigured: false,
      }
    )

    expect(prepareManagedChannelPluginForSetup).not.toHaveBeenCalled()
    expect(result).toEqual({
      pluginInstalledOnDisk: false,
      pluginInstallStrategy: 'install-plugin',
      prepareResult: null,
    })
  })

  it('skips managed plugin preflight entirely for bundled direct-config channels like Telegram and Slack', async () => {
    const prepareManagedChannelPluginForSetup = vi.fn()

    const telegramResult = await resolveManagedPluginInstallPreflight(
      {
        prepareManagedChannelPluginForSetup,
      } as Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>,
      {
        channel: getChannelDefinition('telegram'),
        pluginConfigured: false,
      }
    )

    const slackResult = await resolveManagedPluginInstallPreflight(
      {
        prepareManagedChannelPluginForSetup,
      } as Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>,
      {
        channel: getChannelDefinition('slack'),
        pluginConfigured: false,
      }
    )

    expect(prepareManagedChannelPluginForSetup).not.toHaveBeenCalled()
    expect(telegramResult.prepareResult).toBeNull()
    expect(slackResult.prepareResult).toBeNull()
  })

  it('treats plain already-exists plugin errors as safe reuse but not when safety repair also failed', () => {
    expect(isSafeAlreadyInstalledManagedPluginInstallError('plugin already exists')).toBe(true)
    expect(isSafeAlreadyInstalledManagedPluginInstallError('plugin already exists\n已自动隔离')).toBe(false)
    expect(isSafeAlreadyInstalledManagedPluginInstallError('plugin already exists\n安全修复失败')).toBe(false)
  })

  it('detects config-invalid plugin install failures that should trigger one official doctor repair', () => {
    expect(
      shouldAttemptOfficialConfigRepairForPluginInstall({
        ok: false,
        stdout: 'Config invalid',
        stderr: [
          'Invalid config at ~/.openclaw/openclaw.json',
          '  - channels.openclaw-weixin: unknown channel id: openclaw-weixin',
          'Run: openclaw doctor --fix',
        ].join('\n'),
      })
    ).toBe(true)

    expect(
      shouldAttemptOfficialConfigRepairForPluginInstall({
        ok: false,
        stderr: 'fetch failed',
      })
    ).toBe(false)
  })

  it('runs one official doctor repair and retries plugin install when stale channel config blocks the first attempt', async () => {
    const install = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Config invalid',
        stderr: [
          'Invalid config at ~/.openclaw/openclaw.json:',
          '- channels.openclaw-weixin: unknown channel id: openclaw-weixin',
          'Run: openclaw doctor --fix',
        ].join('\n'),
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'installed',
        stderr: '',
        code: 0,
      })
    const runDoctor = vi.fn().mockResolvedValue({
      ok: true,
      stdout: 'fixed',
      stderr: '',
      code: 0,
    })
    const appendLog = vi.fn()

    const result = await retryPluginInstallWithOfficialConfigRepair(
      { runDoctor } as Pick<typeof window.api, 'runDoctor'>,
      install,
      appendLog
    )

    expect(runDoctor).toHaveBeenCalledWith({ fix: true, nonInteractive: true })
    expect(install).toHaveBeenCalledTimes(2)
    expect(result.officialRepairApplied).toBe(true)
    expect(result.result.ok).toBe(true)
    expect(appendLog).toHaveBeenCalledWith('⚠️ 检测到 OpenClaw 配置与当前版本不兼容，正在执行官方修复...\n')
    expect(appendLog).toHaveBeenCalledWith('✅ 官方配置修复完成，正在重试插件安装...\n\n')
  })
})

describe('buildChannelConnectCompletionCopy', () => {
  it('keeps DingTalk completion in an evidence-backed unknown state until upstream readiness exists', () => {
    expect(
      buildChannelConnectCompletionCopy({
        id: 'dingtalk',
        name: '钉钉',
        skipPairing: true,
      })
    ).toContain('unknown / 未证实')
  })

  it('keeps pairing channels on the existing next-step copy', () => {
    expect(
      buildChannelConnectCompletionCopy({
        id: 'feishu',
        name: '飞书',
        skipPairing: false,
      })
    ).toContain('获取配对码')
  })

  it('keeps LINE on the pairing completion copy instead of marking it ready immediately', () => {
    expect(
      buildChannelConnectCompletionCopy({
        id: 'line',
        name: 'LINE',
        skipPairing: false,
      })
    ).toContain('获取配对码')
  })

  it('keeps Telegram on the pairing completion copy instead of marking it ready immediately', () => {
    expect(
      buildChannelConnectCompletionCopy({
        id: 'telegram',
        name: 'Telegram',
        skipPairing: false,
      })
    ).toContain('获取配对码')
  })

  it('keeps Slack on the pairing completion copy instead of marking it ready immediately', () => {
    expect(
      buildChannelConnectCompletionCopy({
        id: 'slack',
        name: 'Slack',
        skipPairing: false,
      })
    ).toContain('获取配对码')
  })
})

describe('buildDingtalkOfficialSetupLog', () => {
  it('renders evidence-backed bridge steps without inventing loaded or ready state', () => {
    const log = buildDingtalkOfficialSetupLog({
      ok: true,
      channelId: 'dingtalk',
      pluginId: 'dingtalk-connector',
      summary: '钉钉官方插件配置已完成；loaded / ready 仍待上游证据。',
      installedThisRun: true,
      changedPaths: ['$.channels.dingtalk-connector'],
      applySummary: '已写入配置',
      gatewayResult: {
        ok: true,
        running: true,
        requestedAction: 'reload-after-setup',
        summary: 'Gateway 已确认可用',
        stateCode: 'healthy',
      },
      evidence: [
        {
          source: 'doctor',
          message: '已完成钉钉官方预检修复',
        },
        {
          source: 'config',
          message: '已写入钉钉最小配置补丁',
          jsonPaths: ['$.channels.dingtalk-connector'],
        },
      ],
      probeResult: null,
      stdout: '',
      stderr: '',
      code: 0,
      message: '钉钉官方插件配置已完成，ready 仍待上游证据',
    })

    expect(log).toContain('已完成钉钉官方预检修复')
    expect(log).toContain('变更路径：$.channels.dingtalk-connector')
    expect(log).not.toContain('loaded / ready')
  })
})

describe('Feishu config preservation during onboard', () => {
  it('captures configured Feishu bot state before onboard rewrites the config', () => {
    const config = {
      channels: {
        feishu: {
          appId: 'cli_service',
          appSecret: 'secret',
          domain: 'feishu',
          allowFrom: ['ou_owner'],
          accounts: {
            support: {
              appId: 'cli_support',
              appSecret: 'support-secret',
            },
          },
        },
      },
    }

    const snapshot = captureFeishuBotConfigSnapshot(config)

    expect(snapshot).toEqual(config.channels.feishu)
    expect(snapshot).not.toBe(config.channels.feishu)
  })

  it('restores the captured Feishu config after onboard rewrites openclaw.json', () => {
    const preservedFeishuConfig = {
      appId: 'cli_service',
      appSecret: 'secret',
      domain: 'feishu',
      allowFrom: ['ou_owner'],
    }
    const onboardConfig = {
      providers: {
        openai: {
          apiKey: 'sk-test',
        },
      },
      gateway: {
        mode: 'local',
      },
      channels: {},
    }

    const restored = restoreCapturedFeishuBotConfig(onboardConfig, preservedFeishuConfig)

    expect(restored).toEqual({
      providers: {
        openai: {
          apiKey: 'sk-test',
        },
      },
      gateway: {
        mode: 'local',
      },
      channels: {
        feishu: preservedFeishuConfig,
      },
    })
  })

  it('ignores empty Feishu placeholders that do not contain any configured bots', () => {
    const snapshot = captureFeishuBotConfigSnapshot({
      channels: {
        feishu: {
          enabled: true,
          appId: '',
          appSecret: '',
        },
      },
    })

    expect(snapshot).toBeNull()
  })
})

describe('canFinishFeishuCreateMode', () => {
  it('allows finish when either installer-created bot config exists or manual credentials are ready', () => {
    expect(canFinishFeishuCreateMode(false, false)).toBe(false)
    expect(canFinishFeishuCreateMode(true, false)).toBe(true)
    expect(canFinishFeishuCreateMode(false, true)).toBe(true)
  })
})

describe('canFinalizeWeixinSetup', () => {
  it('allows existing configured accounts even when this run did not create a new account id', () => {
    expect(
      canFinalizeWeixinSetup({
        configuredAccounts: [
          { configured: false },
          { configured: true },
        ],
      })
    ).toBe(true)
  })

  it('still blocks completion when no configured personal WeChat account exists', () => {
    expect(
      canFinalizeWeixinSetup({
        configuredAccounts: [
          { configured: false },
        ],
      })
    ).toBe(false)
  })
})

describe('hasFeishuManualCredentialInput', () => {
  it('detects when the user has started typing manual credentials', () => {
    expect(hasFeishuManualCredentialInput({})).toBe(false)
    expect(hasFeishuManualCredentialInput({ appId: '   ', appSecret: '' })).toBe(false)
    expect(hasFeishuManualCredentialInput({ appId: 'cli_test', appSecret: '' })).toBe(true)
    expect(hasFeishuManualCredentialInput({ appId: '', appSecret: 'secret' })).toBe(true)
  })
})

describe('resolveFeishuCreateModeFinishStrategy', () => {
  it('prefers manual credentials over existing bot config when the user typed new values', () => {
    expect(resolveFeishuCreateModeFinishStrategy(1, true, true)).toBe('manual')
  })

  it('blocks finishing when manual credentials were started but not completed', () => {
    expect(resolveFeishuCreateModeFinishStrategy(1, true, false)).toBe('invalid-manual')
  })

  it('falls back to the existing bot only when no manual credentials were entered', () => {
    expect(resolveFeishuCreateModeFinishStrategy(1, false, false)).toBe('existing')
    expect(resolveFeishuCreateModeFinishStrategy(0, false, false)).toBe('none')
  })
})

describe('shouldValidateFeishuManualCredentials', () => {
  it('validates manual credentials only in link mode after the user explicitly entered them', () => {
    expect(shouldValidateFeishuManualCredentials('link', true, true)).toBe(true)
    expect(shouldValidateFeishuManualCredentials('link', false, true)).toBe(false)
    expect(shouldValidateFeishuManualCredentials('create', true, true)).toBe(false)
    expect(shouldValidateFeishuManualCredentials('link', true, false)).toBe(false)
  })
})

describe('canPrepareFeishuManualBindingWithoutInstall', () => {
  it('fast-tracks manual binding when the official plugin is already on disk', () => {
    expect(
      canPrepareFeishuManualBindingWithoutInstall({
        installedOnDisk: true,
        officialPluginConfigured: true,
        configChanged: false,
      })
    ).toBe(true)

    expect(
      canPrepareFeishuManualBindingWithoutInstall({
        installedOnDisk: true,
        officialPluginConfigured: false,
        configChanged: true,
      })
    ).toBe(true)

    expect(
      canPrepareFeishuManualBindingWithoutInstall({
        installedOnDisk: false,
        officialPluginConfigured: true,
        configChanged: true,
      })
    ).toBe(false)
  })
})

describe('isFeishuManualBindingReady', () => {
  it('requires both the on-disk plugin and the normalized official config', () => {
    expect(
      isFeishuManualBindingReady({
        installedOnDisk: true,
        officialPluginConfigured: true,
      })
    ).toBe(true)

    expect(
      isFeishuManualBindingReady({
        installedOnDisk: true,
        officialPluginConfigured: false,
      })
    ).toBe(false)

    expect(
      isFeishuManualBindingReady({
        installedOnDisk: false,
        officialPluginConfigured: true,
      })
    ).toBe(false)
  })
})

describe('resolveFeishuAutoRecoveryTarget', () => {
  it('marks create mode as recoverable once any bot config has been detected', () => {
    expect(
      resolveFeishuAutoRecoveryTarget({
        setupMode: 'create',
        pluginState: {
          installedOnDisk: false,
          officialPluginConfigured: false,
          configChanged: false,
        },
        previousFeishuConfigSnapshot: null,
        nextConfig: {
          channels: {
            feishu: {
              appId: 'cli_created',
              appSecret: 'secret-created',
            },
          },
        },
      })
    ).toBe('recover-create')
  })

  it('asks link mode to heal config once the plugin is on disk but managed config is still missing', () => {
    expect(
      resolveFeishuAutoRecoveryTarget({
        setupMode: 'link',
        pluginState: {
          installedOnDisk: true,
          officialPluginConfigured: false,
          configChanged: true,
        },
        nextConfig: null,
      })
    ).toBe('heal-config')
  })

  it('marks link mode as recoverable once both plugin and config are ready', () => {
    expect(
      resolveFeishuAutoRecoveryTarget({
        setupMode: 'link',
        pluginState: {
          installedOnDisk: true,
          officialPluginConfigured: true,
          configChanged: false,
        },
        nextConfig: null,
      })
    ).toBe('recover-manual')
  })
})

describe('hasRecoveredFeishuCreateMode', () => {
  it('returns false when only the previously existing bot is still present', () => {
    expect(
      hasRecoveredFeishuCreateMode({
        previousFeishuConfigSnapshot: {
          appId: 'cli_existing',
          appSecret: 'secret-existing',
        },
        nextConfig: {
          channels: {
            feishu: {
              appId: 'cli_existing',
              appSecret: 'secret-existing',
            },
          },
        },
      })
    ).toBe(false)
  })

  it('returns true once a newly created bot appears alongside the previous config', () => {
    expect(
      hasRecoveredFeishuCreateMode({
        previousFeishuConfigSnapshot: {
          appId: 'cli_existing',
          appSecret: 'secret-existing',
        },
        nextConfig: {
          channels: {
            feishu: {
              appId: 'cli_existing',
              appSecret: 'secret-existing',
              accounts: {
                work: {
                  appId: 'cli_created',
                  appSecret: 'secret-created',
                },
              },
            },
          },
        },
      })
    ).toBe(true)
  })
})

describe('resolveFeishuManualBindingPreparationCopy', () => {
  it('surfaces a dedicated install hint for the slow path', () => {
    expect(resolveFeishuManualBindingPreparationCopy('checking').title).toContain('检查')
    expect(resolveFeishuManualBindingPreparationCopy('syncing').title).toContain('同步')
    expect(resolveFeishuManualBindingPreparationCopy('verifying').title).toContain('验证')
    expect(resolveFeishuManualBindingPreparationCopy('installing').hint).toContain('1 到 3 分钟')
  })
})

describe('resolveFeishuPairingTarget', () => {
  it('returns the newly added non-default bot after create mode', () => {
    expect(
      resolveFeishuPairingTarget({
        setupMode: 'create',
        finishStrategy: 'existing',
        previousFeishuConfigSnapshot: {
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
        nextConfig: {
          channels: {
            feishu: {
              appId: 'cli_default',
              appSecret: 'secret-default',
              accounts: {
                work: {
                  name: '工作机器人',
                  appId: 'cli_work',
                  appSecret: 'secret-work',
                },
              },
            },
          },
        },
      })
    ).toEqual({
      accountId: 'work',
      accountName: '工作机器人',
    })
  })

  it('returns the explicitly linked bot in link mode', () => {
    expect(
      resolveFeishuPairingTarget({
        setupMode: 'link',
        finishStrategy: 'existing',
        selectedAccountId: 'support',
        nextConfig: {
          channels: {
            feishu: {
              appId: 'cli_default',
              appSecret: 'secret-default',
              accounts: {
                support: {
                  name: '客服机器人',
                  appId: 'cli_support',
                  appSecret: 'secret-support',
                },
              },
            },
          },
        },
      })
    ).toEqual({
      accountId: 'support',
      accountName: '客服机器人',
    })
  })
})

describe('mergeFeishuCreateModeBots', () => {
  it('preserves the existing default bot and appends the newly created installer bot', () => {
    const result = mergeFeishuCreateModeBots({
      previousFeishuConfigSnapshot: {
        name: '原默认 Bot',
        appId: 'cli_existing',
        appSecret: 'secret-existing',
      },
      currentConfig: {
        channels: {
          feishu: {
            name: '新建 Bot',
            appId: 'cli_created',
            appSecret: 'secret-created',
          },
        },
      },
    })

    expect(result.addedBots).toHaveLength(1)
    expect(result.addedBots[0]).toMatchObject({
      accountName: '新建 Bot',
      appId: 'cli_created',
    })
    expect(result.nextConfig.channels.feishu.appId).toBe('cli_existing')
    expect(result.nextConfig.channels.feishu.accounts[result.addedBots[0].accountId]).toMatchObject({
      name: '新建 Bot',
      appId: 'cli_created',
      appSecret: 'secret-created',
    })
  })

  it('keeps the installer result unchanged when no new bot was created', () => {
    const currentConfig = {
      channels: {
        feishu: {
          name: '默认 Bot',
          appId: 'cli_existing',
          appSecret: 'secret-existing',
        },
      },
    }

    const result = mergeFeishuCreateModeBots({
      previousFeishuConfigSnapshot: {
        name: '默认 Bot',
        appId: 'cli_existing',
        appSecret: 'secret-existing',
      },
      currentConfig,
    })

    expect(result.addedBots).toEqual([])
    expect(result.nextConfig).toEqual(currentConfig)
  })
})

// ─── Task 1: LINE / Telegram / Slack channel definitions ───

describe('new IM channel definitions (LINE, Telegram, Slack)', () => {
  it('listChannelDefinitions contains line, telegram, and slack', () => {
    const definitions = listChannelDefinitions()
    const ids = definitions.map((d) => d.id)
    expect(ids).toContain('line')
    expect(ids).toContain('telegram')
    expect(ids).toContain('slack')
  })

  it('LINE definition exposes channelAccessToken and channelSecret fields', () => {
    const line = getChannelDefinition('line')
    expect(line).not.toBeNull()
    const fieldKeys = line!.fields.map((f) => f.key)
    expect(fieldKeys).toContain('channelAccessToken')
    expect(fieldKeys).toContain('channelSecret')
  })

  it('Telegram definition exposes botToken field', () => {
    const telegram = getChannelDefinition('telegram')
    expect(telegram).not.toBeNull()
    const fieldKeys = telegram!.fields.map((f) => f.key)
    expect(fieldKeys).toContain('botToken')
  })

  it('Slack definition exposes botToken and appToken fields', () => {
    const slack = getChannelDefinition('slack')
    expect(slack).not.toBeNull()
    const fieldKeys = slack!.fields.map((f) => f.key)
    expect(fieldKeys).toContain('botToken')
    expect(fieldKeys).toContain('appToken')
  })

  it('LINE requires pairing after config is written', () => {
    const line = getChannelDefinition('line')
    expect(line?.skipPairing).toBe(false)
  })

  it('Telegram requires pairing after config is written', () => {
    const telegram = getChannelDefinition('telegram')
    expect(telegram?.skipPairing).toBe(false)
  })

  it('Slack requires pairing after config is written', () => {
    const slack = getChannelDefinition('slack')
    expect(slack?.skipPairing).toBe(false)
  })
})

// ─── Task 2: Config writes for LINE / Telegram / Slack ───

describe('applyChannelConfig for new IM channels', () => {
  it('LINE writes channels.line.enabled, channelAccessToken, channelSecret, and default dmPolicy', () => {
    const result = applyChannelConfig({}, 'line', {
      channelAccessToken: 'line_token_123',
      channelSecret: 'line_secret_abc',
    })

    expect(result.channels.line.enabled).toBe(true)
    expect(result.channels.line.channelAccessToken).toBe('line_token_123')
    expect(result.channels.line.channelSecret).toBe('line_secret_abc')
    expect(result.channels.line.dmPolicy).toBe('pairing')
  })

  it('Telegram writes channels.telegram.enabled, botToken, and default dmPolicy', () => {
    const result = applyChannelConfig({}, 'telegram', {
      botToken: '123456:ABC-DEF',
    })

    expect(result.channels.telegram.enabled).toBe(true)
    expect(result.channels.telegram.botToken).toBe('123456:ABC-DEF')
    expect(result.channels.telegram.dmPolicy).toBe('pairing')
  })

  it('Slack writes channels.slack.enabled, botToken, appToken, and default dmPolicy', () => {
    const result = applyChannelConfig({}, 'slack', {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    })

    expect(result.channels.slack.enabled).toBe(true)
    expect(result.channels.slack.botToken).toBe('xoxb-test')
    expect(result.channels.slack.appToken).toBe('xapp-test')
    expect(result.channels.slack.dmPolicy).toBe('pairing')
  })

  it('LINE config write does not add a managed plugin allowlist entry', () => {
    const result = applyChannelConfig({}, 'line', {
      channelAccessToken: 'token',
      channelSecret: 'secret',
    })

    expect(result.plugins?.allow || []).not.toContain('openclaw-line')
  })

  it('Telegram config write does not add a managed plugin allowlist entry', () => {
    const result = applyChannelConfig({}, 'telegram', {
      botToken: 'token',
    })

    expect(result.plugins?.allow || []).not.toContain('openclaw-telegram')
  })

  it('Slack config write does not add a managed plugin allowlist entry', () => {
    const result = applyChannelConfig({}, 'slack', {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    })

    expect(result.plugins?.allow || []).not.toContain('openclaw-slack')
  })

  it('LINE config write preserves existing unrelated channel config', () => {
    const existing = {
      channels: {
        feishu: { enabled: true, appId: 'cli_test', appSecret: 'secret' },
      },
    }

    const result = applyChannelConfig(existing, 'line', {
      channelAccessToken: 'line_token',
      channelSecret: 'line_secret',
    })

    expect(result.channels.feishu.enabled).toBe(true)
    expect(result.channels.feishu.appId).toBe('cli_test')
    expect(result.channels.line.enabled).toBe(true)
  })
})
