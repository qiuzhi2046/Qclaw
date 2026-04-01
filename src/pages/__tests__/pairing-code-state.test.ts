import { describe, expect, it } from 'vitest'

import { getPairingChannelInfo } from '../PairingCode'

describe('getPairingChannelInfo', () => {
  it('resolves LINE instead of falling back to Feishu copy', () => {
    expect(getPairingChannelInfo('line')).toMatchObject({
      name: 'LINE',
    })
  })

  it('resolves Telegram instead of falling back to Feishu copy', () => {
    expect(getPairingChannelInfo('telegram')).toMatchObject({
      name: 'Telegram',
    })
  })

  it('resolves Slack instead of falling back to Feishu copy', () => {
    expect(getPairingChannelInfo('slack')).toMatchObject({
      name: 'Slack',
    })
  })

  it('still falls back to Feishu for unknown channels', () => {
    expect(getPairingChannelInfo('unknown-channel')).toMatchObject({
      name: '飞书',
    })
  })
})
