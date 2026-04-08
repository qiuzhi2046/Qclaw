import { describe, expect, it, vi } from 'vitest'
import * as ChannelConnectModule from '../ChannelConnect'
import channelConnectSource from '../ChannelConnect.tsx?raw'
import {
  buildManagedPluginScopedRepairOptions,
  buildDingtalkOfficialSetupLog,
  buildChannelConnectCompletionCopy,
  canFinalizeWeixinSetup,
  canPrepareFeishuManualBindingWithoutInstall,
  canFinishFeishuCreateMode,
  createFeishuFinalizeSingleFlight,
  captureFeishuBotConfigSnapshot,
  ensureGatewayReadyForChannelConnect,
  hasRecoveredFeishuCreateMode,
  hasFeishuManualCredentialInput,
  isFeishuFinalizeContextCurrent,
  isFeishuManualBindingReady,
  mergeFeishuCreateModeBots,
  resolveFeishuCreateModeRecoveryNotice,
  resolveChannelConnectBindingStrategy,
  resolveFeishuAutoRecoveryTarget,
  resolveFeishuAutoFinalizeReadyKey,
  resolveFeishuManualBindingPreparationCopy,
  resolveFeishuPairingTarget,
  resolveFeishuCreateModeFinishStrategy,
  resolveChannelConnectProgressCopy,
  shouldFreezeFeishuSetupInteractions,
  isSafeAlreadyInstalledManagedPluginInstallError,
  resolveManagedPluginInstallPreflight,
  resolveManagedPluginInstallStrategy,
  restoreCapturedFeishuBotConfig,
  shouldValidateFeishuManualCredentials,
} from '../ChannelConnect'
import { getChannelDefinition } from '../../lib/openclaw-channel-registry'
describe('ChannelConnect source copy cleanup', () => {
  it('does not keep the redundant top-level setup helper copy', () => {
    expect(channelConnectSource).not.toContain('选择并配置您的即时通讯平台')
  })

  it('does not render shared channel helper copy or auto-install copy blocks', () => {
    expect(channelConnectSource).not.toMatch(/\{selectedChannel\.helpText\}/)
    expect(channelConnectSource).not.toContain('将自动安装:')
  })

  it('does not keep the redundant feishu create-mode helper copy', () => {
    expect(channelConnectSource).not.toContain('选择“新建机器人”')
    expect(channelConnectSource).not.toContain('使用飞书扫码创建新的官方机器人即可。')
    expect(channelConnectSource).not.toContain('打开飞书官网使用指南')
  })

  it('does not keep the redundant weixin helper paragraphs', () => {
    expect(channelConnectSource).not.toContain('点击“开始连接”后，Qclaw 会安装个人微信插件')
    expect(channelConnectSource).not.toContain('如果二维码过期，安装器会自动刷新；连接成功后')
  })

  it('shows the wecom managed-plugin precheck hint inline on the config page', () => {
    expect(channelConnectSource).toContain('首次连接企业微信时，Qclaw 会先检查并补装官方插件')
    expect(channelConnectSource).toContain('若配置里已有安装记录但本机插件目录缺失')
  })

  it('enters the installing state before managed plugin preflight starts', () => {
    expect(channelConnectSource.indexOf("setInstallProgressPhase('preflight')")).toBeGreaterThanOrEqual(0)
    expect(channelConnectSource.indexOf("setInstallProgressPhase('preflight')")).toBeLessThan(
      channelConnectSource.indexOf('managedPluginInstallPreflight = await resolveManagedPluginInstallPreflight(window.api')
    )
  })

  it('shows the Feishu finalize loading copy while auto-finalize is running', () => {
    expect(channelConnectSource).toContain('正在启动配置，请稍候')
  })

  it('re-checks finalize context before writing Feishu config to disk', () => {
    expect(channelConnectSource).toContain(
      "if (!isCurrentFinalizeContext()) return\n          await writeConfigDirect("
    )
  })

  it('clears the Feishu finishing state when channel changes invalidate finalize', () => {
    const handleChannelChangeStart = channelConnectSource.indexOf('const handleChannelChange = (channelId: string) => {')
    const handleFieldChangeStart = channelConnectSource.indexOf('const handleFieldChange = (key: string, value: string) => {')
    const handleChannelChangeSource = channelConnectSource.slice(handleChannelChangeStart, handleFieldChangeStart)

    expect(handleChannelChangeSource).toContain('invalidateFeishuFinalizeRequest({ resetFinishingState: true })')
  })
})
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

