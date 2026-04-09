import { describe, expect, it } from 'vitest'

import { prepareWeixinInstallerConfig } from '../weixin-installer-config'

describe('prepareWeixinInstallerConfig', () => {
  it('removes the managed weixin entry when the canonical global plugin is already on disk', () => {
    const result = prepareWeixinInstallerConfig(
      {
        channels: {
          'openclaw-weixin': {
            accountId: 'wx-1',
          },
        },
        plugins: {
          allow: ['openclaw-weixin', 'copilot-proxy'],
          entries: {
            'openclaw-weixin': { enabled: true, installPath: '/tmp/custom/openclaw-weixin' },
            'copilot-proxy': { enabled: true },
          },
          installs: {
            'openclaw-weixin': {
              installPath: '/Users/alice/.openclaw/extensions/openclaw-weixin',
            },
          },
        },
      },
      {
        pluginInstalledOnDisk: true,
      }
    )

    expect(result.changed).toBe(true)
    expect(result.config.channels).toEqual({
      'openclaw-weixin': {
        accountId: 'wx-1',
      },
    })
    expect(result.config.plugins.allow).toEqual(['openclaw-weixin', 'copilot-proxy'])
    expect(result.config.plugins.entries).toEqual({
      'copilot-proxy': { enabled: true },
    })
    expect(result.config.plugins.installs).toEqual({
      'openclaw-weixin': {
        installPath: '/Users/alice/.openclaw/extensions/openclaw-weixin',
      },
    })
  })

  it('leaves the managed weixin entry alone when the canonical global plugin is not on disk', () => {
    const result = prepareWeixinInstallerConfig(
      {
        plugins: {
          entries: {
            'openclaw-weixin': { enabled: true },
          },
        },
      },
      {
        pluginInstalledOnDisk: false,
      }
    )

    expect(result.changed).toBe(false)
    expect(result.config.plugins.entries).toEqual({
      'openclaw-weixin': { enabled: true },
    })
  })
})
