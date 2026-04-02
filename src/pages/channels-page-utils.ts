import { getChannelDefinition } from '../lib/openclaw-channel-registry'

export type ChannelsConfigStep = 'channel-connect' | 'pairing-code'

export interface ChannelPairingTarget {
  channelId: string | null
  accountId?: string | null
  accountName?: string | null
  skipPairing?: boolean | null
}

export function shouldCompleteChannelConnect(target: ChannelPairingTarget): boolean {
  const channelDef = getChannelDefinition(target.channelId || '')
  return Boolean(target.skipPairing || channelDef?.skipPairing)
}

export function resolveChannelConnectAdvance(target: ChannelPairingTarget): {
  shouldComplete: boolean
  nextStep: ChannelsConfigStep
  selectedTarget: ChannelPairingTarget | null
} {
  if (shouldCompleteChannelConnect(target)) {
    return {
      shouldComplete: true,
      nextStep: 'channel-connect',
      selectedTarget: null,
    }
  }

  return {
    shouldComplete: false,
    nextStep: 'pairing-code',
    selectedTarget: target,
  }
}

export function getConfigModalTitle(configStep: ChannelsConfigStep, target: ChannelPairingTarget | null): string {
  if (configStep !== 'pairing-code' || !target?.channelId) {
    return '配置渠道'
  }

  const channelName = getChannelDefinition(target.channelId)?.name || target.channelId
  if (target.channelId === 'feishu' && target.accountName) {
    return `${channelName}机器人「${target.accountName}」接入成功`
  }
  return `${channelName} 接入成功`
}

export function getPairingIntroCopy(target: ChannelPairingTarget | null): {
  title: string
  message: string
} {
  const channelName = getChannelDefinition(target?.channelId || '')?.name || '当前渠道'
  const accountName = String(target?.accountName || '').trim()

  if (target?.channelId === 'feishu' && accountName) {
    return {
      title: `${channelName}机器人「${accountName}」已接入`,
      message: `已完成${channelName}机器人「${accountName}」的接入配置。接下来请在对应的飞书机器人里发送一条消息，获取配对码后粘贴到下方，完成这个机器人的用户配对。`,
    }
  }

  if (target?.channelId === 'openclaw-weixin' && accountName) {
    return {
      title: `${channelName}账号「${accountName}」已接入`,
      message: `已完成${channelName}账号「${accountName}」的接入配置。当前版本暂不支持给其他微信用户做配对授权，完成扫码后仅当前登录账号可直接使用。`,
    }
  }

  return {
    title: `${channelName} 机器人已接入`,
    message: `已完成${channelName}机器人的接入配置。接下来请在${channelName}中给机器人发送一条消息，获取配对码后粘贴到下方，完成用户配对。`,
  }
}
