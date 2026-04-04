import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  guardedWriteEnvFileMock,
  applyGatewaySecretActionMock,
} = vi.hoisted(() => ({
  guardedWriteEnvFileMock: vi.fn(),
  applyGatewaySecretActionMock: vi.fn(),
}))

vi.mock('../openclaw-config-guard', () => ({
  guardedWriteEnvFile: guardedWriteEnvFileMock,
}))

vi.mock('../gateway-secret-apply', () => ({
  applyGatewaySecretAction: applyGatewaySecretActionMock,
}))

vi.mock('../cli', () => ({
  runCli: vi.fn(),
}))

import { guardedWriteEnvFileWithGatewayApply } from '../openclaw-env-write-service'

describe('guardedWriteEnvFileWithGatewayApply', () => {
  beforeEach(() => {
    guardedWriteEnvFileMock.mockReset()
    applyGatewaySecretActionMock.mockReset()
  })

  it('keeps write success when env write succeeds but gateway apply fails', async () => {
    guardedWriteEnvFileMock.mockResolvedValue({
      ok: true,
      blocked: false,
      wrote: true,
      target: 'env',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: ['$.OPENAI_API_KEY'],
      ownershipSummary: null,
      message: '环境变量已通过 DataGuard 写入。',
    })
    applyGatewaySecretActionMock.mockResolvedValue({
      ok: false,
      requestedAction: 'hot-reload',
      appliedAction: 'restart',
      note: 'restart failed',
    })

    const result = await guardedWriteEnvFileWithGatewayApply({
      updates: {
        OPENAI_API_KEY: 'sk-test',
      },
      reason: 'unknown',
    })

    expect(result.ok).toBe(true)
    expect(result.wrote).toBe(true)
    expect(result.message).toContain('环境变量已保存，但运行状态同步失败')
    expect(result.gatewayApply).toEqual({
      ok: false,
      requestedAction: 'hot-reload',
      appliedAction: 'restart',
      note: 'restart failed',
    })
  })

  it('returns the original failure when the env write itself fails', async () => {
    guardedWriteEnvFileMock.mockResolvedValue({
      ok: false,
      blocked: false,
      wrote: false,
      target: 'env',
      snapshotCreated: false,
      snapshot: null,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: '环境变量写入失败',
      errorCode: 'write_failed',
    })

    const result = await guardedWriteEnvFileWithGatewayApply({
      updates: {
        OPENAI_API_KEY: 'sk-test',
      },
      reason: 'unknown',
    })

    expect(result).toMatchObject({
      ok: false,
      wrote: false,
      message: '环境变量写入失败',
      errorCode: 'write_failed',
    })
    expect(applyGatewaySecretActionMock).not.toHaveBeenCalled()
  })
})
