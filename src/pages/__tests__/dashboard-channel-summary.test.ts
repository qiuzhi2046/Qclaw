import { describe, expect, it } from 'vitest'
import { extractChannelsFromConfig } from '../Dashboard'

describe('extractChannelsFromConfig', () => {
  it('normalizes managed channel ids to friendly dashboard labels and platforms', () => {
    const channels = extractChannelsFromConfig({
      channels: {
        feishu: {
          enabled: true,
        },
        wecom: {
          enabled: true,
        },
        'dingtalk-connector': {
          enabled: true,
        },
        qqbot: {
          enabled: true,
        },
        'openclaw-weixin': {
          enabled: true,
        },
      },
    })

    expect(channels).toEqual([
      {
        id: 'feishu',
        name: '飞书',
        platform: 'feishu',
      },
      {
        id: 'wecom',
        name: '企业微信',
        platform: 'wecom',
      },
      {
        id: 'dingtalk-connector',
        name: '钉钉',
        platform: 'dingtalk',
      },
      {
        id: 'qqbot',
        name: 'QQ',
        platform: 'qqbot',
      },
      {
        id: 'openclaw-weixin',
        name: '个人微信',
        platform: 'openclaw-weixin',
      },
    ])
  })
})
