export type ManagedChannelPluginSmokeTestPolicy = 'diagnostic-only' | 'strict'

export interface ManagedChannelPluginRecord {
  channelId: string
  pluginId: string
  packageName?: string
  npxSpecifier?: string
  cleanupPluginIds: string[]
  cleanupChannelIds: string[]
  smokeTestPolicy: ManagedChannelPluginSmokeTestPolicy
}

const QQ_LEGACY_PLUGIN_IDS = [
  'qqbot',
  'openclaw-qq',
  '@sliverp/qqbot',
  '@tencent-connect/qqbot',
  '@tencent-connect/openclaw-qq',
  '@tencent-connect/openclaw-qqbot',
  'openclaw-qqbot',
] as const

const MANAGED_CHANNEL_PLUGIN_RECORDS: ManagedChannelPluginRecord[] = [
  {
    channelId: 'feishu',
    pluginId: 'openclaw-lark',
    cleanupPluginIds: ['feishu', 'feishu-openclaw-plugin', 'openclaw-lark'],
    cleanupChannelIds: ['feishu'],
    smokeTestPolicy: 'diagnostic-only',
  },
  {
    channelId: 'wecom',
    pluginId: 'wecom-openclaw-plugin',
    npxSpecifier: '@wecom/wecom-openclaw-cli',
    cleanupPluginIds: ['wecom-openclaw-plugin', 'wecom'],
    cleanupChannelIds: ['wecom'],
    smokeTestPolicy: 'diagnostic-only',
  },
  {
    channelId: 'dingtalk',
    pluginId: 'dingtalk-connector',
    packageName: '@dingtalk-real-ai/dingtalk-connector@0.8.13',
    cleanupPluginIds: ['dingtalk-connector', 'dingtalk'],
    cleanupChannelIds: ['dingtalk-connector', 'dingtalk'],
    smokeTestPolicy: 'diagnostic-only',
  },
  {
    channelId: 'qqbot',
    pluginId: 'openclaw-qqbot',
    packageName: '@tencent-connect/openclaw-qqbot@latest',
    cleanupPluginIds: [...QQ_LEGACY_PLUGIN_IDS],
    cleanupChannelIds: ['qqbot'],
    smokeTestPolicy: 'diagnostic-only',
  },
  {
    channelId: 'openclaw-weixin',
    pluginId: 'openclaw-weixin',
    npxSpecifier: '@tencent-weixin/openclaw-weixin-cli@latest',
    packageName: '@tencent-weixin/openclaw-weixin',
    cleanupPluginIds: ['openclaw-weixin'],
    cleanupChannelIds: ['openclaw-weixin'],
    smokeTestPolicy: 'diagnostic-only',
  },
]

function normalizeId(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function cloneRecord(record: ManagedChannelPluginRecord): ManagedChannelPluginRecord {
  return {
    ...record,
    cleanupPluginIds: [...record.cleanupPluginIds],
    cleanupChannelIds: [...record.cleanupChannelIds],
  }
}

export function listManagedChannelPluginRecords(): ManagedChannelPluginRecord[] {
  return MANAGED_CHANNEL_PLUGIN_RECORDS.map(cloneRecord)
}

export function getManagedChannelPluginByChannelId(
  channelId: string
): ManagedChannelPluginRecord | null {
  const normalizedChannelId = normalizeId(channelId)
  const record = MANAGED_CHANNEL_PLUGIN_RECORDS.find(
    (candidate) => normalizeId(candidate.channelId) === normalizedChannelId
  )
  return record ? cloneRecord(record) : null
}

export function getManagedChannelPluginByPluginId(
  pluginId: string
): ManagedChannelPluginRecord | null {
  const normalizedPluginId = normalizeId(pluginId)
  const record = MANAGED_CHANNEL_PLUGIN_RECORDS.find((candidate) => {
    if (normalizeId(candidate.pluginId) === normalizedPluginId) return true
    return candidate.cleanupPluginIds.some((value) => normalizeId(value) === normalizedPluginId)
  })
  return record ? cloneRecord(record) : null
}

export function isOfficialManagedPluginId(pluginId: string): boolean {
  return Boolean(getManagedChannelPluginByPluginId(pluginId))
}

export function getManagedChannelCleanupPluginIds(channelId: string): string[] {
  return getManagedChannelPluginByChannelId(channelId)?.cleanupPluginIds || []
}

export function getManagedChannelCleanupChannelIds(pluginId: string): string[] {
  return getManagedChannelPluginByPluginId(pluginId)?.cleanupChannelIds || []
}
