import { describe, expect, it } from 'vitest'

import {
  getConfigModalTitle,
  getPairingIntroCopy,
  resolveChannelConnectAdvance,
  shouldCompleteChannelConnect,
} from '../channels-page-utils'

describe('resolveChannelConnectAdvance', () => {
  it('keeps Feishu in the pairing flow and carries the configured channel id', () => {
    expect(resolveChannelConnectAdvance({ channelId: 'feishu', accountId: 'work', accountName: '工作机器人' })).toEqual({
      shouldComplete: false,
      nextStep: 'pairing-code',
      selectedTarget: {
        channelId: 'feishu',
        accountId: 'work',
        accountName: '工作机器人',
      },
    })
  })

  it('finishes immediately for installer-created Feishu bots that skip pairing', () => {
    expect(
      resolveChannelConnectAdvance({
        channelId: 'feishu',
        accountId: 'work',
        accountName: '工作机器人',
        skipPairing: true,
      })
    ).toEqual({
      shouldComplete: true,
      nextStep: 'channel-connect',
      selectedTarget: null,
    })
  })

  it('finishes immediately for channels that do not require pairing', () => {
    expect(resolveChannelConnectAdvance({ channelId: 'dingtalk' })).toEqual({
      shouldComplete: true,
      nextStep: 'channel-connect',
      selectedTarget: null,
    })
  })
})

describe('shouldCompleteChannelConnect', () => {
  it('lets an explicit payload override Feishu into the direct-complete path', () => {
    expect(
      shouldCompleteChannelConnect({
        channelId: 'feishu',
        accountId: 'default',
        accountName: '默认 Bot',
        skipPairing: true,
      })
    ).toBe(true)
  })

  it('keeps ordinary Feishu connects in the pairing path when no override is set', () => {
    expect(
      shouldCompleteChannelConnect({
        channelId: 'feishu',
        accountId: 'default',
        accountName: '默认 Bot',
      })
    ).toBe(false)
  })

  it('keeps Telegram in the pairing path because dmPolicy defaults to pairing', () => {
    expect(
      shouldCompleteChannelConnect({
        channelId: 'telegram',
      })
    ).toBe(false)
  })

  it('keeps Slack in the pairing path because dmPolicy defaults to pairing', () => {
    expect(
      shouldCompleteChannelConnect({
        channelId: 'slack',
      })
    ).toBe(false)
  })
})

describe('getConfigModalTitle', () => {
  it('shows a success title after a pairing-required channel is connected', () => {
    expect(
      getConfigModalTitle('pairing-code', {
        channelId: 'feishu',
        accountId: 'work',
        accountName: '工作机器人',
      })
    ).toBe('飞书 Bot「工作机器人」接入成功')
  })

  it('falls back to the default title for the connect step', () => {
    expect(getConfigModalTitle('channel-connect', { channelId: 'feishu' })).toBe('配置渠道')
  })
})

describe('getPairingIntroCopy', () => {
  it('builds a success notice that guides the user into pairing', () => {
    expect(
      getPairingIntroCopy({
        channelId: 'feishu',
        accountId: 'work',
        accountName: '工作机器人',
      })
    ).toEqual({
      title: '飞书 Bot「工作机器人」已接入',
      message:
        '已完成飞书 Bot「工作机器人」的接入配置。接下来请在对应的飞书机器人里发送一条消息，获取配对码后粘贴到下方，完成这个 Bot 的用户配对。',
    })
  })

  it('explains that personal WeChat is temporarily limited to the scanned-in account', () => {
    expect(
      getPairingIntroCopy({
        channelId: 'openclaw-weixin',
        accountId: 'wx-main',
        accountName: '主微信',
      })
    ).toEqual({
      title: '个人微信账号「主微信」已接入',
      message:
        '已完成个人微信账号「主微信」的接入配置。当前版本暂不支持给其他微信用户做配对授权，完成扫码后仅当前登录账号可直接使用。',
    })
  })
})
