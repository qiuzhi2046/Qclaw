import { describe, expect, it } from 'vitest'
import {
  activateFeishuBotConfig,
  addFeishuBotConfig,
  listFeishuBots,
  listResidualLegacyFeishuAgentIds,
  normalizeFeishuOfficialPluginConfig,
  reconcileFeishuOfficialPluginConfig,
  removeFeishuBotConfig,
  removeFeishuBotConfigForPluginState,
  sanitizeFeishuPluginConfig,
} from './feishu-bots'

describe('listFeishuBots', () => {
  it('lists default bot and account bots', () => {
    const config = {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
          accounts: {
            sales: {
              enabled: true,
              name: '销售助手',
              appId: 'cli_sales',
              appSecret: 'secret-sales',
            },
          },
        },
      },
    }

    const bots = listFeishuBots(config)
    expect(bots).toHaveLength(2)
    expect(bots[0].accountId).toBe('default')
    expect(bots[0].agentId).toBe('feishu-default')
    expect(bots[1].accountId).toBe('sales')
    expect(bots[1].agentId).toBe('feishu-sales')
  })

  it('normalizes legacy default bot labels from existing config', () => {
    const config = {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
          name: '默认 Bot',
          accounts: {
            sales: {
              enabled: true,
              name: 'Bot sales',
              appId: 'cli_sales',
              appSecret: 'secret-sales',
            },
          },
        },
      },
    }

    const bots = listFeishuBots(config)
    expect(bots[0].name).toBe('默认机器人')
    expect(bots[1].name).toBe('机器人 sales')
  })
})

describe('listResidualLegacyFeishuAgentIds', () => {
  it('surfaces the stale legacy feishu-bot agent but ignores active managed bot agents', () => {
    const residualIds = listResidualLegacyFeishuAgentIds({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
      agents: {
        list: [
          { id: 'main', model: 'openai/gpt-5' },
          { id: 'feishu-default', model: 'openai/gpt-5.4-pro' },
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
        ],
      },
    })

    expect(residualIds).toEqual(['feishu-bot'])
  })
})

describe('addFeishuBotConfig', () => {
  it('adds a new feishu account under channels.feishu.accounts', () => {
    const { nextConfig, accountId } = addFeishuBotConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
          },
        },
      },
      {
        name: '客服机器人',
        appId: 'cli_service',
        appSecret: 'secret-service',
      }
    )

    expect(accountId).toBeTruthy()
    expect(nextConfig.channels.feishu.accounts[accountId].appId).toBe('cli_service')
    expect(nextConfig.channels.feishu.accounts[accountId].dmPolicy).toBe('pairing')
    expect(nextConfig.plugins).toBeUndefined()
    expect(nextConfig.session.dmScope).toBe('per-account-channel-peer')
    expect(nextConfig.agents.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'feishu-default' }),
        expect.objectContaining({ id: `feishu-${accountId}` }),
      ])
    )
    expect(nextConfig.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ match: { channel: 'feishu', accountId: 'default' } }),
        expect.objectContaining({ match: { channel: 'feishu', accountId } }),
      ])
    )
  })

  it('preserves SecretRef-style secrets for newly added account bots', () => {
    const secretRef = {
      source: 'file',
      provider: 'lark-secrets',
      id: '/lark/appSecret',
    }

    const { nextConfig, accountId } = addFeishuBotConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
          },
        },
      },
      {
        name: '客服机器人',
        appId: 'cli_service',
        appSecret: secretRef,
      }
    )

    expect(nextConfig.channels.feishu.accounts[accountId].appSecret).toEqual(secretRef)
  })
})

