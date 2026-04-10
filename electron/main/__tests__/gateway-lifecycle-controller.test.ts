import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gatewayHealthMock,
  gatewayStatusMock,
  gatewayStartMock,
  gatewayRestartMock,
  gatewayStopMock,
  ensureGatewayRunningMock,
} = vi.hoisted(() => ({
  gatewayHealthMock: vi.fn(),
  gatewayStatusMock: vi.fn(),
  gatewayStartMock: vi.fn(),
  gatewayRestartMock: vi.fn(),
  gatewayStopMock: vi.fn(),
  ensureGatewayRunningMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  gatewayHealth: gatewayHealthMock,
  gatewayStatus: gatewayStatusMock,
  gatewayStart: gatewayStartMock,
  gatewayRestart: gatewayRestartMock,
  gatewayStop: gatewayStopMock,
}))

vi.mock('../openclaw-gateway-service', () => ({
  ensureGatewayRunning: ensureGatewayRunningMock,
}))

import {
  ensureGatewayReady,
  reloadGatewayForConfigChange,
  restartGatewayLifecycle,
  startGatewayLifecycle,
} from '../gateway-lifecycle-controller'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitForCalls(mock: ReturnType<typeof vi.fn>, expectedCalls: number, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (mock.mock.calls.length >= expectedCalls) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${expectedCalls} calls`)
}

function createCliOkResult() {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    code: 0,
  }
}

describe('gateway lifecycle controller', () => {
  beforeEach(() => {
    gatewayHealthMock.mockReset()
    gatewayStatusMock.mockReset()
    gatewayStartMock.mockReset()
    gatewayRestartMock.mockReset()
    gatewayStopMock.mockReset()
    ensureGatewayRunningMock.mockReset()

    gatewayHealthMock.mockResolvedValue({
      running: true,
      raw: '{}',
      stderr: '',
      code: 0,
      stateCode: 'healthy',
      summary: 'ok',
    })
    gatewayStatusMock.mockResolvedValue({
      ok: true,
      running: true,
      rpcReachable: true,
      raw: '{}',
      stderr: '',
      code: 0,
      stateCode: 'healthy',
      summary: 'ok',
    })
    gatewayStartMock.mockResolvedValue(createCliOkResult())
    gatewayRestartMock.mockResolvedValue(createCliOkResult())
    gatewayStopMock.mockResolvedValue(createCliOkResult())
    ensureGatewayRunningMock.mockResolvedValue({
      ...createCliOkResult(),
      running: true,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: false,
      effectivePort: 4317,
      stateCode: 'healthy',
      summary: 'ok',
      attemptedCommands: [],
      evidence: [],
      repairActionsTried: [],
      repairOutcome: 'not-needed',
      safeToRetry: true,
    })
  })

  it('reuses concurrent restart requests with the same shared mutation key', async () => {
    const deferredRestart = createDeferred<ReturnType<typeof createCliOkResult>>()
    gatewayRestartMock.mockImplementationOnce(() => deferredRestart.promise)

    const first = restartGatewayLifecycle('manual-restart')
    const second = restartGatewayLifecycle('model-change')
    await waitForCalls(gatewayRestartMock, 1)

    deferredRestart.resolve(createCliOkResult())
    await Promise.all([first, second])

    expect(gatewayRestartMock).toHaveBeenCalledTimes(1)
  })

  it('serializes start and restart mutations', async () => {
    const deferredStart = createDeferred<ReturnType<typeof createCliOkResult>>()
    gatewayStartMock.mockImplementationOnce(() => deferredStart.promise)

    const startPromise = startGatewayLifecycle('start')
    const restartPromise = restartGatewayLifecycle('restart')

    await waitForCalls(gatewayStartMock, 1)
    expect(gatewayRestartMock).toHaveBeenCalledTimes(0)

    deferredStart.resolve(createCliOkResult())
    await Promise.all([startPromise, restartPromise])

    expect(gatewayStartMock).toHaveBeenCalledTimes(1)
    expect(gatewayRestartMock).toHaveBeenCalledTimes(1)
  })

  it('reuses ensure requests with the same strict mode key', async () => {
    const deferredEnsure = createDeferred<any>()
    ensureGatewayRunningMock.mockImplementationOnce(() => deferredEnsure.promise)

    const first = ensureGatewayReady({}, 'entry-gate')
    const second = ensureGatewayReady({}, 'entry-gate-second')
    await waitForCalls(ensureGatewayRunningMock, 1)

    deferredEnsure.resolve({
      ...createCliOkResult(),
      running: true,
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      autoInstalledGatewayService: false,
      autoPortMigrated: false,
      effectivePort: 4317,
      stateCode: 'healthy',
      summary: 'ok',
      attemptedCommands: [],
      evidence: [],
      repairActionsTried: [],
      repairOutcome: 'not-needed',
      safeToRetry: true,
    })

    await Promise.all([first, second])
    expect(ensureGatewayRunningMock).toHaveBeenCalledTimes(1)
  })

  it('reloads via ensure when gateway is not running', async () => {
    gatewayStatusMock.mockResolvedValueOnce({
      running: false,
    })

    const result = await reloadGatewayForConfigChange('config-change', {
      preferEnsureWhenNotRunning: true,
      ensureOptions: {
        skipRuntimePrecheck: true,
      },
    })

    expect(result).toMatchObject({
      ok: true,
      running: true,
      summary: 'ok',
    })
    expect(ensureGatewayRunningMock).toHaveBeenCalledTimes(1)
    expect(ensureGatewayRunningMock).toHaveBeenCalledWith({
      skipRuntimePrecheck: true,
    })
    expect(gatewayRestartMock).toHaveBeenCalledTimes(0)
  })

  it('reloads via restart and waits until gateway health is confirmed again', async () => {
    gatewayStatusMock
      .mockResolvedValueOnce({
        running: true,
        raw: '{}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'ok',
      })
      .mockResolvedValueOnce({
        running: true,
        raw: '{"ok":true}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'Gateway 已确认可用',
      })

    const result = await reloadGatewayForConfigChange('config-change')

    expect(result).toMatchObject({
      ok: true,
      running: true,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
    })
    expect(gatewayRestartMock).toHaveBeenCalledTimes(1)
    expect(ensureGatewayRunningMock).toHaveBeenCalledTimes(0)
    expect(gatewayStatusMock).toHaveBeenCalledTimes(2)
  })

  it('treats a reload as ready when service status is healthy even if the follow-up rpc probe fails', async () => {
    vi.useFakeTimers()
    gatewayHealthMock.mockReset()
    gatewayHealthMock
      .mockResolvedValueOnce({
        running: true,
        raw: '{}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'ok',
      })
      .mockResolvedValue({
        running: false,
        raw: '',
        stderr: "gateway connect failed: Error: EPERM: operation not permitted, open 'C:\\Users\\qiuzh\\.openclaw\\identity\\device-auth.json'",
        code: 1,
        stateCode: 'unknown_runtime_failure',
        summary: '当前机器没有足够权限访问 OpenClaw 配置或运行目录',
      })

    gatewayStatusMock
      .mockResolvedValueOnce({
        ok: true,
        running: true,
        rpcReachable: true,
        raw: '{}',
        stderr: '',
        code: 0,
        stateCode: 'healthy',
        summary: 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        running: true,
        rpcReachable: false,
        raw: '{"service":{"runtime":{"status":"running"}},"health":{"healthy":true},"rpc":{"ok":false}}',
        stderr: "gateway connect failed: Error: EPERM: operation not permitted, open 'C:\\Users\\qiuzh\\.openclaw\\identity\\device-auth.json'",
        code: 0,
        stateCode: 'healthy',
        summary: '网关服务已重载并确认正在运行；本地 RPC 探测未通过',
      })

    try {
      const resultPromise = reloadGatewayForConfigChange('config-change')
      await vi.advanceTimersByTimeAsync(50_000)
      const result = await resultPromise

      expect(result).toMatchObject({
        ok: true,
        running: true,
        stateCode: 'healthy',
        summary: '网关服务已重载并确认正在运行；本地 RPC 探测未通过',
      })
      expect(gatewayRestartMock).toHaveBeenCalledTimes(1)
      expect(gatewayStatusMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
