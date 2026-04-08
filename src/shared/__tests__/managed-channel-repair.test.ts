import { describe, expect, it } from 'vitest'

import { buildManagedChannelRepairOutcome } from '../managed-channel-repair'
import {
  resolveManualInstallCommand,
  type ManagedChannelPluginStatusView,
} from '../managed-channel-plugin-lifecycle'

function createStatus(summary: string): ManagedChannelPluginStatusView {
  return {
    channelId: 'wecom',
    pluginId: 'wecom-openclaw-plugin',
    summary,
    stages: [
      { id: 'installed', state: 'verified', source: 'disk', message: 'installed' },
      { id: 'registered', state: 'verified', source: 'plugins-list', message: 'registered' },
      { id: 'loaded', state: 'unknown', source: 'status', message: 'unknown' },
      { id: 'ready', state: 'unknown', source: 'status', message: 'unknown' },
    ],
    evidence: [],
  }
}

describe('buildManagedChannelRepairOutcome', () => {
  it('keeps interactive-installer channels as a follow-up action instead of treating them as a hard failure', () => {
    const outcome = buildManagedChannelRepairOutcome({
      kind: 'manual-action-required',
      channelId: 'openclaw-weixin',
      pluginScope: 'channel',
      entityScope: 'account',
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      status: createStatus('微信插件仍待交互式安装器完成安装。'),
    })

    expect(outcome).toEqual({
      ok: true,
      summary: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      log: '⚠️ 该渠道需要交互式安装器，不能通过后台修复自动完成。',
      nextAction: 'launch-interactive-installer',
    })
  })

  it('formats successful managed repair results with the shared status summary', () => {
    const outcome = buildManagedChannelRepairOutcome({
      kind: 'ok',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      action: 'installed',
      status: createStatus('企微官方插件已安装并已注册；loaded / ready 仍待上游证据。'),
    })

    expect(outcome).toEqual({
      ok: true,
      summary: '企微官方插件已安装并已注册；loaded / ready 仍待上游证据。',
      log: '✅ 企微官方插件已安装并已注册；loaded / ready 仍待上游证据。',
      nextAction: null,
    })
  })
})

describe('resolveManualInstallCommand', () => {
  it('returns the full runnable npx install command for npx-managed channels', () => {
    expect(resolveManualInstallCommand('wecom')).toBe('npx -y @wecom/wecom-openclaw-cli install')
    expect(resolveManualInstallCommand('openclaw-weixin')).toBe(
      'npx -y @tencent-weixin/openclaw-weixin-cli@latest install'
    )
  })
})
