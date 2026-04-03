import { describe, expect, it } from 'vitest'
import {
  getVisiblePluginStatusStages,
  getChannelEnabledLabel,
  shouldReuseModelOptionsCache,
  shouldShowFeishuPluginRepairAction,
  shouldShowPluginStatus,
} from '../ChannelsPage'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('channels page state helpers', () => {
  it('uses enabled/disabled wording instead of treating config presence as readiness', () => {
    expect(getChannelEnabledLabel(true)).toBe('已启用')
    expect(getChannelEnabledLabel(false)).toBe('已禁用')
  })

  it('keeps plugin status visible for any row that already carries shared managed evidence', () => {
    expect(
      shouldShowPluginStatus({
        pluginStatus: {
          channelId: 'feishu',
          pluginId: 'openclaw-lark',
          summary: '飞书官方插件已安装并已注册；loaded / ready 仍待上游证据。',
          stages: [],
          evidence: [],
        },
      })
    ).toBe(true)

    expect(
      shouldShowPluginStatus({
        pluginStatus: null,
      })
    ).toBe(false)
  })

  it('filters channel-card plugin badges to evidence-backed states only', () => {
    expect(
      getVisiblePluginStatusStages({
        stages: [
          { id: 'installed', state: 'verified' },
          { id: 'registered', state: 'verified' },
          { id: 'loaded', state: 'unknown' },
          { id: 'ready', state: 'unknown' },
        ] as any,
      }).map((stage) => stage.id)
    ).toEqual(['installed', 'registered'])
  })

  it('adds a direct feishu plugin repair action to the channel card actions', () => {
    const channelCardSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'ChannelCard.tsx'),
      'utf8'
    )
    const channelsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ChannelsPage.tsx'),
      'utf8'
    )

    expect(channelCardSource).toContain('修复飞书插件')
    expect(channelsPageSource).toContain('window.api.repairManagedChannelPlugin')
    expect(channelsPageSource).toContain('window.api.getManagedChannelPluginStatus')
    expect(channelCardSource).toContain('repairingPluginChannelId === channel.channelId')
  })

  it('shows the shared feishu plugin repair action only for feishu bot rows', () => {
    expect(
      shouldShowFeishuPluginRepairAction({
        channelId: 'feishu',
        pairingAccountId: 'default',
      })
    ).toBe(true)

    expect(
      shouldShowFeishuPluginRepairAction({
        channelId: 'wecom',
        pairingAccountId: 'default',
      })
    ).toBe(false)

    expect(
      shouldShowFeishuPluginRepairAction({
        channelId: 'feishu',
        pairingAccountId: undefined,
      })
    ).toBe(false)
  })

  it('does not reuse cached model options when the feishu modal requests the full models-page scope', () => {
    expect(shouldReuseModelOptionsCache()).toBe(true)
    expect(shouldReuseModelOptionsCache({ mode: 'available' })).toBe(true)
    expect(shouldReuseModelOptionsCache({ mode: 'all' })).toBe(false)
    expect(shouldReuseModelOptionsCache({ forceRefresh: true })).toBe(false)
  })

  it('reuses the shared model catalog path for feishu model config instead of forcing a refresh', () => {
    const channelsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ChannelsPage.tsx'),
      'utf8'
    )

    expect(channelsPageSource).toMatch(/loadModelOptions\(\{[\s\S]*statusData,[\s\S]*preferredModelKey:\s*nextRuntimeModel/s)
    expect(channelsPageSource).not.toMatch(/loadModelOptions\(\{\s*forceRefresh:\s*true/s)
  })

  it('loads env and config snapshots so the feishu model modal can reuse the models page full catalog scope', () => {
    const channelsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ChannelsPage.tsx'),
      'utf8'
    )

    expect(channelsPageSource).toContain('window.api.readEnvFile()')
    expect(channelsPageSource).toContain("mode: 'all'")
    expect(channelsPageSource).toContain('envVars')
    expect(channelsPageSource).toContain('configData')
  })

  it('does not keep redundant channel-card subtitle, identifiers, or unknown plugin badges in the page source', () => {
    const channelsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ChannelsPage.tsx'),
      'utf8'
    )

    expect(channelsPageSource).not.toContain('配置和管理飞书、企微、钉钉、QQ 等消息渠道')
    expect(channelsPageSource).not.toContain('ID:')
    expect(channelsPageSource).not.toContain('Agent:')
    expect(channelsPageSource).not.toContain('渠道标识：')
    expect(channelsPageSource).not.toContain('点击卡片可进入这个机器人的配对管理。')
    expect(channelsPageSource).not.toContain('渠道接入后无需额外配对。')
    expect(channelsPageSource).not.toContain('运行状态：')
    expect(channelsPageSource).not.toContain('插件状态：')
    expect(channelsPageSource).not.toContain('unknown / 未证实')
    expect(channelsPageSource).toContain("stage.state !== 'unknown'")
  })
})
