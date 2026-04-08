import { stripLegacyOpenClawRootKeys } from './openclaw-config-sanitize'
import type {
  OfficialChannelActionResult,
  OfficialChannelGatewayResult,
  OfficialChannelSetupEvidence,
} from './official-channel-integration'

export interface DingtalkOfficialSetupResult extends OfficialChannelActionResult {
  channelId: 'dingtalk'
  changedPaths: string[]
  applySummary: string
  probeResult: null
}

export type { OfficialChannelGatewayResult, OfficialChannelSetupEvidence } from './official-channel-integration'

function readRequiredField(
  formData: Record<string, string>,
  key: 'clientId' | 'clientSecret',
  label: string
): string {
  const value = String(formData?.[key] || '').trim()
  if (!value) {
    throw new Error(`请输入${label}`)
  }
  return value
}

export function applyDingtalkFallbackConfig(
  config: Record<string, any> | null | undefined,
  formData: Record<string, string>
): Record<string, any> {
  const clientId = readRequiredField(formData, 'clientId', 'Client ID')
  const clientSecret = readRequiredField(formData, 'clientSecret', 'Client Secret')

  const nextConfig = stripLegacyOpenClawRootKeys(config)
  nextConfig.channels = nextConfig.channels || {}

  const existingChannel = (nextConfig.channels['dingtalk-connector'] || {}) as Record<string, any>

  nextConfig.channels['dingtalk-connector'] = {
    ...existingChannel,
    enabled: true,
    clientId,
    clientSecret,
  }

  nextConfig.gateway = nextConfig.gateway || {}
  nextConfig.gateway.http = nextConfig.gateway.http || {}
  nextConfig.gateway.http.endpoints = nextConfig.gateway.http.endpoints || {}
  nextConfig.gateway.http.endpoints.chatCompletions =
    nextConfig.gateway.http.endpoints.chatCompletions || {}
  nextConfig.gateway.http.endpoints.chatCompletions.enabled = true

  return nextConfig
}
