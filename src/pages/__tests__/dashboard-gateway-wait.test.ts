import { describe, expect, it, vi } from 'vitest'
import { waitForDashboardGatewayRunning } from '../Dashboard'

const FAST_POLL_POLICY = {
  timeoutMs: 50,
  initialIntervalMs: 1,
  maxIntervalMs: 1,
  backoffFactor: 1,
} as const

describe('waitForDashboardGatewayRunning', () => {
  it('waits until gateway health reports running', async () => {
    const gatewayHealth = vi
      .fn()
      .mockResolvedValueOnce({ running: false, summary: '启动中' })
      .mockResolvedValueOnce({ running: false, summary: '恢复中' })
      .mockResolvedValueOnce({ running: true, summary: 'Gateway 已确认可用' })

    const result = await waitForDashboardGatewayRunning(
      { gatewayHealth },
      { policy: FAST_POLL_POLICY }
    )

    expect(result).toEqual({
      ok: true,
      health: {
        running: true,
        summary: 'Gateway 已确认可用',
      },
    })
    expect(gatewayHealth).toHaveBeenCalledTimes(3)
  })

  it('returns the last health summary when readiness times out', async () => {
    const gatewayHealth = vi
      .fn()
      .mockResolvedValue({ running: false, summary: 'Gateway 仍在恢复中' })

    const result = await waitForDashboardGatewayRunning(
      { gatewayHealth },
      { policy: FAST_POLL_POLICY }
    )

    expect(result).toEqual({
      ok: false,
      message: 'Gateway 仍在恢复中',
    })
  })
})
