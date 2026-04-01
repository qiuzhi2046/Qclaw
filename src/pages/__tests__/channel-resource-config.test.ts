import { describe, expect, it } from 'vitest'
import {
  readChannelResourceConfig,
  buildChannelResourcePatch,
  getChannelResourceDisplayLabel,
} from '../channel-resource-config'

describe('readChannelResourceConfig', () => {
  it('reads model from feishu channel config', () => {
    const config = {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_test',
          model: 'openai/gpt-4o',
        },
      },
    }

    const result = readChannelResourceConfig(config, 'feishu')
    expect(result.model).toBe('openai/gpt-4o')
  })

  it('reads model from a non-Feishu channel config', () => {
    const config = {
      channels: {
        line: {
          enabled: true,
          channelAccessToken: 'token',
          model: 'zai/glm-5',
        },
      },
    }

    const result = readChannelResourceConfig(config, 'line')
    expect(result.model).toBe('zai/glm-5')
  })

  it('returns empty model when no channel config exists', () => {
    const result = readChannelResourceConfig({}, 'telegram')
    expect(result.model).toBe('')
  })

  it('returns empty model when channel config has no model field', () => {
    const config = {
      channels: {
        slack: {
          enabled: true,
          botToken: 'xoxb-test',
        },
      },
    }

    const result = readChannelResourceConfig(config, 'slack')
    expect(result.model).toBe('')
  })
})

describe('buildChannelResourcePatch', () => {
  it('produces a config patch with the new model for a non-Feishu channel', () => {
    const patch = buildChannelResourcePatch({
      config: {
        channels: {
          telegram: {
            enabled: true,
            botToken: 'token',
          },
        },
      },
      channelId: 'telegram',
      model: 'openai/gpt-4o',
    })

    expect(patch.channels.telegram.model).toBe('openai/gpt-4o')
  })

  it('preserves unrelated channel config during updates', () => {
    const patch = buildChannelResourcePatch({
      config: {
        channels: {
          feishu: { enabled: true, appId: 'cli_test', model: 'old-model' },
          telegram: { enabled: true, botToken: 'token' },
        },
      },
      channelId: 'telegram',
      model: 'new-model',
    })

    expect(patch.channels.telegram.model).toBe('new-model')
    expect(patch.channels.feishu.model).toBe('old-model')
  })

  it('supports non-Feishu channels without agentId', () => {
    const patch = buildChannelResourcePatch({
      config: {
        channels: {
          line: {
            enabled: true,
            channelAccessToken: 'token',
          },
        },
      },
      channelId: 'line',
      model: 'some-model',
    })

    expect(patch.channels.line.model).toBe('some-model')
    expect(patch.channels.line.agentId).toBeUndefined()
  })
})

describe('getChannelResourceDisplayLabel', () => {
  it('returns a display label for the channel resource config', () => {
    expect(getChannelResourceDisplayLabel('line')).toContain('LINE')
    expect(getChannelResourceDisplayLabel('telegram')).toContain('Telegram')
    expect(getChannelResourceDisplayLabel('slack')).toContain('Slack')
    expect(getChannelResourceDisplayLabel('feishu')).toContain('飞书')
  })
})
