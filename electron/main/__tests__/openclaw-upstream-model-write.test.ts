import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callGatewayRpcViaControlUiBrowserMock } = vi.hoisted(() => ({
  callGatewayRpcViaControlUiBrowserMock: vi.fn(),
}))

vi.mock('../openclaw-control-ui-rpc', () => ({
  callGatewayRpcViaControlUiBrowser: callGatewayRpcViaControlUiBrowserMock,
}))

vi.mock('../cli', () => ({
  readConfig: vi.fn(async () => ({})),
  readEnvFile: vi.fn(async () => ({})),
}))

import { applyModelConfigViaUpstreamControlUi } from '../openclaw-upstream-model-write'

describe('openclaw upstream model write', () => {
  beforeEach(() => {
    callGatewayRpcViaControlUiBrowserMock.mockReset()
  })

  it('applies the default model through Control UI config.apply with a base hash', async () => {
    callGatewayRpcViaControlUiBrowserMock
      .mockResolvedValueOnce({
        valid: true,
        hash: 'hash-123',
        config: {
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5',
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
      })

    const result = await applyModelConfigViaUpstreamControlUi({
      kind: 'default',
      model: 'openai/gpt-5.4-pro',
    })

    expect(result).toEqual({
      ok: true,
      wrote: true,
      gatewayReloaded: true,
      source: 'control-ui-config.apply',
      fallbackUsed: false,
    })
    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      'config.get',
      {},
    )
    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      'config.apply',
      {
        raw: JSON.stringify({
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5.4-pro',
              },
            },
          },
        }, null, 2) + '\n',
        baseHash: 'hash-123',
      },
    )
  })

  it('builds the agent model patch from the upstream config snapshot', async () => {
    callGatewayRpcViaControlUiBrowserMock
      .mockResolvedValueOnce({
        valid: true,
        hash: 'hash-agent',
        config: {
          agents: {
            list: [
              { id: 'main', model: 'openai/gpt-5' },
              { id: 'feishu-work', model: 'minimax/MiniMax-M2.1' },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
      })

    const result = await applyModelConfigViaUpstreamControlUi({
      kind: 'agent-primary',
      agentId: 'feishu-work',
      model: 'minimax/MiniMax-M2.5',
    })

    expect(result.ok).toBe(true)
    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      'config.apply',
      {
        raw: JSON.stringify({
          agents: {
            list: [
              { id: 'main', model: 'openai/gpt-5', default: true },
              { id: 'feishu-work', model: 'minimax/MiniMax-M2.5' },
            ],
          },
          session: {
            dmScope: 'per-account-channel-peer',
          },
          bindings: [],
        }, null, 2) + '\n',
        baseHash: 'hash-agent',
      },
    )
  })

  it('returns a fallback reason when the upstream snapshot is unusable', async () => {
    callGatewayRpcViaControlUiBrowserMock.mockResolvedValueOnce({
      valid: false,
      hash: 'hash-123',
      config: {},
    })

    const result = await applyModelConfigViaUpstreamControlUi({
      kind: 'default',
      model: 'openai/gpt-5.4-pro',
    })

    expect(result).toMatchObject({
      ok: false,
      fallbackUsed: true,
      fallbackReason: 'config.get-invalid',
    })
    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenCalledTimes(1)
  })

  it('passes optional timeout overrides through to both control ui config.get and config.apply calls', async () => {
    callGatewayRpcViaControlUiBrowserMock
      .mockResolvedValueOnce({
        valid: true,
        hash: 'hash-456',
        config: {
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5',
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
      })

    await applyModelConfigViaUpstreamControlUi({
      kind: 'default',
      model: 'openai/gpt-5.4-pro',
      timeoutMs: 35_000,
      loadTimeoutMs: 30_000,
    })

    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      'config.get',
      {},
      {
        timeoutMs: 35_000,
        loadTimeoutMs: 30_000,
      }
    )
    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      'config.apply',
      expect.any(Object),
      {
        timeoutMs: 35_000,
        loadTimeoutMs: 30_000,
      }
    )
  })
})
