import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cancelActiveCommandsMock, stopFeishuInstallerSessionMock, stopWeixinInstallerSessionMock } = vi.hoisted(() => ({
  cancelActiveCommandsMock: vi.fn(),
  stopFeishuInstallerSessionMock: vi.fn(),
  stopWeixinInstallerSessionMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  cancelActiveCommands: cancelActiveCommandsMock,
}))

vi.mock('../feishu-installer-session', () => ({
  stopFeishuInstallerSession: stopFeishuInstallerSessionMock,
}))

vi.mock('../weixin-installer-session', () => ({
  stopWeixinInstallerSession: stopWeixinInstallerSessionMock,
}))

import { runAppExitCleanup } from '../app-exit-cleanup'

describe('app exit cleanup', () => {
  beforeEach(() => {
    cancelActiveCommandsMock.mockReset()
    stopFeishuInstallerSessionMock.mockReset()
    stopWeixinInstallerSessionMock.mockReset()
    cancelActiveCommandsMock.mockResolvedValue({
      canceledDomains: [],
      failedDomains: [],
      untouchedDomains: [],
    })
    stopFeishuInstallerSessionMock.mockResolvedValue({
      ok: true,
      gatewayRecovery: {
        ok: true,
        recovered: true,
        skipped: false,
      },
    })
    stopWeixinInstallerSessionMock.mockResolvedValue({ ok: true })
  })

  it('cancels known temporary command domains and stops installer session', async () => {
    cancelActiveCommandsMock.mockResolvedValueOnce({
      canceledDomains: ['chat', 'global'],
      failedDomains: [],
      untouchedDomains: ['oauth'],
    })

    const result = await runAppExitCleanup()

    expect(cancelActiveCommandsMock).toHaveBeenCalledTimes(1)
    expect(cancelActiveCommandsMock).toHaveBeenCalledWith([
      'gateway',
      'config-write',
      'chat',
      'oauth',
      'capabilities',
      'models',
      'env',
      'plugin-install',
      'feishu-installer',
      'weixin-installer',
      'upgrade',
      'env-setup',
      'global',
    ])
    expect(stopFeishuInstallerSessionMock).toHaveBeenCalledTimes(1)
    expect(stopFeishuInstallerSessionMock).toHaveBeenCalledWith({
      recoverGateway: true,
      recoveryTimeoutMs: 5000,
    })
    expect(stopWeixinInstallerSessionMock).toHaveBeenCalledTimes(1)

    expect(result.canceledDomains).toEqual(['chat', 'global'])
    expect(result.failedDomains).toEqual([])
    expect(result.gatewayRecovery).toEqual({
      ok: true,
      recovered: true,
      skipped: false,
    })
    expect(result.installerStopped).toBe(true)
  })

  it('collects failed domains and treats installer stop exceptions as non-fatal', async () => {
    cancelActiveCommandsMock.mockResolvedValueOnce({
      canceledDomains: ['chat'],
      failedDomains: ['oauth', 'global'],
      untouchedDomains: ['models'],
    })
    stopFeishuInstallerSessionMock.mockRejectedValue(new Error('installer stop failed'))

    const result = await runAppExitCleanup()

    expect(result.canceledDomains).toEqual(['chat'])
    expect(result.failedDomains).toEqual(['oauth', 'global'])
    expect(result.installerStopped).toBe(false)
  })

  it('marks all domains as failed when batch cancel throws unexpectedly', async () => {
    cancelActiveCommandsMock.mockRejectedValueOnce(new Error('batch cancel failed'))

    const result = await runAppExitCleanup()

    expect(result.failedDomains).toEqual([
      'gateway',
      'config-write',
      'chat',
      'oauth',
      'capabilities',
      'models',
      'env',
      'plugin-install',
      'feishu-installer',
      'weixin-installer',
      'upgrade',
      'env-setup',
      'global',
    ])
  })
})