describe('removeFeishuBotConfig', () => {
  it('removes non-default account bot', () => {
    const next = removeFeishuBotConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            accounts: {
              bot1: {
                enabled: true,
                appId: 'cli_1',
                appSecret: 'secret-1',
              },
              bot2: {
                enabled: true,
                appId: 'cli_2',
                appSecret: 'secret-2',
              },
            },
          },
        },
      },
      'bot1'
    )

    expect(next.channels.feishu.accounts.bot1).toBeUndefined()
    expect(next.channels.feishu.accounts.bot2).toBeDefined()
    expect(next.bindings).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ match: { channel: 'feishu', accountId: 'bot1' } }),
      ])
    )
    expect(next.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ match: { channel: 'feishu', accountId: 'bot2' } }),
      ])
    )
  })

  it('clears default bot credentials when deleting default', () => {
    const next = removeFeishuBotConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
          },
        },
      },
      'default'
    )

    expect(next.channels.feishu.appId).toBeUndefined()
    expect(next.channels.feishu.appSecret).toBeUndefined()
    expect(next.channels.feishu.enabled).toBe(false)
  })
})

describe('activateFeishuBotConfig', () => {
  it('keeps multi-bot credentials intact and only heals managed isolation state', () => {
    const next = activateFeishuBotConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
            accounts: {
              support: {
                enabled: true,
                name: '客服机器人',
                appId: 'cli_support',
                appSecret: 'secret-support',
              },
            },
          },
        },
      },
      'support'
    )

    expect(next.channels.feishu.appId).toBe('cli_default')
    expect(next.channels.feishu.appSecret).toBe('secret-default')
    expect(next.channels.feishu.accounts.support.appId).toBe('cli_support')
    expect(next.session.dmScope).toBe('per-account-channel-peer')
    expect(next.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'feishu-default', match: { channel: 'feishu', accountId: 'default' } }),
        expect.objectContaining({ agentId: 'feishu-support', match: { channel: 'feishu', accountId: 'support' } }),
      ])
    )
    expect(next.plugins).toBeUndefined()
  })

  it('accepts SecretRef-style secrets for account bots', () => {
    const next = activateFeishuBotConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
            accounts: {
              support: {
                enabled: true,
                name: '客服机器人',
                appId: 'cli_support',
                appSecret: {
                  source: 'file',
                  provider: 'lark-secrets',
                  id: '/lark/appSecret',
                },
              },
            },
          },
        },
      },
      'support'
    )

    expect(next.channels.feishu.accounts.support.appSecret).toEqual({
      source: 'file',
      provider: 'lark-secrets',
      id: '/lark/appSecret',
    })
    expect(next.session.dmScope).toBe('per-account-channel-peer')
  })
})

describe('sanitizeFeishuPluginConfig', () => {
  it('removes legacy feishu plugin residue while preserving unrelated plugin records', () => {
    const next = sanitizeFeishuPluginConfig({
      plugins: {
        allow: ['feishu', 'feishu-openclaw-plugin', 'openclaw-lark'],
        entries: {
          feishu: { enabled: false },
          'feishu-openclaw-plugin': { enabled: false },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          feishu: { spec: '@openclaw/feishu' },
          'feishu-openclaw-plugin': { spec: '@larksuiteoapi/feishu-openclaw-plugin' },
          'openclaw-lark': { spec: '@larksuite/openclaw-lark' },
        },
      },
    })

    expect(next.plugins.allow).toEqual(['openclaw-lark'])
    expect(next.plugins.entries.feishu).toEqual({ enabled: false })
    expect(next.plugins.entries['feishu-openclaw-plugin']).toBeUndefined()
    expect(next.plugins.entries['openclaw-lark']).toBeDefined()
    expect(next.plugins.installs.feishu).toBeUndefined()
    expect(next.plugins.installs['feishu-openclaw-plugin']).toBeUndefined()
    expect(next.plugins.installs['openclaw-lark']).toBeDefined()
  })
})

