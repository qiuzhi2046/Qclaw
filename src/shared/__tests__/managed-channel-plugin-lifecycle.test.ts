import { describe, expect, it } from 'vitest'

import {
  getManagedChannelLifecycleSpec,
  listManagedChannelLifecycleSpecs,
  reconcileManagedChannelPluginConfig,
} from '../managed-channel-plugin-lifecycle'
import {
  openClaw412FeishuMultiBotConfig,
  openClaw412PersonalWeixinConfig,
} from './fixtures/openclaw-2026-4-12-channel-config'

function cloneFixture<T>(value: T): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>
}

describe('managed channel plugin lifecycle shared contract', () => {
  it('declares split cleanup ranges for every managed channel while preserving compatibility ids', () => {
    const specs = listManagedChannelLifecycleSpecs()

    expect(specs.map((spec) => spec.channelId)).toEqual([
      'feishu',
      'wecom',
      'dingtalk',
      'qqbot',
      'openclaw-weixin',
    ])
    expect(specs.every((spec) => spec.defaultReconcileScope === 'plugins-only')).toBe(true)

    expect(getManagedChannelLifecycleSpec('feishu')).toMatchObject({
      canonicalPluginId: 'openclaw-lark',
      legacyCleanupPluginIds: ['feishu', 'feishu-openclaw-plugin'],
      orphanPruneCandidateIds: ['feishu', 'feishu-openclaw-plugin', 'openclaw-lark'],
      cleanupChannelIds: ['feishu'],
    })
    expect(getManagedChannelLifecycleSpec('openclaw-weixin')).toMatchObject({
      canonicalPluginId: 'openclaw-weixin',
      legacyCleanupPluginIds: [],
      orphanPruneCandidateIds: ['openclaw-weixin'],
      cleanupChannelIds: ['openclaw-weixin'],
    })
    expect(getManagedChannelLifecycleSpec('dingtalk')).toMatchObject({
      canonicalPluginId: 'dingtalk-connector',
      legacyCleanupPluginIds: ['dingtalk'],
      orphanPruneCandidateIds: ['dingtalk-connector', 'dingtalk'],
      cleanupChannelIds: ['dingtalk-connector', 'dingtalk'],
    })
  })

  it('reconciles generic managed plugin config in plugins-only scope without deleting channel data', () => {
    const beforeConfig = {
      channels: {
        wecom: {
          enabled: true,
          botId: 'bot_123',
          secret: 'secret_456',
        },
      },
      plugins: {
        allow: ['wecom', 'wecom-openclaw-plugin'],
        entries: {
          wecom: {
            enabled: true,
          },
        },
        installs: {
          'wecom-openclaw-plugin': {
            installPath: 'C:/Users/demo/.openclaw/extensions/.openclaw-install-stage-abcd',
          },
        },
      },
    }

    const result = reconcileManagedChannelPluginConfig(
      'wecom',
      beforeConfig,
      { installedOnDisk: true },
      { scope: 'plugins-only' }
    )

    expect(result).toMatchObject({
      changed: true,
      scope: 'plugins-only',
      configReadFailed: false,
      removedFrom: {
        allow: ['wecom'],
        entries: ['wecom'],
        installs: ['wecom-openclaw-plugin'],
        channels: [],
      },
    })
    expect(result?.config.channels).toEqual(beforeConfig.channels)
    expect(result?.config.plugins.allow).toEqual(['wecom-openclaw-plugin'])
    expect(result?.config.plugins.entries).toEqual({})
    expect(result?.config.plugins.installs).toEqual({})
  })

  it('fails closed on config read failure instead of synthesizing a plugin write', () => {
    const beforeConfig = {
      channels: {
        qqbot: {
          enabled: true,
          appId: '1024',
          clientSecret: 'qq-secret',
          allowFrom: ['*'],
        },
      },
      plugins: {
        allow: ['qqbot'],
      },
    }

    const result = reconcileManagedChannelPluginConfig(
      'qqbot',
      beforeConfig,
      {
        installedOnDisk: true,
        configReadFailed: true,
      }
    )

    expect(result).toEqual({
      config: beforeConfig,
      changed: false,
      scope: 'plugins-only',
      configReadFailed: true,
      removedFrom: {
        allow: [],
        entries: [],
        installs: [],
        channels: [],
      },
    })
  })

  it('keeps personal Weixin account state untouched until the official plugin is confirmed on disk', () => {
    const beforeConfig = cloneFixture(openClaw412PersonalWeixinConfig)

    const notInstalled = reconcileManagedChannelPluginConfig(
      'openclaw-weixin',
      beforeConfig,
      { installedOnDisk: false }
    )
    expect(notInstalled).toMatchObject({
      changed: false,
      removedFrom: {
        allow: [],
        entries: [],
        installs: [],
        channels: [],
      },
    })
    expect(notInstalled?.config).toEqual(beforeConfig)

    const installed = reconcileManagedChannelPluginConfig(
      'openclaw-weixin',
      beforeConfig,
      { installedOnDisk: true }
    )
    expect(installed).toMatchObject({
      changed: false,
      removedFrom: {
        allow: [],
        entries: [],
        installs: [],
        channels: [],
      },
    })
    expect(installed?.config.channels['openclaw-weixin'].accounts).toEqual(
      beforeConfig.channels['openclaw-weixin'].accounts
    )
  })

  it('keeps Feishu shared reconciliation as a no-op placeholder for the official adapter phase', () => {
    const beforeConfig = cloneFixture(openClaw412FeishuMultiBotConfig)

    const result = reconcileManagedChannelPluginConfig(
      'feishu',
      beforeConfig,
      { installedOnDisk: true }
    )

    expect(result).toMatchObject({
      changed: false,
      scope: 'plugins-only',
      configReadFailed: false,
      removedFrom: {
        allow: [],
        entries: [],
        installs: [],
        channels: [],
      },
    })
    expect(result?.config).toEqual(beforeConfig)
  })
})
