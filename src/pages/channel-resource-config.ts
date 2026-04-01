import { getChannelDefinition } from '../lib/openclaw-channel-registry'

export interface ChannelResourceConfig {
  model: string
}

export interface BuildChannelResourcePatchParams {
  config: Record<string, any> | null | undefined
  channelId: string
  model: string
}

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config || typeof config !== 'object') return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function normalizeChannelId(channelId: string): string {
  return String(channelId || '').trim().toLowerCase()
}

export function readChannelResourceConfig(
  config: Record<string, any> | null | undefined,
  channelId: string
): ChannelResourceConfig {
  const normalizedId = normalizeChannelId(channelId)
  const channels = config?.channels
  if (!channels || typeof channels !== 'object') {
    return { model: '' }
  }

  const channelConfig = channels[normalizedId]
  if (!channelConfig || typeof channelConfig !== 'object' || Array.isArray(channelConfig)) {
    return { model: '' }
  }

  return {
    model: typeof channelConfig.model === 'string' ? channelConfig.model.trim() : '',
  }
}

export function buildChannelResourcePatch(params: BuildChannelResourcePatchParams): Record<string, any> {
  const { config, channelId, model } = params
  const nextConfig = cloneConfig(config)
  const normalizedId = normalizeChannelId(channelId)

  nextConfig.channels = nextConfig.channels || {}
  const existingChannel = (nextConfig.channels[normalizedId] || {}) as Record<string, any>

  nextConfig.channels[normalizedId] = {
    ...existingChannel,
    model,
  }

  return nextConfig
}

export function getChannelResourceDisplayLabel(channelId: string): string {
  const definition = getChannelDefinition(channelId)
  if (definition) {
    return `${definition.name} 资源配置`
  }
  return `${channelId} 资源配置`
}
