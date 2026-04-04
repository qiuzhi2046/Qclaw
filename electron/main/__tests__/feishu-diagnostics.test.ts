import { describe, expect, it, vi } from 'vitest'

import {
  buildFeishuDiagnosticMessageText,
  getBotLabel,
  listenForFeishuBotDiagnosticActivity,
  sendFeishuDiagnosticMessage,
} from '../feishu-diagnostics-core'

describe('buildFeishuDiagnosticMessageText', () => {
  it('includes the key bot and machine identity fields', () => {
    const text = buildFeishuDiagnosticMessageText({
      botLabel: '默认 Bot',
      accountId: 'default',
      agentId: 'feishu-default',
      machineLabel: 'macbook-pro',
      traceId: 'trace-123',
      sentAt: '2026-03-27T12:34:56.000Z',
    })

    expect(text).toContain('Qclaw 故障排查定位消息')
    expect(text).toContain('机器人: 默认 Bot')
    expect(text).toContain('accountId: default')
    expect(text).toContain('agentId: feishu-default')
    expect(text).toContain('机器: macbook-pro')
    expect(text).toContain('traceId: trace-123')
  })
})

describe('getBotLabel', () => {
  it('normalizes legacy default bot labels from persisted data', () => {
    expect(getBotLabel('default', '默认 Bot')).toBe('默认机器人')
    expect(getBotLabel('sales', 'Bot sales')).toBe('机器人 sales')
  })
})

describe('listenForFeishuBotDiagnosticActivity', () => {
  it('returns detected when workspace activity advances after listening starts', async () => {
    const takeSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        sources: [
          {
            kind: 'workspace',
            exists: true,
            latestMtimeMs: 100,
            latestPath: '/Users/demo/.openclaw/workspace-feishu-default/session.json',
          },
          {
            kind: 'pairing-store',
            exists: false,
            latestMtimeMs: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        sources: [
          {
            kind: 'workspace',
            exists: true,
            latestMtimeMs: 180,
            latestPath: '/Users/demo/.openclaw/workspace-feishu-default/session.json',
          },
          {
            kind: 'pairing-store',
            exists: false,
            latestMtimeMs: 0,
          },
        ],
      })

    const result = await listenForFeishuBotDiagnosticActivity(
      { accountId: 'default', timeoutMs: 15_000, pollIntervalMs: 1000 },
      {
        now: vi
          .fn()
          .mockReturnValueOnce(0)
          .mockReturnValueOnce(1_000)
          .mockReturnValueOnce(2_000)
          .mockReturnValueOnce(2_001),
        wait: vi.fn(async () => undefined),
        takeSnapshot,
      }
    )

    expect(result.detected).toBe(true)
    expect(result.activityKind).toBe('workspace')
    expect(result.evidencePath).toBe('/Users/demo/.openclaw/workspace-feishu-default/session.json')
    expect(result.summary).toContain('已在当前机器检测到')
  })

  it('returns timeout when no local activity is observed during the window', async () => {
    const takeSnapshot = vi.fn().mockResolvedValue({
      sources: [
        {
          kind: 'workspace',
          exists: true,
          latestMtimeMs: 100,
          latestPath: '/Users/demo/.openclaw/workspace-feishu-default/session.json',
        },
      ],
    })

    const result = await listenForFeishuBotDiagnosticActivity(
      { accountId: 'default', timeoutMs: 5_000, pollIntervalMs: 1000 },
      {
        now: vi
          .fn()
          .mockReturnValueOnce(0)
          .mockReturnValueOnce(1_000)
          .mockReturnValueOnce(2_000)
          .mockReturnValueOnce(3_000)
          .mockReturnValueOnce(4_000)
          .mockReturnValueOnce(5_000),
        wait: vi.fn(async () => undefined),
        takeSnapshot,
      }
    )

    expect(result.detected).toBe(false)
    expect(result.activityKind).toBe('none')
    expect(result.summary).toContain('监听窗口内未检测到')
  })

  it('does not treat the initial snapshot itself as a fresh hit when no later activity advances', async () => {
    const takeSnapshot = vi.fn().mockResolvedValue({
      sources: [
        {
          kind: 'workspace',
          exists: true,
          latestMtimeMs: 1_500,
          latestPath: '/Users/demo/.openclaw/workspace-feishu-default/session.json',
        },
      ],
    })

    const result = await listenForFeishuBotDiagnosticActivity(
      { accountId: 'default', timeoutMs: 5_000, pollIntervalMs: 1000 },
      {
        now: vi
          .fn()
          .mockReturnValueOnce(1_000)
          .mockReturnValueOnce(2_000)
          .mockReturnValueOnce(3_000)
          .mockReturnValueOnce(4_000)
          .mockReturnValueOnce(5_000)
          .mockReturnValueOnce(6_000),
        wait: vi.fn(async () => undefined),
        takeSnapshot,
      }
    )

    expect(result.detected).toBe(false)
    expect(result.activityKind).toBe('none')
    expect(result.summary).toContain('监听窗口内未检测到')
  })
})

describe('sendFeishuDiagnosticMessage', () => {
  it('sends a text diagnostic message to the selected paired user', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          code: 0,
          app_access_token: 'token-123',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          code: 0,
          data: {
            message_id: 'om_123',
          },
        },
      })

    const result = await sendFeishuDiagnosticMessage(
      {
        accountId: 'default',
        openId: 'ou_123',
        recipientName: 'Alice',
        botLabel: '默认 Bot',
      },
      {
        nowIso: () => '2026-03-27T12:34:56.000Z',
        createTraceId: () => 'trace-123',
        getMachineLabel: () => 'macbook-pro',
        resolveCredentials: async () => ({
          appId: 'cli_test',
          appSecret: 'secret',
          baseUrl: 'https://open.feishu.cn',
        }),
        requestJson,
      }
    )

    expect(result.ok).toBe(true)
    expect(result.messageId).toBe('om_123')
    expect(result.summary).toContain('定位消息已发送')
    expect(result.sentText).toContain('traceId: trace-123')
    expect(requestJson).toHaveBeenLastCalledWith(
      'POST',
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      expect.objectContaining({
        Authorization: 'Bearer token-123',
        'Content-Type': 'application/json',
      }),
      expect.stringContaining('"receive_id":"ou_123"')
    )
  })
})
