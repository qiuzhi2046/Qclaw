import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEISHU_CHANNEL_SETTINGS,
  applyDingtalkFallbackConfig,
  applyChannelConfig,
  buildChannelOnboardOptions,
  getChannelDefinition,
  getChannelPluginInstallLabel,
  isChannelPluginConfigured,
  isChannelFormComplete,
  isPluginAlreadyInstalledError,
  isNonFatalOnboardError,
  removeWeixinChannelAccountConfig,
  resolveChannelPluginAllowId,
  stripLegacyOpenClawRootKeys,
  syncWeixinChannelAccounts,
  validateChannelForm,
} from '../openclaw-channel-registry'

describe('openclaw-channel-registry', () => {
  it('derives plugin allow ids from the same schema that defines package names', () => {
    const channel = getChannelDefinition('feishu')
    expect(channel).toBeTruthy()
    expect(resolveChannelPluginAllowId(channel!)).toBeUndefined()
    expect(getChannelPluginInstallLabel(channel!)).toBe('官方插件')
  })

  it('uses schema-based completion instead of a hard-coded >5 length rule', () => {
    const channel = getChannelDefinition('wecom')
    expect(
      isChannelFormComplete(channel, {
        botId: 'id',
        secret: 'x',
      })
    ).toBe(true)
  })

  it('registers personal WeChat as a zero-field managed channel', () => {
    const channel = getChannelDefinition('openclaw-weixin')
    expect(channel).toBeTruthy()
    expect(channel?.name).toBe('个人微信')
    expect(channel?.fields).toEqual([])
    expect(channel?.skipPairing).toBe(true)
    expect(channel?.plugin?.packageName).toBe('@tencent-weixin/openclaw-weixin')
  })

  it('pins QQ plugin allow id to the manifest id instead of the npm versioned specifier', () => {
    const channel = getChannelDefinition('qqbot')
    expect(channel).toBeTruthy()
    expect(channel?.plugin?.packageName).toBe('@tencent-connect/openclaw-qqbot@latest')
    expect(resolveChannelPluginAllowId(channel!)).toBe('openclaw-qqbot')
    expect(channel?.plugin?.cleanupPluginIds).toEqual([
      'qqbot',
      'openclaw-qq',
      '@sliverp/qqbot',
      '@tencent-connect/qqbot',
      '@tencent-connect/openclaw-qq',
      '@tencent-connect/openclaw-qqbot',
      'openclaw-qqbot',
    ])
  })

  it('detects when a managed channel plugin is already configured in openclaw.json', () => {
    expect(
      isChannelPluginConfigured(
        {
          plugins: {
            installs: {
              'openclaw-qqbot': {
                installPath: '/Users/demo/.openclaw/extensions/openclaw-qqbot',
              },
            },
          },
        },
        'qqbot'
      )
    ).toBe(true)

    expect(
      isChannelPluginConfigured(
        {
          plugins: {
            entries: {
              'openclaw-qqbot': {
                enabled: true,
              },
            },
          },
        },
        'qqbot'
      )
    ).toBe(true)

    expect(isChannelPluginConfigured({}, 'qqbot')).toBe(false)
  })

  it('returns field-level validation errors from the shared schema', () => {
    const channel = getChannelDefinition('feishu')
    expect(validateChannelForm(channel, { appId: 'cli_xxx', appSecret: '' })).toEqual({
      ok: false,
      values: {
        appId: 'cli_xxx',
        appSecret: '',
      },
      fieldErrors: {
        appSecret: '请输入App Secret',
      },
    })
  })

  it('applies feishu config with centralized defaults and preserves existing accounts', () => {
    const nextConfig = applyChannelConfig(
      {
        channels: {
          feishu: {
            accounts: {
              secondary: {
                appId: 'cli_existing',
              },
            },
          },
        },
      },
      'feishu',
      {
        appId: 'cli_primary',
        appSecret: 'secret',
      }
    )

    expect(nextConfig.channels.feishu).toMatchObject({
      enabled: true,
      appId: 'cli_primary',
      appSecret: 'secret',
      dmPolicy: DEFAULT_FEISHU_CHANNEL_SETTINGS.dmPolicy,
      domain: DEFAULT_FEISHU_CHANNEL_SETTINGS.domain,
      groupPolicy: DEFAULT_FEISHU_CHANNEL_SETTINGS.groupPolicy,
      streaming: DEFAULT_FEISHU_CHANNEL_SETTINGS.streaming,
      blockStreaming: DEFAULT_FEISHU_CHANNEL_SETTINGS.blockStreaming,
    })
    expect(nextConfig.channels.feishu.accounts.secondary.appId).toBe('cli_existing')
    expect(nextConfig.plugins).toBeUndefined()
  })

  it('auto-heals legacy allowlist dmPolicy without any allowFrom users', () => {
    const nextConfig = applyChannelConfig(
      {
        channels: {
          feishu: {
            dmPolicy: 'allowlist',
            allowFrom: [],
          },
        },
      },
      'feishu',
      {
        appId: 'cli_primary',
        appSecret: 'secret',
      }
    )

    expect(nextConfig.channels.feishu.dmPolicy).toBe('pairing')
    expect(nextConfig.channels.feishu.allowFrom).toBeUndefined()
  })

  it('preserves explicit allowlist dmPolicy when allowFrom already has users', () => {
    const nextConfig = applyChannelConfig(
      {
        channels: {
          feishu: {
            dmPolicy: 'allowlist',
            allowFrom: ['ou_owner'],
          },
        },
      },
      'feishu',
      {
        appId: 'cli_primary',
        appSecret: 'secret',
      }
    )

    expect(nextConfig.channels.feishu.dmPolicy).toBe('allowlist')
    expect(nextConfig.channels.feishu.allowFrom).toEqual(['ou_owner'])
  })

  it('refuses to write invalid channel config through applyChannelConfig', () => {
    expect(() =>
      applyChannelConfig(
        {},
        'wecom',
        {
          botId: 'bot',
          secret: '',
        }
      )
    ).toThrow('请输入Secret')
  })

  it('strips invalid legacy root keys without touching nested channel data', () => {
    expect(
      stripLegacyOpenClawRootKeys({
        dmPolicy: 'pairing',
        groupPolicy: 'open',
        streaming: true,
        channels: {
          feishu: {
            appId: 'cli_keep',
          },
        },
      })
    ).toEqual({
      channels: {
        feishu: {
          appId: 'cli_keep',
        },
      },
    })
  })

  it('centralizes onboard defaults and structured non-fatal error classification', () => {
    expect(buildChannelOnboardOptions('darwin')).toEqual({
      acceptRisk: true,
      installDaemon: true,
      skipChannels: true,
      skipSkills: true,
    })
    expect(isNonFatalOnboardError({ errorCode: 'gateway_closed', stderr: '' })).toBe(true)
    expect(isNonFatalOnboardError('The gateway closed unexpectedly')).toBe(true)
    expect(isNonFatalOnboardError('hard failure')).toBe(false)
    expect(isPluginAlreadyInstalledError('Plugin already exists in manifest')).toBe(true)
  })

  it('applies dingtalk config without copying gateway token into the channel config', () => {
    const nextConfig = applyChannelConfig(
      {
        gateway: {
          auth: { mode: 'token', token: 'my-gw-token-123' },
        },
      },
      'dingtalk',
      {
        clientId: 'dingxxxxxxxxxx',
        clientSecret: 'secret123',
      }
    )

    expect(nextConfig.channels['dingtalk-connector']).toMatchObject({
      enabled: true,
      clientId: 'dingxxxxxxxxxx',
      clientSecret: 'secret123',
    })
    expect(nextConfig.channels['dingtalk-connector']).not.toHaveProperty('gatewayToken')
    expect(nextConfig.gateway.http.endpoints.chatCompletions.enabled).toBe(true)
    expect(nextConfig.plugins.allow).toContain('dingtalk-connector')
  })

  it('applies dingtalk config without gatewayToken when gateway auth is absent', () => {
    const nextConfig = applyChannelConfig(
      {},
      'dingtalk',
      {
        clientId: 'dingxxxxxxxxxx',
        clientSecret: 'secret123',
      }
    )

    expect(nextConfig.channels['dingtalk-connector']).toEqual({
      enabled: true,
      clientId: 'dingxxxxxxxxxx',
      clientSecret: 'secret123',
    })
    expect(nextConfig.gateway.http.endpoints.chatCompletions.enabled).toBe(true)
  })

  it('keeps DingTalk Phase 0 fallback scoped to the minimal channel and gateway patch', () => {
    const nextConfig = applyDingtalkFallbackConfig(
      {
        plugins: {
          allow: ['other-plugin'],
          installs: {
            'dingtalk-connector': {
              installPath: '/Users/demo/.openclaw/extensions/dingtalk-connector',
            },
          },
        },
      },
      {
        clientId: 'dingxxxxxxxxxx',
        clientSecret: 'secret123',
      }
    )

    expect(nextConfig.channels['dingtalk-connector']).toMatchObject({
      enabled: true,
      clientId: 'dingxxxxxxxxxx',
      clientSecret: 'secret123',
    })
    expect(nextConfig.gateway.http.endpoints.chatCompletions.enabled).toBe(true)
    expect(nextConfig.plugins).toEqual({
      allow: ['other-plugin'],
      installs: {
        'dingtalk-connector': {
          installPath: '/Users/demo/.openclaw/extensions/dingtalk-connector',
        },
      },
    })
  })

  it('applies qqbot config using the new clientSecret schema', () => {
    const nextConfig = applyChannelConfig(
      {},
      'qqbot',
      {
        appId: '1024',
        appSecret: 'qq-secret',
      }
    )

    expect(nextConfig.channels.qqbot).toEqual({
      enabled: true,
      appId: '1024',
      clientSecret: 'qq-secret',
      allowFrom: ['*'],
    })
    expect(nextConfig.plugins.allow).toContain('openclaw-qqbot')
  })

  it('preserves existing qqbot accounts and allowFrom entries while dropping legacy appSecret keys', () => {
    const nextConfig = applyChannelConfig(
      {
        channels: {
          qqbot: {
            enabled: false,
            appId: 'old-app',
            appSecret: 'legacy-secret',
            allowFrom: ['USER_A'],
            accounts: {
              bot2: {
                appId: 'bot-2',
                clientSecret: 'bot-2-secret',
              },
            },
          },
        },
      },
      'qqbot',
      {
        appId: 'new-app',
        appSecret: 'new-secret',
      }
    )

    expect(nextConfig.channels.qqbot).toEqual({
      enabled: true,
      appId: 'new-app',
      clientSecret: 'new-secret',
      allowFrom: ['USER_A'],
      accounts: {
        bot2: {
          appId: 'bot-2',
          clientSecret: 'bot-2-secret',
        },
      },
    })
  })

  it('applies personal WeChat config as an enabled account container', () => {
    const nextConfig = applyChannelConfig({}, 'openclaw-weixin', {})

    expect(nextConfig.channels['openclaw-weixin']).toEqual({
      enabled: true,
      accounts: {},
    })
    expect(nextConfig.plugins.allow).toContain('openclaw-weixin')
  })

  it('syncs personal WeChat accounts into config without overwriting existing names or enabled flags', () => {
    const nextConfig = syncWeixinChannelAccounts(
      {
        channels: {
          'openclaw-weixin': {
            enabled: false,
            accounts: {
              existing: {
                enabled: false,
                name: '旧名称',
              },
            },
          },
        },
      },
      [
        { accountId: 'existing', name: '新名称', enabled: true },
        { accountId: 'new-account', enabled: true },
      ]
    )

    expect(nextConfig.channels['openclaw-weixin']).toEqual({
      enabled: true,
      accounts: {
        existing: {
          enabled: false,
          name: '旧名称',
        },
        'new-account': {
          enabled: true,
          name: 'new-account',
        },
      },
    })
  })

  it('removes personal WeChat account config and drops the channel when it becomes empty', () => {
    const nextConfig = removeWeixinChannelAccountConfig(
      {
        plugins: {
          allow: ['openclaw-weixin', 'other-plugin'],
        },
        channels: {
          'openclaw-weixin': {
            enabled: true,
            accounts: {
              only: {
                enabled: true,
              },
            },
          },
        },
      },
      'only'
    )

    expect(nextConfig.channels?.['openclaw-weixin']).toBeUndefined()
    expect(nextConfig.plugins.allow).toEqual(['other-plugin'])
  })
})
