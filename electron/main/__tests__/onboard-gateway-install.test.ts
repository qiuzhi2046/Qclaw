import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  runCliMock,
  appendEnvCheckDiagnosticMock,
} = vi.hoisted(() => ({
  runCliMock: vi.fn(),
  appendEnvCheckDiagnosticMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  runCli: runCliMock,
}))

vi.mock('../env-check-diagnostics', () => ({
  appendEnvCheckDiagnostic: appendEnvCheckDiagnosticMock,
}))

import { installGatewayServiceAfterSuccessfulOnboard } from '../onboard-gateway-install'

describe('installGatewayServiceAfterSuccessfulOnboard', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    runCliMock.mockReset()
    appendEnvCheckDiagnosticMock.mockReset()
    appendEnvCheckDiagnosticMock.mockResolvedValue(undefined)

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    })
  })

  it('installs the gateway service on Windows after onboard succeeds', async () => {
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: 'installed',
      stderr: '',
      code: 0,
    })

    await installGatewayServiceAfterSuccessfulOnboard()

    expect(runCliMock).toHaveBeenCalledWith(['gateway', 'install'], undefined, 'gateway')
    expect(appendEnvCheckDiagnosticMock).toHaveBeenCalledWith('ipc-onboard-gateway-install-start', {
      platform: 'win32',
    })
    expect(appendEnvCheckDiagnosticMock).toHaveBeenCalledWith('ipc-onboard-gateway-install-result', {
      ok: true,
      code: 0,
      stdout: 'installed',
      stderr: null,
    })
  })

  it('swallows gateway install failures and records a soft-failure diagnostic', async () => {
    runCliMock.mockRejectedValue(new Error('install denied'))

    await expect(installGatewayServiceAfterSuccessfulOnboard()).resolves.toBeUndefined()

    expect(runCliMock).toHaveBeenCalledWith(['gateway', 'install'], undefined, 'gateway')
    expect(appendEnvCheckDiagnosticMock).toHaveBeenCalledWith('ipc-onboard-gateway-install-failed', {
      message: 'install denied',
    })
  })

  it('skips gateway service installation on non-Windows platforms', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    })

    await installGatewayServiceAfterSuccessfulOnboard()

    expect(runCliMock).not.toHaveBeenCalled()
    expect(appendEnvCheckDiagnosticMock).not.toHaveBeenCalled()
  })
})