describe('resolveChannelConnectProgressCopy', () => {
  it('shows the plugin preflight wording before the real install begins', () => {
    expect(resolveChannelConnectProgressCopy('installing', 'preflight')).toBe('正在检查插件兼容性...')
  })

  it('keeps the existing startup wording for the service boot stage', () => {
    expect(resolveChannelConnectProgressCopy('starting', 'plugin-install')).toBe('正在启动服务...')
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
      '⚠️ 网关端口已自动切换到 19876，程序会继续使用新端口。\n\n'
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

    expect(result).toEqual({ ok: false, message: '网关启动失败' })
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

  it('treats plain already-exists plugin errors as safe reuse but not when safety repair also failed', () => {
    expect(isSafeAlreadyInstalledManagedPluginInstallError('plugin already exists')).toBe(true)
    expect(isSafeAlreadyInstalledManagedPluginInstallError('plugin already exists\n已自动隔离')).toBe(false)
    expect(isSafeAlreadyInstalledManagedPluginInstallError('plugin already exists\n安全修复失败')).toBe(false)
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
  it('requires both recovered bot config and a clean installer exit before finishing create mode', () => {
    expect(canFinishFeishuCreateMode(false, false)).toBe(false)
    expect(canFinishFeishuCreateMode(true, false)).toBe(false)
    expect(canFinishFeishuCreateMode(true, true)).toBe(true)
  })
})

describe('resolveFeishuCreateModeRecoveryNotice', () => {
  it('asks the user to wait while the installer is still finishing its own cleanup', () => {
    expect(resolveFeishuCreateModeRecoveryNotice(false, true, false)).toBe('')
    expect(resolveFeishuCreateModeRecoveryNotice(true, true, false)).toContain('等待飞书安装器完成收尾')
    expect(resolveFeishuCreateModeRecoveryNotice(true, true, false)).toContain('安装器退出后')
  })

  it('unlocks completion messaging only after the installer exited successfully', () => {
    expect(resolveFeishuCreateModeRecoveryNotice(true, false, true)).toContain('现在可以点击“完成配置”')
  })

  it('keeps completion locked when the installer exited abnormally', () => {
    expect(resolveFeishuCreateModeRecoveryNotice(true, false, false)).toContain('安装器未正常完成')
  })
})

describe('resolveFeishuAutoFinalizeReadyKey', () => {
  it('auto-finalizes Feishu create mode once the installer exited cleanly and recovery is complete', () => {
    expect(
      resolveFeishuAutoFinalizeReadyKey({
        channelId: 'feishu',
        status: 'form',
        setupMode: 'create',
        createModeCanFinish: true,
        manualCredentialsReady: false,
        preparingManualBinding: false,
        finishingFeishuSetup: false,
        recoveredBotCount: 2,
        installerExitCode: 0,
      })
    ).toBe('create:2:0')
  })

  it('waits for complete manual credentials before auto-finalizing link mode', () => {
    expect(
      resolveFeishuAutoFinalizeReadyKey({
        channelId: 'feishu',
        status: 'form',
        setupMode: 'link',
        createModeCanFinish: false,
        manualCredentialsReady: false,
        preparingManualBinding: false,
        finishingFeishuSetup: false,
        appId: 'cli_123',
        appSecret: 'secret',
      })
    ).toBeNull()

    expect(
      resolveFeishuAutoFinalizeReadyKey({
        channelId: 'feishu',
        status: 'form',
        setupMode: 'link',
        createModeCanFinish: false,
        manualCredentialsReady: true,
        preparingManualBinding: false,
        finishingFeishuSetup: false,
        appId: 'cli_123',
        appSecret: 'secret',
      })
    ).toBe('link:cli_123:secret')
  })

  it('blocks auto-finalize while the page is already finishing or still preparing manual binding', () => {
    expect(
      resolveFeishuAutoFinalizeReadyKey({
        channelId: 'feishu',
        status: 'form',
        setupMode: 'create',
        createModeCanFinish: true,
        manualCredentialsReady: false,
        preparingManualBinding: false,
        finishingFeishuSetup: true,
        recoveredBotCount: 1,
        installerExitCode: 0,
      })
    ).toBeNull()

    expect(
      resolveFeishuAutoFinalizeReadyKey({
        channelId: 'feishu',
        status: 'form',
        setupMode: 'link',
        createModeCanFinish: false,
        manualCredentialsReady: true,
        preparingManualBinding: true,
        finishingFeishuSetup: false,
        appId: 'cli_123',
        appSecret: 'secret',
      })
    ).toBeNull()
  })
})

describe('createFeishuFinalizeSingleFlight', () => {
  it('reuses the in-flight finalize promise instead of starting duplicate runs', async () => {
    let resolveRun: () => void = () => {}
    const runner = createFeishuFinalizeSingleFlight(async () => {
      await new Promise<void>((resolve) => {
        resolveRun = resolve
      })
    })

    const firstRun = runner()
    const secondRun = runner()

    expect(firstRun).toBe(secondRun)

    resolveRun()
    await firstRun
  })

  it('allows retrying after the previous finalize run failed', async () => {
    const finalize = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const runner = createFeishuFinalizeSingleFlight(finalize)

    await expect(runner()).rejects.toThrow('boom')
    await expect(runner()).resolves.toBeUndefined()
    expect(finalize).toHaveBeenCalledTimes(2)
  })
})

describe('isFeishuFinalizeContextCurrent', () => {
  it('rejects stale finalize requests after the user switches channel or setup mode', () => {
    expect(
      isFeishuFinalizeContextCurrent({
        requestVersion: 3,
        activeRequestVersion: 4,
        currentChannelId: 'feishu',
        expectedChannelId: 'feishu',
        currentSetupMode: 'create',
        expectedSetupMode: 'create',
      })
    ).toBe(false)

    expect(
      isFeishuFinalizeContextCurrent({
        requestVersion: 4,
        activeRequestVersion: 4,
        currentChannelId: 'wecom',
        expectedChannelId: 'feishu',
        currentSetupMode: 'create',
        expectedSetupMode: 'create',
      })
    ).toBe(false)

    expect(
      isFeishuFinalizeContextCurrent({
        requestVersion: 4,
        activeRequestVersion: 4,
        currentChannelId: 'feishu',
        expectedChannelId: 'feishu',
        currentSetupMode: 'link',
        expectedSetupMode: 'create',
      })
    ).toBe(false)
  })

  it('accepts finalize results only when the request still matches the active Feishu context', () => {
    expect(
      isFeishuFinalizeContextCurrent({
        requestVersion: 7,
        activeRequestVersion: 7,
        currentChannelId: 'feishu',
        expectedChannelId: 'feishu',
        currentSetupMode: 'link',
        expectedSetupMode: 'link',
      })
    ).toBe(true)
  })
})

describe('shouldFreezeFeishuSetupInteractions', () => {
  it('freezes Feishu form interactions while finalize is running', () => {
    expect(
      shouldFreezeFeishuSetupInteractions({
        channelId: 'feishu',
        finishingFeishuSetup: true,
      })
    ).toBe(true)
  })

  it('keeps other channels and idle Feishu setups interactive', () => {
    expect(
      shouldFreezeFeishuSetupInteractions({
        channelId: 'feishu',
        finishingFeishuSetup: false,
      })
    ).toBe(false)

    expect(
      shouldFreezeFeishuSetupInteractions({
        channelId: 'wecom',
        finishingFeishuSetup: true,
      })
    ).toBe(false)
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

  it('preserves SecretRef-style secrets when merging a newly created bot into accounts', () => {
    const currentConfig = {
      channels: {
        feishu: {
          name: '新建 Bot',
          appId: 'cli_created',
          appSecret: {
            source: 'file',
            provider: 'lark-secrets',
            id: '/lark/appSecret',
          },
        },
      },
    }
    const result = mergeFeishuCreateModeBots({
      previousFeishuConfigSnapshot: {
        name: '原默认 Bot',
        appId: 'cli_existing',
        appSecret: 'secret-existing',
      },
      currentConfig,
    })

    expect(result.addedBots).toHaveLength(1)
    expect(result.nextConfig.channels.feishu.appId).toBe('cli_existing')
    expect(result.nextConfig.channels.feishu.accounts[result.addedBots[0].accountId]).toMatchObject({
      appId: 'cli_created',
      appSecret: {
        source: 'file',
        provider: 'lark-secrets',
        id: '/lark/appSecret',
      },
    })
  })
})
