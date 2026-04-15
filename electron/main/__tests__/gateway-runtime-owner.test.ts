import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  applyGatewaySecretActionMock,
  ensureGatewayReadyMock,
  gatewayStatusMock,
  reloadGatewayForConfigChangeMock,
} = vi.hoisted(() => ({
  applyGatewaySecretActionMock: vi.fn(),
  ensureGatewayReadyMock: vi.fn(),
  gatewayStatusMock: vi.fn(),
  reloadGatewayForConfigChangeMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  gatewayStatus: gatewayStatusMock,
}))

vi.mock('../gateway-lifecycle-controller', () => ({
  ensureGatewayReady: ensureGatewayReadyMock,
  reloadGatewayForConfigChange: reloadGatewayForConfigChangeMock,
}))

vi.mock('../gateway-secret-apply', () => ({
  applyGatewaySecretAction: applyGatewaySecretActionMock,
}))

import { reconcileGatewayRuntimeMutation } from '../gateway-runtime-owner'

describe('gateway runtime owner', () => {
  beforeEach(() => {
    applyGatewaySecretActionMock.mockReset()
    ensureGatewayReadyMock.mockReset()
    gatewayStatusMock.mockReset()
    reloadGatewayForConfigChangeMock.mockReset()

    gatewayStatusMock.mockResolvedValue({
      running: true,
      summary: 'gateway ready',
      stateCode: 'healthy',
    })
    ensureGatewayReadyMock.mockResolvedValue({
      ok: true,
      running: true,
      stdout: '',
      stderr: '',
      code: 0,
      summary: 'gateway ready',
      stateCode: 'healthy',
      attemptedCommands: [['gateway', 'start']],
    })
    reloadGatewayForConfigChangeMock.mockResolvedValue({
      ok: true,
      running: true,
      stdout: '',
      stderr: '',
      code: 0,
      summary: 'gateway reloaded',
      stateCode: 'healthy',
    })
    applyGatewaySecretActionMock.mockResolvedValue({
      ok: true,
      requestedAction: 'hot-reload',
      appliedAction: 'hot-reload',
      note: '',
    })
  })

  it('chooses ensure when auth succeeds, token does not rotate, and gateway is not running', async () => {
    gatewayStatusMock.mockResolvedValueOnce({
      running: false,
      summary: 'gateway stopped',
      stateCode: 'gateway_not_running',
    })

    const result = await reconcileGatewayRuntimeMutation({
      kind: 'auth-onboard',
      reason: 'auth-onboard',
      gatewayTokenChanged: false,
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('ensure')
    expect(ensureGatewayReadyMock).toHaveBeenCalledTimes(1)
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
  })

  it('does not ensure when auth succeeds, token does not rotate, and gateway is already running', async () => {
    const result = await reconcileGatewayRuntimeMutation({
      kind: 'auth-onboard',
      reason: 'auth-onboard',
      gatewayTokenChanged: false,
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('none')
    expect(gatewayStatusMock).toHaveBeenCalledTimes(1)
    expect(ensureGatewayReadyMock).not.toHaveBeenCalled()
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
  })

  it('chooses apply-token-and-ensure when auth rotates gateway token', async () => {
    const result = await reconcileGatewayRuntimeMutation({
      kind: 'auth-onboard',
      reason: 'auth-onboard',
      gatewayTokenChanged: true,
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('apply-token-and-ensure')
    expect(applyGatewaySecretActionMock).toHaveBeenCalledTimes(1)
    expect(ensureGatewayReadyMock).toHaveBeenCalledTimes(1)
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
  })

  it('defers token apply when auth rotates the gateway token while the gateway is down', async () => {
    gatewayStatusMock.mockResolvedValueOnce({
      running: false,
      summary: 'gateway stopped',
      stateCode: 'gateway_not_running',
    })

    const result = await reconcileGatewayRuntimeMutation({
      kind: 'auth-onboard',
      reason: 'auth-onboard',
      gatewayTokenChanged: true,
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('defer-token-apply')
    expect(applyGatewaySecretActionMock).not.toHaveBeenCalled()
    expect(ensureGatewayReadyMock).not.toHaveBeenCalled()
    expect(result.summary).toContain('下一次启动网关时应用')
  })

  it('chooses reload when channel config changes while gateway is already running', async () => {
    const result = await reconcileGatewayRuntimeMutation({
      kind: 'channel-change',
      reason: 'channel-change',
      preferEnsureWhenNotRunning: true,
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('reload')
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledTimes(1)
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith('channel-change', {
      preferEnsureWhenNotRunning: true,
      ensureOptions: {
        skipRuntimePrecheck: undefined,
      },
    })
    expect(ensureGatewayReadyMock).not.toHaveBeenCalled()
  })

  it('chooses ensure when channel config changes and the gateway status precheck says it is not running', async () => {
    gatewayStatusMock.mockResolvedValueOnce({
      running: false,
      summary: 'gateway stopped',
      stateCode: 'gateway_not_running',
    })

    const result = await reconcileGatewayRuntimeMutation({
      kind: 'channel-change',
      reason: 'channel-change',
      preferEnsureWhenNotRunning: true,
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('ensure')
    expect(ensureGatewayReadyMock).toHaveBeenCalledWith(
      {
        skipRuntimePrecheck: undefined,
      },
      'channel-change'
    )
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
  })

  it('chooses ensure when model config changes while gateway is not running', async () => {
    gatewayStatusMock.mockResolvedValueOnce({
      running: false,
      summary: 'gateway stopped',
      stateCode: 'gateway_not_running',
    })

    const result = await reconcileGatewayRuntimeMutation({
      kind: 'model-change',
      reason: 'model-change',
      preferEnsureWhenNotRunning: true,
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('ensure')
    expect(ensureGatewayReadyMock).toHaveBeenCalledTimes(1)
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
  })
})