describe('reconcileFeishuOfficialPluginConfig', () => {
  it('removes legacy feishu plugin residue but preserves openclaw-lark when a bot exists', () => {
    const next = reconcileFeishuOfficialPluginConfig({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
      plugins: {
        allow: ['feishu', 'openclaw-lark'],
        entries: {
          feishu: { enabled: false },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            source: 'npm',
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    })

    expect(next.plugins.allow).not.toContain('feishu')
    expect(next.plugins.allow).toContain('openclaw-lark')
    expect(next.plugins.entries.feishu).toEqual({ enabled: false })
    expect(next.plugins.entries['openclaw-lark']).toBeDefined()
    expect(next.plugins.installs['openclaw-lark']).toBeDefined()
    expect(next.session.dmScope).toBe('per-account-channel-peer')
    expect(next.agents.list).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'feishu-default' })]))
    expect(next.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'feishu-default', match: { channel: 'feishu', accountId: 'default' } }),
      ])
    )
  })

  it('preserves openclaw-lark install record in config', () => {
    const next = reconcileFeishuOfficialPluginConfig({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: 'secret-default',
        },
      },
      plugins: {
        installs: {
          'openclaw-lark': {
            source: 'npm',
            spec: '@larksuite/openclaw-lark',
            installPath: '/Users/alice/.openclaw/extensions/openclaw-lark',
            version: '2026.3.15',
          },
        },
      },
    })

    expect(next.plugins.installs['openclaw-lark']).toBeDefined()
  })
})

describe('normalizeFeishuOfficialPluginConfig', () => {
  it('strips openclaw-lark when the official plugin is not installed on disk', () => {
    const next = normalizeFeishuOfficialPluginConfig(
      {
        channels: {
          feishu: {
            enabled: false,
          },
        },
        plugins: {
          allow: ['openclaw-lark'],
          entries: {
            'openclaw-lark': { enabled: true },
          },
          installs: {
            'openclaw-lark': {
              source: 'npm',
              spec: '@larksuite/openclaw-lark',
            },
          },
        },
      },
      false
    )

    expect(next.plugins.allow).toEqual([])
    expect(next.plugins.entries.feishu).toEqual({ enabled: false })
    expect(next.plugins.entries['openclaw-lark']).toBeUndefined()
    expect(next.plugins.installs['openclaw-lark']).toBeUndefined()
  })

  it('preserves openclaw-lark when the official plugin is installed on disk', () => {
    const next = normalizeFeishuOfficialPluginConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
          },
        },
        plugins: {
          allow: ['openclaw-lark'],
          entries: {
            'openclaw-lark': { enabled: true },
          },
        },
      },
      true
    )

    expect(next.plugins.allow).toContain('openclaw-lark')
    expect(next.plugins.entries.feishu).toEqual({ enabled: false })
    expect(next.plugins.entries['openclaw-lark']).toBeDefined()
    expect(next.agents.list).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'feishu-default' })]))
  })
})

describe('removeFeishuBotConfigForPluginState', () => {
  it('removes bot credentials but preserves openclaw-lark when plugin exists on disk', () => {
    const next = removeFeishuBotConfigForPluginState(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
          },
        },
        plugins: {
          allow: ['feishu', 'openclaw-lark'],
          entries: {
            feishu: { enabled: false },
            'openclaw-lark': { enabled: true },
          },
        },
      },
      'default',
      true
    )

    expect(next.channels.feishu.appId).toBeUndefined()
    expect(next.channels.feishu.enabled).toBe(false)
    expect(next.plugins.allow).toContain('openclaw-lark')
    expect(next.plugins.allow).not.toContain('feishu')
    expect(next.plugins.entries.feishu).toEqual({ enabled: false })
  })

  it('removes openclaw-lark residue after deleting the last bot when plugin is missing on disk', () => {
    const next = removeFeishuBotConfigForPluginState(
      {
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_default',
            appSecret: 'secret-default',
          },
        },
        plugins: {
          allow: ['openclaw-lark'],
          entries: {
            'openclaw-lark': { enabled: true },
          },
          installs: {
            'openclaw-lark': { source: 'npm', spec: '@larksuite/openclaw-lark' },
          },
        },
      },
      'default',
      false
    )

    expect(next.channels.feishu.appId).toBeUndefined()
    expect(next.channels.feishu.enabled).toBe(false)
    expect(next.plugins.allow).toEqual([])
    expect(next.plugins.entries.feishu).toEqual({ enabled: false })
    expect(next.plugins.entries['openclaw-lark']).toBeUndefined()
    expect(next.plugins.installs['openclaw-lark']).toBeUndefined()
  })
})
