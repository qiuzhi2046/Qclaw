import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ensureFeishuOfficialPluginReadyMock,
  getFeishuOfficialPluginStateMock,
  isPluginInstalledOnDiskMock,
  repairStalePluginConfigFromCommandResultMock,
  repairDingtalkOfficialChannelMock,
  runCliMock,
} = vi.hoisted(() => ({
  ensureFeishuOfficialPluginReadyMock: vi.fn(),
  getFeishuOfficialPluginStateMock: vi.fn(),
  isPluginInstalledOnDiskMock: vi.fn(),
  repairStalePluginConfigFromCommandResultMock: vi.fn(),
  repairDingtalkOfficialChannelMock: vi.fn(),
  runCliMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  isPluginInstalledOnDisk: isPluginInstalledOnDiskMock,
  runCli: runCliMock,
}))

vi.mock('../feishu-official-plugin-state', () => ({
  ensureFeishuOfficialPluginReady: ensureFeishuOfficialPluginReadyMock,
  getFeishuOfficialPluginState: getFeishuOfficialPluginStateMock,
}))

vi.mock('../openclaw-config-warnings', () => ({
  repairStalePluginConfigFromCommandResult: repairStalePluginConfigFromCommandResultMock,
}))

vi.mock('../dingtalk-official-channel', () => ({
  repairDingtalkOfficialChannel: repairDingtalkOfficialChannelMock,
}))

describe('official channel adapters', () => {
  beforeEach(() => {
    ensureFeishuOfficialPluginReadyMock.mockReset()
    getFeishuOfficialPluginStateMock.mockReset()
    isPluginInstalledOnDiskMock.mockReset()
    repairStalePluginConfigFromCommandResultMock.mockReset()
    repairDingtalkOfficialChannelMock.mockReset()
    runCliMock.mockReset()
  })

  it('maps DingTalk status into evidence-backed installed / registered / loaded / ready stages', async () => {
    isPluginInstalledOnDiskMock.mockResolvedValue(true)
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        plugins: [
          { id: 'dingtalk-connector' },
        ],
      }),
      stderr: '',
      code: 0,
    })

    const { getOfficialChannelStatus } = await import('../official-channel-adapters')
    const result = await getOfficialChannelStatus('dingtalk')

    expect(result.summary).toContain('已安装并已注册')
    expect(result.stages).toEqual([
      {
        id: 'installed',
        state: 'verified',
        source: 'disk',
        message: '已确认本机存在钉钉官方插件安装',
      },
      {
        id: 'registered',
        state: 'verified',
        source: 'plugins-list',
        message: '已在上游 plugins list 中确认插件已注册',
      },
      {
        id: 'loaded',
        state: 'unknown',
        source: 'upstream-status-missing',
        message: '当前缺少上游 loaded 证明',
      },
      {
        id: 'ready',
        state: 'unknown',
        source: 'upstream-probe-missing',
        message: '当前缺少上游 ready 证明',
      },
    ])
  })

  it('surfaces Feishu config drift in the shared status summary without promoting it to ready', async () => {
    getFeishuOfficialPluginStateMock.mockResolvedValue({
      pluginId: 'openclaw-lark',
      installedOnDisk: true,
      installPath: '/tmp/home/extensions/openclaw-lark',
      officialPluginConfigured: false,
      legacyPluginIdsPresent: [],
      configChanged: true,
      normalizedConfig: {},
    })
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        plugins: [
          { id: 'openclaw-lark' },
        ],
      }),
      stderr: '',
      code: 0,
    })

    const { getOfficialChannelStatus } = await import('../official-channel-adapters')
    const result = await getOfficialChannelStatus('feishu')

    expect(result.summary).toContain('配置仍待同步')
    expect(result.stages.find((stage) => stage.id === 'registered')?.state).toBe('verified')
    expect(result.stages.find((stage) => stage.id === 'ready')?.state).toBe('unknown')
  })

  it('does not auto-repair stale plugin warnings during registration evidence reads', async () => {
    getFeishuOfficialPluginStateMock.mockResolvedValue({
      pluginId: 'openclaw-lark',
      installedOnDisk: true,
      installPath: '/tmp/home/extensions/openclaw-lark',
      officialPluginConfigured: true,
      legacyPluginIdsPresent: [],
      configChanged: false,
      normalizedConfig: {},
    })
    runCliMock.mockResolvedValueOnce({
      ok: true,
      stdout:
        'Config warnings:\n- plugins.allow: plugin not found: fake-stale-plugin (stale config entry ignored; remove it from plugins config)',
      stderr: '',
      code: 0,
    })
    repairStalePluginConfigFromCommandResultMock.mockResolvedValue({
      stalePluginIds: ['fake-stale-plugin'],
      changed: true,
      removedPluginIds: ['fake-stale-plugin'],
    })

    const { getOfficialChannelStatus } = await import('../official-channel-adapters')
    const result = await getOfficialChannelStatus('feishu')

    expect(runCliMock).toHaveBeenCalledTimes(1)
    expect(repairStalePluginConfigFromCommandResultMock).not.toHaveBeenCalled()
    expect(result.stages.find((stage) => stage.id === 'registered')?.state).toBe('unknown')
  })

  it('maps Feishu repair to the shared official adapter result shape', async () => {
    ensureFeishuOfficialPluginReadyMock.mockResolvedValue({
      ok: true,
      installedThisRun: false,
      state: {
        pluginId: 'openclaw-lark',
        installedOnDisk: true,
        officialPluginConfigured: true,
        configChanged: false,
      },
      stdout: '',
      stderr: '',
      code: 0,
      message: '已确认飞书官方插件可用',
    })

    const { repairOfficialChannel } = await import('../official-channel-adapters')
    const result = await repairOfficialChannel('feishu')

    expect(result).toEqual({
      ok: true,
      channelId: 'feishu',
      pluginId: 'openclaw-lark',
      summary: '飞书官方插件已归一化；loaded / ready 仍待上游证据。',
      installedThisRun: false,
      gatewayResult: null,
      evidence: [
        {
          source: 'status',
          channelId: 'feishu',
          pluginId: 'openclaw-lark',
          message: '已确认飞书官方插件安装存在，且配置已处于归一化状态',
        },
      ],
      stdout: '',
      stderr: '',
      code: 0,
      message: '已确认飞书官方插件可用',
    })
  })

  it('delegates DingTalk repair to the dedicated official adapter pipeline', async () => {
    repairDingtalkOfficialChannelMock.mockResolvedValue({
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
      message: '钉钉官方插件已完成修复，ready 仍待上游证据',
    })

    const { repairOfficialChannel } = await import('../official-channel-adapters')
    const result = await repairOfficialChannel('dingtalk')

    expect(repairDingtalkOfficialChannelMock).toHaveBeenCalledTimes(1)
    expect(result.summary).toBe('钉钉官方插件已修复；loaded / ready 仍待上游证据。')
  })
})
