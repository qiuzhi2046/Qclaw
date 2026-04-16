import { describe, expect, it } from 'vitest'

import {
  MAX_SUPPORTED_OPENCLAW_VERSION,
  MIN_SUPPORTED_OPENCLAW_VERSION,
  PINNED_OPENCLAW_VERSION,
} from '../openclaw-version-policy'
import { getManagedChannelLifecycleSpec } from '../managed-channel-plugin-lifecycle'
import { applyDingtalkFallbackConfig } from '../dingtalk-official-setup'
import {
  detectFeishuIsolationDrift,
  getFeishuManagedAgentId,
} from '../../lib/feishu-multi-bot-routing'
import {
  OPENCLAW_412_CHANNEL_FIXTURE_VERSION,
  ORIGIN_MAIN_324_CHANNEL_GUARDRAIL_REFERENCES,
  openClaw412DingtalkFallbackConfig,
  openClaw412FeishuMultiBotConfig,
  openClaw412PersonalWeixinConfig,
} from './fixtures/openclaw-2026-4-12-channel-config'

describe('OpenClaw 2026.4.12 managed channel fixtures', () => {
  it('keeps the Windows version policy pinned to 2026.4.12 instead of origin/main 3.24', () => {
    expect(OPENCLAW_412_CHANNEL_FIXTURE_VERSION).toBe('2026.4.12')
    expect(MIN_SUPPORTED_OPENCLAW_VERSION).toBe(OPENCLAW_412_CHANNEL_FIXTURE_VERSION)
    expect(MAX_SUPPORTED_OPENCLAW_VERSION).toBe(OPENCLAW_412_CHANNEL_FIXTURE_VERSION)
    expect(PINNED_OPENCLAW_VERSION).toBe(OPENCLAW_412_CHANNEL_FIXTURE_VERSION)
    expect(ORIGIN_MAIN_324_CHANNEL_GUARDRAIL_REFERENCES.versionPolicy.windowsTarget).toBe(
      OPENCLAW_412_CHANNEL_FIXTURE_VERSION
    )
    expect(ORIGIN_MAIN_324_CHANNEL_GUARDRAIL_REFERENCES.versionPolicy.referenceOnly).toContain(
      '2026.3.24'
    )
  })

  it('documents the 4.12 Feishu multi-bot schema without isolation drift', () => {
    const drift = detectFeishuIsolationDrift(openClaw412FeishuMultiBotConfig)

    expect(openClaw412FeishuMultiBotConfig.channels.feishu.accounts.work).toMatchObject({
      enabled: true,
      appId: 'cli_work',
    })
    expect(openClaw412FeishuMultiBotConfig.session.dmScope).toBe('per-account-channel-peer')
    expect(openClaw412FeishuMultiBotConfig.agents.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: getFeishuManagedAgentId('default') }),
        expect.objectContaining({ id: getFeishuManagedAgentId('work') }),
      ])
    )
    expect(openClaw412FeishuMultiBotConfig.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: getFeishuManagedAgentId('default'),
          match: { channel: 'feishu', accountId: 'default' },
        }),
        expect.objectContaining({
          agentId: getFeishuManagedAgentId('work'),
          match: { channel: 'feishu', accountId: 'work' },
        }),
      ])
    )
    expect(drift).toMatchObject({
      needsRepair: false,
      hasMultipleBots: true,
      dmScopeCorrect: true,
    })
  })

  it('documents the 4.12 personal Weixin schema as account-scoped and interactive-installer managed', () => {
    const spec = getManagedChannelLifecycleSpec('openclaw-weixin')

    expect(spec).toMatchObject({
      channelId: 'openclaw-weixin',
      canonicalPluginId: 'openclaw-weixin',
      entityScope: 'account',
      installStrategy: 'interactive-installer',
    })
    expect(openClaw412PersonalWeixinConfig.channels['openclaw-weixin']).toEqual({
      enabled: true,
      accounts: {
        personal: {
          enabled: true,
          name: '个人微信',
        },
      },
    })
    expect(openClaw412PersonalWeixinConfig.plugins.allow).toEqual(['openclaw-weixin'])
  })

  it('documents the 4.12 DingTalk fallback schema and keeps the fallback patch minimal', () => {
    const nextConfig = applyDingtalkFallbackConfig(
      {
        ...openClaw412DingtalkFallbackConfig,
        plugins: {
          allow: ['other-plugin'],
          installs: {
            'dingtalk-connector': {
              installPath: 'C:/Users/demo/.openclaw/extensions/dingtalk-connector',
            },
          },
        },
      },
      {
        clientId: 'ding_next',
        clientSecret: 'next-secret',
      }
    )

    expect(openClaw412DingtalkFallbackConfig.channels).toHaveProperty('dingtalk-connector')
    expect(openClaw412DingtalkFallbackConfig.channels).not.toHaveProperty('dingtalk')
    expect(nextConfig.channels['dingtalk-connector']).toEqual({
      enabled: true,
      clientId: 'ding_next',
      clientSecret: 'next-secret',
    })
    expect(nextConfig.gateway.http.endpoints.chatCompletions.enabled).toBe(true)
    expect(nextConfig.plugins).toEqual({
      allow: ['other-plugin'],
      installs: {
        'dingtalk-connector': {
          installPath: 'C:/Users/demo/.openclaw/extensions/dingtalk-connector',
        },
      },
    })
  })
})
