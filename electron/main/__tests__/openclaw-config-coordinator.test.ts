import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readConfigMock, runCliMock, restartGatewayLifecycleMock, guardedWriteConfigMock } = vi.hoisted(() => ({
  readConfigMock: vi.fn(),
  runCliMock: vi.fn(),
  restartGatewayLifecycleMock: vi.fn(),
  guardedWriteConfigMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  readConfig: readConfigMock,
  runCli: runCliMock,
}))

vi.mock('../gateway-lifecycle-controller', () => ({
  restartGatewayLifecycle: restartGatewayLifecycleMock,
}))

vi.mock('../openclaw-config-guard', () => ({
  guardedWriteConfig: guardedWriteConfigMock,
}))

import { applyConfigPatchGuarded } from '../openclaw-config-coordinator'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitForGuardedWriteCalls(expectedCalls: number, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (guardedWriteConfigMock.mock.calls.length >= expectedCalls) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${expectedCalls} guarded write calls`)
}

describe('openclaw config coordinator', () => {
  beforeEach(() => {
    readConfigMock.mockReset()
    runCliMock.mockReset()
    restartGatewayLifecycleMock.mockReset()
    guardedWriteConfigMock.mockReset()

    runCliMock.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
    restartGatewayLifecycleMock.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    })
  })

  it('rebases patch edits on top of latest config to preserve unrelated concurrent changes', async () => {
    readConfigMock.mockResolvedValue({
      channels: {
        telegram: {
          enabled: true,
        },
      },
      models: {
        openai: {
          enabled: false,
        },
      },
      ui: {
        compact: true,
      },
    })
    guardedWriteConfigMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['$.channels.telegram'],
      ownershipSummary: null,
      message: 'ok',
    })

    await applyConfigPatchGuarded({
      beforeConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        models: {
          openai: {
            enabled: true,
          },
        },
      },
      afterConfig: {
        channels: {},
        models: {
          openai: {
            enabled: true,
          },
        },
      },
      reason: 'channels-remove-channel',
    })

    expect(guardedWriteConfigMock).toHaveBeenCalledTimes(1)
    expect(guardedWriteConfigMock).toHaveBeenCalledWith(
      {
        config: {
          channels: {},
          models: {
            openai: {
              enabled: false,
            },
          },
          ui: {
            compact: true,
          },
        },
        reason: 'channels-remove-channel',
      },
      undefined
    )
    expect(restartGatewayLifecycleMock).toHaveBeenCalledTimes(1)
    expect(runCliMock).not.toHaveBeenCalled()
  })

  it('serializes concurrent config patch requests through one write queue', async () => {
    const firstWrite = createDeferred<any>()

    readConfigMock.mockResolvedValue({})
    guardedWriteConfigMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce({
        ok: true,
        blocked: false,
        wrote: true,
        target: 'config',
        snapshotCreated: false,
        snapshot: null,
        changedJsonPaths: ['$.b'],
        ownershipSummary: null,
      })

    const firstCall = applyConfigPatchGuarded({
      beforeConfig: { a: 1 },
      afterConfig: { a: 2 },
      reason: 'unknown',
    })
    const secondCall = applyConfigPatchGuarded({
      beforeConfig: { b: 1 },
      afterConfig: { b: 2 },
      reason: 'unknown',
    })

    await waitForGuardedWriteCalls(1)
    expect(guardedWriteConfigMock).toHaveBeenCalledTimes(1)

    firstWrite.resolve({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['$.a'],
      ownershipSummary: null,
    })

    await Promise.all([firstCall, secondCall])
    expect(guardedWriteConfigMock).toHaveBeenCalledTimes(2)
    expect(runCliMock).not.toHaveBeenCalled()
    expect(restartGatewayLifecycleMock).not.toHaveBeenCalled()
  })

  it('skips gateway apply actions when applyGatewayPolicy is disabled', async () => {
    readConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          enabled: true,
        },
      },
    })
    guardedWriteConfigMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['$.channels.feishu.enabled'],
      ownershipSummary: null,
      message: 'ok',
    })

    await applyConfigPatchGuarded(
      {
        beforeConfig: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        },
        afterConfig: {
          channels: {},
        },
        reason: 'channels-remove-channel',
      },
      undefined,
      {
        applyGatewayPolicy: false,
      }
    )

    expect(runCliMock).not.toHaveBeenCalled()
    expect(restartGatewayLifecycleMock).not.toHaveBeenCalled()
  })

  it('falls back to gateway restart when hot-reload fails', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        auth: {
          token: 'old-token',
        },
      },
    })
    guardedWriteConfigMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['$.gateway.auth.token'],
      ownershipSummary: null,
      message: 'ok',
    })
    runCliMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'reload failed',
      code: 1,
    })

    const result = await applyConfigPatchGuarded({
      beforeConfig: {
        gateway: {
          auth: {
            token: 'old-token',
          },
        },
      },
      afterConfig: {
        gateway: {
          auth: {
            token: 'new-token',
          },
        },
      },
      reason: 'unknown',
    })

    expect(result.gatewayApply).toEqual({
      ok: true,
      requestedAction: 'hot-reload',
      appliedAction: 'restart',
      note: 'hot-reload failed, fallback to restart',
    })
    expect(runCliMock).toHaveBeenCalledTimes(1)
    expect(runCliMock).toHaveBeenCalledWith(['secrets', 'reload'], undefined, 'config-write')
    expect(restartGatewayLifecycleMock).toHaveBeenCalledTimes(1)
  })

  it('keeps write success when config write succeeds but gateway apply action fails', async () => {
    readConfigMock.mockResolvedValue({
      gateway: {
        auth: {
          token: 'old-token',
        },
      },
    })
    guardedWriteConfigMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['$.gateway.auth.token'],
      ownershipSummary: null,
      message: 'ok',
    })
    runCliMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'reload failed',
      code: 1,
    })
    restartGatewayLifecycleMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'restart failed',
      code: 1,
    })

    const result = await applyConfigPatchGuarded({
      beforeConfig: {
        gateway: {
          auth: {
            token: 'old-token',
          },
        },
      },
      afterConfig: {
        gateway: {
          auth: {
            token: 'new-token',
          },
        },
      },
      reason: 'unknown',
    })

    expect(result.ok).toBe(true)
    expect(result.wrote).toBe(true)
    expect(result.message).toContain('配置写入成功，但网关生效动作失败')
    expect(result.message).toContain('请稍后手动重载网关')
    expect(result.gatewayApply).toEqual({
      ok: false,
      requestedAction: 'hot-reload',
      appliedAction: 'restart',
      note: 'restart failed',
    })
    expect(runCliMock).toHaveBeenCalledTimes(1)
    expect(restartGatewayLifecycleMock).toHaveBeenCalledTimes(1)
  })
})
