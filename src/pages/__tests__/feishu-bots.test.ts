import { describe, expect, it } from 'vitest'

import { reconcileFeishuOfficialPluginConfig } from '../feishu-bots'

describe('reconcileFeishuOfficialPluginConfig', () => {
  it('aligns feishu config with the current openclaw runtime schema defaults', () => {
    const nextConfig = reconcileFeishuOfficialPluginConfig({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_test',
          appSecret: 'secret',
          domain: 'feishu',
          dmPolicy: 'pairing',
          groupPolicy: 'open',
          streaming: true,
          blockStreaming: true,
          accounts: {
            work: {
              enabled: true,
              appId: 'cli_work',
              appSecret: 'work-secret',
              blockStreaming: false,
            },
          },
        },
      },
    })

    expect(nextConfig.channels.feishu).toMatchObject({
      connectionMode: 'websocket',
      webhookPath: '/feishu/events',
      reactionNotifications: 'own',
      typingIndicator: true,
      resolveSenderNames: true,
      blockStreamingCoalesce: {
        enabled: true,
      },
    })
    expect(nextConfig.channels.feishu).not.toHaveProperty('blockStreaming')
    expect(nextConfig.channels.feishu.accounts.work).toMatchObject({
      blockStreamingCoalesce: {
        enabled: false,
      },
    })
    expect(nextConfig.channels.feishu.accounts.work).not.toHaveProperty('blockStreaming')
  })
})
