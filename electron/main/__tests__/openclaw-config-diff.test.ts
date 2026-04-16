import { describe, expect, it } from 'vitest'
import { collectChangedJsonPaths } from '../openclaw-config-diff'

describe('collectChangedJsonPaths', () => {
  it('collects only the changed leaf paths from nested config writes', () => {
    const previousConfig = {
      channels: {
        feishu: {
          appId: 'old-app',
          appSecret: 'old-secret',
        },
      },
      plugins: {
        allow: ['a'],
      },
    }
    const nextConfig = {
      channels: {
        feishu: {
          appId: 'new-app',
          appSecret: 'old-secret',
        },
      },
      plugins: {
        allow: ['a', 'b'],
      },
    }

    expect(collectChangedJsonPaths(previousConfig, nextConfig)).toEqual([
      '$.channels.feishu.appId',
      '$.plugins.allow[1]',
    ])
  })

  it('returns an empty list when the config is unchanged', () => {
    const config = {
      providers: {
        openai: {
          model: 'gpt-5',
        },
      },
    }

    expect(collectChangedJsonPaths(config, config)).toEqual([])
  })

  it('does not report cloned objects as changed when their JSON content is equal', () => {
    const previousConfig = {
      channels: {
        feishu: {
          appId: 'cli_default',
        },
      },
    }
    const nextConfig = JSON.parse(JSON.stringify(previousConfig))

    expect(collectChangedJsonPaths(previousConfig, nextConfig)).toEqual([])
  })
})
