import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendRepairResultMock } = vi.hoisted(() => ({
  sendRepairResultMock: vi.fn(),
}))

vi.mock('../renderer-notification-bridge', () => ({
  sendRepairResult: sendRepairResultMock,
}))

import { notifyRepairResult } from '../managed-channel-repair-notifications'

function createStatus(summary: string) {
  return {
    channelId: 'wecom',
    pluginId: 'wecom-openclaw-plugin',
    summary,
    stages: [],
    evidence: [],
  }
}

describe('notifyRepairResult', () => {
  beforeEach(() => {
    sendRepairResultMock.mockReset()
  })

  it('attaches a manual install command for install failures', () => {
    notifyRepairResult({
      kind: 'install-failed',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      attemptedInstaller: 'npx',
      error: 'npm install failed',
      status: createStatus('企微插件安装失败。'),
    }, 'gateway-self-heal')

    expect(sendRepairResultMock).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'wecom',
      kind: 'install-failed',
      ok: false,
      manualCommand: 'npx -y @wecom/wecom-openclaw-cli install',
      trigger: 'gateway-self-heal',
    }))
  })

  it('does not attach a manual install command for non-install failure types', () => {
    notifyRepairResult({
      kind: 'gateway-reload-failed',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      reloadReason: 'gateway reload failed',
      retryable: true,
      status: createStatus('企微插件已修复。'),
    }, 'gateway-self-heal')
    notifyRepairResult({
      kind: 'config-sync-required',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      reason: 'config write required',
      status: createStatus('企微插件需要配置同步。'),
    }, 'gateway-self-heal')
    notifyRepairResult({
      kind: 'capability-blocked',
      channelId: 'wecom',
      pluginScope: 'channel',
      entityScope: 'channel',
      missingCapabilities: ['pluginsInstall'],
      status: createStatus('当前环境不支持插件安装。'),
    }, 'gateway-self-heal')

    expect(sendRepairResultMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'gateway-reload-failed',
      manualCommand: undefined,
    }))
    expect(sendRepairResultMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'config-sync-required',
      manualCommand: undefined,
    }))
    expect(sendRepairResultMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: 'capability-blocked',
      manualCommand: undefined,
    }))
  })
})
