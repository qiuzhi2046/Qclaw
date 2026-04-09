import { describe, expect, it } from 'vitest'
import channelConnectSource from '../ChannelConnect.tsx?raw'

describe('ChannelConnect weixin installer copy', () => {
  it('does not advertise a force retry state for the personal weixin installer', () => {
    expect(channelConnectSource).not.toContain('force 重试中')
  })
})
