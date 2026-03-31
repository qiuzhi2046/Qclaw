import {
  isNonFatalOnboardFailure,
  type OnboardFailureLike,
} from '../shared/openclaw-cli-errors'
import {
  getManagedChannelPluginByChannelId,
} from '../shared/managed-channel-plugin-registry'
import {
  applyDingtalkFallbackConfig,
} from '../shared/dingtalk-official-setup'
import {
  stripLegacyOpenClawRootKeys,
} from '../shared/openclaw-config-sanitize'
import feishuIcon from '../assets/channels/feishu.svg'
import wecomIcon from '../assets/channels/wecom.svg'
import dingtalkIcon from '../assets/channels/dingtalk.svg'
import qqIcon from '../assets/channels/qq.svg'
import weixinIcon from '../assets/channels/weixin.svg'
import lineIcon from '../assets/channels/line.svg'
import telegramIcon from '../assets/channels/telegram.svg'
import slackIcon from '../assets/channels/slack.svg'

export { classifyOnboardFailure, isPluginAlreadyInstalledError } from '../shared/openclaw-cli-errors'
export { applyDingtalkFallbackConfig } from '../shared/dingtalk-official-setup'
export { stripLegacyOpenClawRootKeys } from '../shared/openclaw-config-sanitize'

export interface ChannelFieldDefinition {
  key: string
  label: string
  placeholder: string
  type?: 'text' | 'password'
  required?: boolean
  minLength?: number
  maxLength?: number
  pattern?: RegExp
  validationMessage?: string
}

export interface ChannelPluginDefinition {
  packageName?: string
  npxSpecifier?: string
  allowId?: string
  cleanupPluginIds?: string[]
}

export interface ChannelDefinition {
  id: string
  name: string
  logo: string
  description: string
  helpUrl: string
  helpText: string
  fields: ChannelFieldDefinition[]
  plugin?: ChannelPluginDefinition
  /** When true, use `openclaw channels add` CLI instead of writing JSON config */
  useCliChannelsAdd?: boolean
  /** When true, skip the pairing step after channel connection */
  skipPairing?: boolean
  /** When true, use QR code scanning to bind the channel instead of manual form fields */
  useQrBinding?: boolean
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export interface ChannelFormValidationResult {
  ok: boolean
  values: Record<string, string>
  fieldErrors: Record<string, string>
}

export interface WeixinChannelAccountLike {
  accountId: string
  name?: string
  enabled?: boolean
}

export const DEFAULT_FEISHU_CHANNEL_SETTINGS = {
  domain: 'feishu',
  dmPolicy: 'pairing',
  groupPolicy: 'open',
  streaming: true,
  blockStreaming: true,
} as const

const WECOM_MANAGED_PLUGIN = getManagedChannelPluginByChannelId('wecom')
const DINGTALK_MANAGED_PLUGIN = getManagedChannelPluginByChannelId('dingtalk')
const QQBOT_MANAGED_PLUGIN = getManagedChannelPluginByChannelId('qqbot')
const WEIXIN_MANAGED_PLUGIN = getManagedChannelPluginByChannelId('openclaw-weixin')
const LINE_MANAGED_PLUGIN = getManagedChannelPluginByChannelId('line')
const TELEGRAM_MANAGED_PLUGIN = getManagedChannelPluginByChannelId('telegram')
const SLACK_MANAGED_PLUGIN = getManagedChannelPluginByChannelId('slack')

const CHANNEL_DEFINITIONS: ChannelDefinition[] = [
  {
    id: 'feishu',
    name: '飞书',
    logo: feishuIcon,
    description: '飞书/Lark 机器人（官方插件）',
    helpUrl: 'https://my.feishu.cn/wiki/WAfWw1bqriZP02kqdNycHlvnnHb',
    helpText: '在飞书开放平台创建企业自建应用，添加机器人能力',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxxxx', required: true },
      { key: 'appSecret', label: 'App Secret', placeholder: '应用密钥', type: 'password', required: true },
    ],
  },
  {
    id: 'wecom',
    name: '企业微信',
    logo: wecomIcon,
    description: '企业微信 AI 机器人（官方插件）',
    helpUrl: 'https://my.feishu.cn/wiki/TsLTwplveiqbW8kH5XOclgvYn1d',
    helpText: '在企业微信管理后台创建 AI 机器人',
    fields: [
      { key: 'botId', label: 'Bot ID', placeholder: '机器人 ID', required: true },
      { key: 'secret', label: 'Secret', placeholder: '机器人密钥', type: 'password' as const, required: true },
    ],
    plugin: {
      npxSpecifier: WECOM_MANAGED_PLUGIN?.npxSpecifier,
      allowId: WECOM_MANAGED_PLUGIN?.pluginId,
      cleanupPluginIds: WECOM_MANAGED_PLUGIN?.cleanupPluginIds,
    },
    useQrBinding: true,
    skipPairing: true,
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    logo: dingtalkIcon,
    description: '钉钉机器人（官方插件）',
    helpUrl: 'https://my.feishu.cn/wiki/NUJew2DzaipVsukUvPmcZ2yvnYb',
    helpText: '在钉钉开放平台创建 AI 助理应用，获取 Client ID 和 Client Secret',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: 'dingxxxxxxxxxx', required: true },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '应用密钥', type: 'password', required: true },
    ],
    plugin: {
      packageName: DINGTALK_MANAGED_PLUGIN?.packageName,
      cleanupPluginIds: DINGTALK_MANAGED_PLUGIN?.cleanupPluginIds,
    },
    skipPairing: true,
  },
  {
    id: 'qqbot',
    name: 'QQ',
    logo: qqIcon,
    description: 'QQ 机器人（官方插件）',
    helpUrl: 'https://my.feishu.cn/wiki/AvuSwchqviAO6dkwiZycmZeInPf',
    helpText: '在 QQ 开放平台创建机器人应用，获取 App ID 和 App Secret',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'QQ 机器人 App ID', required: true },
      { key: 'appSecret', label: 'App Secret', placeholder: '应用密钥', type: 'password', required: true },
    ],
    plugin: {
      packageName: QQBOT_MANAGED_PLUGIN?.packageName,
      allowId: QQBOT_MANAGED_PLUGIN?.pluginId,
      cleanupPluginIds: QQBOT_MANAGED_PLUGIN?.cleanupPluginIds,
    },
    skipPairing: true,
  },
  {
    id: 'openclaw-weixin',
    name: '个人微信',
    logo: weixinIcon,
    description: '个人微信扫码登录（官方插件，当前仅支持扫码账号本人使用）',
    helpUrl: 'https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin',
    helpText: '安装插件后，使用微信扫码完成登录授权；当前暂不支持给其他微信用户做配对授权',
    fields: [],
    plugin: {
      packageName: WEIXIN_MANAGED_PLUGIN?.packageName,
      allowId: WEIXIN_MANAGED_PLUGIN?.pluginId,
      cleanupPluginIds: WEIXIN_MANAGED_PLUGIN?.cleanupPluginIds,
    },
    skipPairing: true,
  },
  {
    id: 'line',
    name: 'LINE',
    logo: lineIcon,
    description: 'LINE Bot（官方插件）',
    helpUrl: 'https://developers.line.biz/',
    helpText: '在 LINE Developers Console 创建 Messaging API 频道，获取 Channel Access Token 和 Channel Secret',
    fields: [
      { key: 'channelAccessToken', label: 'Channel Access Token', placeholder: 'Channel Access Token', type: 'password', required: true },
      { key: 'channelSecret', label: 'Channel Secret', placeholder: 'Channel Secret', type: 'password', required: true },
    ],
    plugin: {
      packageName: LINE_MANAGED_PLUGIN?.packageName,
      allowId: LINE_MANAGED_PLUGIN?.pluginId,
      cleanupPluginIds: LINE_MANAGED_PLUGIN?.cleanupPluginIds,
    },
    skipPairing: true,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    logo: telegramIcon,
    description: 'Telegram Bot（官方插件）',
    helpUrl: 'https://core.telegram.org/bots/api',
    helpText: '通过 @BotFather 创建 Telegram Bot，获取 Bot Token',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', type: 'password', required: true },
    ],
    plugin: {
      packageName: TELEGRAM_MANAGED_PLUGIN?.packageName,
      allowId: TELEGRAM_MANAGED_PLUGIN?.pluginId,
      cleanupPluginIds: TELEGRAM_MANAGED_PLUGIN?.cleanupPluginIds,
    },
    skipPairing: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    logo: slackIcon,
    description: 'Slack Bot（官方插件）',
    helpUrl: 'https://api.slack.com/docs',
    helpText: '在 Slack App 管理页面创建 App，获取 Bot Token 和 App-Level Token',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password', required: true },
      { key: 'appToken', label: 'App-Level Token', placeholder: 'xapp-...', type: 'password', required: true },
    ],
    plugin: {
      packageName: SLACK_MANAGED_PLUGIN?.packageName,
      allowId: SLACK_MANAGED_PLUGIN?.pluginId,
      cleanupPluginIds: SLACK_MANAGED_PLUGIN?.cleanupPluginIds,
    },
    skipPairing: true,
  },
]

function cloneFields(fields: ChannelFieldDefinition[]): ChannelFieldDefinition[] {
  return fields.map((field) => ({ ...field }))
}

function cloneChannelDefinition(channel: ChannelDefinition): ChannelDefinition {
  return {
    ...channel,
    fields: cloneFields(channel.fields),
    ...(channel.plugin ? { plugin: { ...channel.plugin } } : {}),
  }
}

function normalizeChannelId(channelId: string): string {
  return String(channelId || '').trim().toLowerCase()
}

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config || typeof config !== 'object') return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function ensurePluginAllow(config: Record<string, any>, allowId: string | undefined): void {
  if (!allowId) return
  config.plugins = config.plugins || {}
  config.plugins.allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : []
  if (!config.plugins.allow.includes(allowId)) {
    config.plugins.allow.push(allowId)
  }
}

function removePluginAllow(config: Record<string, any>, allowId: string | undefined): void {
  if (!allowId) return
  if (!Array.isArray(config.plugins?.allow)) return
  config.plugins.allow = config.plugins.allow.filter((item: unknown) => String(item || '').trim() !== allowId)
}

function trimFieldValue(formData: Record<string, string>, key: string): string {
  return String(formData[key] || '').trim()
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized = value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  return Array.from(new Set(normalized))
}

function normalizeFeishuDmPolicy(
  dmPolicy: unknown,
  allowFrom: string[]
): (typeof DEFAULT_FEISHU_CHANNEL_SETTINGS)['dmPolicy'] | 'allowlist' | 'open' | 'disabled' {
  const normalized = String(dmPolicy || '').trim()
  if (normalized === 'pairing') return 'pairing'
  if (normalized === 'disabled') return 'disabled'
  if (normalized === 'open') return 'open'
  if (normalized === 'allowlist') {
    // `allowlist` without entries silently blocks all DMs, so we auto-heal to pairing.
    return allowFrom.length > 0 ? 'allowlist' : 'pairing'
  }
  return DEFAULT_FEISHU_CHANNEL_SETTINGS.dmPolicy
}

export function listChannelDefinitions(): ChannelDefinition[] {
  return CHANNEL_DEFINITIONS.map(cloneChannelDefinition)
}

export function getChannelDefinition(channelId: string): ChannelDefinition | null {
  const channel = CHANNEL_DEFINITIONS.find((item) => item.id === normalizeChannelId(channelId))
  return channel ? cloneChannelDefinition(channel) : null
}

export function resolveChannelPluginAllowId(channel: Pick<ChannelDefinition, 'plugin'>): string | undefined {
  const explicitAllowId = String(channel.plugin?.allowId || '').trim()
  if (explicitAllowId) return explicitAllowId

  const packageName = String(channel.plugin?.packageName || '').trim()
  if (!packageName) return undefined

  const segments = packageName.split('/').filter(Boolean)
  const lastSegment = segments[segments.length - 1] || ''
  const versionSeparatorIndex = lastSegment.lastIndexOf('@')
  if (versionSeparatorIndex > 0) {
    return lastSegment.slice(0, versionSeparatorIndex) || undefined
  }
  return lastSegment || undefined
}

export function getChannelPluginInstallLabel(channel: Pick<ChannelDefinition, 'plugin'>): string {
  const packageName = String(channel.plugin?.packageName || '').trim()
  if (packageName) return packageName
  return '官方插件'
}

export function isChannelPluginConfigured(
  config: Record<string, any> | null | undefined,
  channelId: string
): boolean {
  const channel = getChannelDefinition(channelId)
  if (!channel?.plugin) return false

  const pluginId = resolveChannelPluginAllowId(channel)
  if (!pluginId) return false

  const plugins = hasOwnRecord(config?.plugins) ? config.plugins : null
  if (!plugins) return false

  if (Array.isArray(plugins.allow) && plugins.allow.some((item) => String(item || '').trim() === pluginId)) {
    return true
  }

  if (hasOwnRecord(plugins.entries)) {
    const entry = plugins.entries[pluginId]
    if (hasOwnRecord(entry) && entry.enabled !== false) {
      return true
    }
  }

  if (hasOwnRecord(plugins.installs) && hasOwnRecord(plugins.installs[pluginId])) {
    return true
  }

  return false
}

function validateChannelField(field: ChannelFieldDefinition, value: string): string | undefined {
  const normalizedValue = String(value || '').trim()

  if (field.required !== false && normalizedValue.length === 0) {
    return `请输入${field.label}`
  }
  if (!normalizedValue) return undefined

  if (typeof field.minLength === 'number' && normalizedValue.length < field.minLength) {
    return `${field.label} 至少需要 ${field.minLength} 个字符`
  }
  if (typeof field.maxLength === 'number' && normalizedValue.length > field.maxLength) {
    return `${field.label} 不能超过 ${field.maxLength} 个字符`
  }
  if (field.pattern && !field.pattern.test(normalizedValue)) {
    return field.validationMessage || `${field.label} 格式不正确`
  }

  return undefined
}

export function validateChannelForm(
  channel: Pick<ChannelDefinition, 'fields'> | null | undefined,
  formData: Record<string, string>
): ChannelFormValidationResult {
  if (!channel) {
    return {
      ok: false,
      values: {},
      fieldErrors: {},
    }
  }

  const values: Record<string, string> = {}
  const fieldErrors: Record<string, string> = {}

  for (const field of channel.fields) {
    const value = trimFieldValue(formData, field.key)
    values[field.key] = value
    const error = validateChannelField(field, value)
    if (error) {
      fieldErrors[field.key] = error
    }
  }

  return {
    ok: Object.keys(fieldErrors).length === 0,
    values,
    fieldErrors,
  }
}

export function isChannelFormComplete(
  channel: Pick<ChannelDefinition, 'fields'> | null | undefined,
  formData: Record<string, string>
): boolean {
  return validateChannelForm(channel, formData).ok
}

export function isNonFatalOnboardError(error: OnboardFailureLike | string): boolean {
  return isNonFatalOnboardFailure(error)
}

export function buildChannelOnboardOptions(platform: string, authChoice?: string): Record<string, any> {
  return {
    acceptRisk: true,
    installDaemon: platform !== 'win32',
    skipChannels: true,
    skipSkills: true,
    ...(authChoice ? { authChoice } : {}),
  }
}

export function applyChannelConfig(
  config: Record<string, any> | null | undefined,
  channelId: string,
  formData: Record<string, string>
): Record<string, any> {
  const channel = getChannelDefinition(channelId)
  if (!channel) {
    throw new Error(`Unsupported channel: ${channelId}`)
  }

  const validation = validateChannelForm(channel, formData)
  if (!validation.ok) {
    throw new Error(Object.values(validation.fieldErrors)[0] || `Incomplete channel config for ${channelId}`)
  }

  const nextConfig = stripLegacyOpenClawRootKeys(config)
  nextConfig.channels = nextConfig.channels || {}
  const values = validation.values

  if (channel.id === 'feishu') {
    const existingChannel = (nextConfig.channels.feishu || {}) as Record<string, any>
    const { allowFrom: _existingAllowFrom, ...existingChannelWithoutAllowFrom } = existingChannel
    const allowFrom = normalizeStringArray(existingChannel.allowFrom)
    const dmPolicy = normalizeFeishuDmPolicy(existingChannel.dmPolicy, allowFrom)
    nextConfig.channels.feishu = {
      ...existingChannelWithoutAllowFrom,
      enabled: true,
      appId: values.appId,
      appSecret: values.appSecret,
      dmPolicy,
      ...(allowFrom.length > 0 ? { allowFrom } : {}),
      domain: typeof existingChannel.domain === 'string' && existingChannel.domain.trim()
        ? existingChannel.domain.trim()
        : DEFAULT_FEISHU_CHANNEL_SETTINGS.domain,
      groupPolicy: typeof existingChannel.groupPolicy === 'string' && existingChannel.groupPolicy.trim()
        ? existingChannel.groupPolicy.trim()
        : DEFAULT_FEISHU_CHANNEL_SETTINGS.groupPolicy,
      streaming:
        typeof existingChannel.streaming === 'boolean'
          ? existingChannel.streaming
          : DEFAULT_FEISHU_CHANNEL_SETTINGS.streaming,
      blockStreaming:
        typeof existingChannel.blockStreaming === 'boolean'
          ? existingChannel.blockStreaming
          : DEFAULT_FEISHU_CHANNEL_SETTINGS.blockStreaming,
    }
  } else if (channel.id === 'wecom') {
    const existingChannel = (nextConfig.channels.wecom || {}) as Record<string, any>
    // For QR binding, botId/secret come from formData directly (not from field validation)
    const botId = trimFieldValue(formData, 'botId')
    const secret = trimFieldValue(formData, 'secret')
    if (!botId || !secret) {
      throw new Error('企业微信配置缺少 botId 或 secret')
    }
    nextConfig.channels.wecom = {
      ...existingChannel,
      enabled: true,
      botId,
      secret,
    }
  } else if (channel.id === 'dingtalk') {
    const fallbackConfig = applyDingtalkFallbackConfig(nextConfig, formData)
    nextConfig.channels = fallbackConfig.channels
    nextConfig.gateway = fallbackConfig.gateway
  } else if (channel.id === 'qqbot') {
    const existingChannel = (nextConfig.channels.qqbot || {}) as Record<string, any>
    const { appSecret: _legacyAppSecret, ...existingChannelWithoutLegacySecret } = existingChannel
    const hasAllowFrom = Array.isArray(existingChannel.allowFrom)
    const allowFrom = hasAllowFrom ? normalizeStringArray(existingChannel.allowFrom) : ['*']

    nextConfig.channels.qqbot = {
      ...existingChannelWithoutLegacySecret,
      enabled: true,
      appId: values.appId,
      clientSecret: values.appSecret,
      allowFrom,
    }
  } else if (channel.id === 'openclaw-weixin') {
    const existingChannel = (nextConfig.channels['openclaw-weixin'] || {}) as Record<string, any>
    nextConfig.channels['openclaw-weixin'] = {
      ...existingChannel,
      enabled: true,
      accounts:
        existingChannel.accounts && typeof existingChannel.accounts === 'object' && !Array.isArray(existingChannel.accounts)
          ? existingChannel.accounts
          : {},
    }
  } else if (channel.id === 'line') {
    const existingChannel = (nextConfig.channels.line || {}) as Record<string, any>
    nextConfig.channels.line = {
      ...existingChannel,
      enabled: true,
      channelAccessToken: values.channelAccessToken,
      channelSecret: values.channelSecret,
      dmPolicy: typeof existingChannel.dmPolicy === 'string' && existingChannel.dmPolicy.trim()
        ? existingChannel.dmPolicy.trim()
        : 'pairing',
    }
  } else if (channel.id === 'telegram') {
    const existingChannel = (nextConfig.channels.telegram || {}) as Record<string, any>
    nextConfig.channels.telegram = {
      ...existingChannel,
      enabled: true,
      botToken: values.botToken,
      dmPolicy: typeof existingChannel.dmPolicy === 'string' && existingChannel.dmPolicy.trim()
        ? existingChannel.dmPolicy.trim()
        : 'pairing',
    }
  } else if (channel.id === 'slack') {
    const existingChannel = (nextConfig.channels.slack || {}) as Record<string, any>
    nextConfig.channels.slack = {
      ...existingChannel,
      enabled: true,
      botToken: values.botToken,
      appToken: values.appToken,
      dmPolicy: typeof existingChannel.dmPolicy === 'string' && existingChannel.dmPolicy.trim()
        ? existingChannel.dmPolicy.trim()
        : 'pairing',
    }
  }

  ensurePluginAllow(nextConfig, resolveChannelPluginAllowId(channel))
  return nextConfig
}

export function syncWeixinChannelAccounts(
  config: Record<string, any> | null | undefined,
  accounts: WeixinChannelAccountLike[]
): Record<string, any> {
  const nextConfig = cloneConfig(config)
  nextConfig.channels = nextConfig.channels || {}

  const existingChannel = (nextConfig.channels['openclaw-weixin'] || {}) as Record<string, any>
  const existingAccounts =
    existingChannel.accounts && typeof existingChannel.accounts === 'object' && !Array.isArray(existingChannel.accounts)
      ? existingChannel.accounts
      : {}
  const nextAccounts: Record<string, any> = { ...existingAccounts }

  for (const account of accounts) {
    const accountId = String(account.accountId || '').trim()
    if (!accountId) continue

    const existingAccount = nextAccounts[accountId]
    const normalizedExistingAccount =
      existingAccount && typeof existingAccount === 'object' && !Array.isArray(existingAccount)
        ? existingAccount
        : {}

    nextAccounts[accountId] = {
      ...normalizedExistingAccount,
      enabled:
        typeof normalizedExistingAccount.enabled === 'boolean'
          ? normalizedExistingAccount.enabled
          : account.enabled !== false,
      name:
        String(normalizedExistingAccount.name || '').trim()
        || String(account.name || '').trim()
        || accountId,
    }
  }

  nextConfig.channels['openclaw-weixin'] = {
    ...existingChannel,
    enabled: true,
    accounts: nextAccounts,
  }
  ensurePluginAllow(nextConfig, 'openclaw-weixin')
  return nextConfig
}

export function removeWeixinChannelAccountConfig(
  config: Record<string, any> | null | undefined,
  accountIdInput: string
): Record<string, any> {
  const nextConfig = cloneConfig(config)
  const accountId = String(accountIdInput || '').trim()
  if (!accountId) return nextConfig

  const existingChannel = nextConfig.channels?.['openclaw-weixin']
  if (!existingChannel || typeof existingChannel !== 'object' || Array.isArray(existingChannel)) {
    return nextConfig
  }

  const existingAccounts = existingChannel.accounts
  if (!existingAccounts || typeof existingAccounts !== 'object' || Array.isArray(existingAccounts)) {
    return nextConfig
  }

  const nextAccounts = { ...existingAccounts }
  delete nextAccounts[accountId]

  if (Object.keys(nextAccounts).length === 0) {
    delete nextConfig.channels['openclaw-weixin']
    removePluginAllow(nextConfig, 'openclaw-weixin')
    return nextConfig
  }

  nextConfig.channels['openclaw-weixin'] = {
    ...existingChannel,
    accounts: nextAccounts,
  }
  return nextConfig
}

export function buildCliChannelAddToken(
  channelId: string,
  formData: Record<string, string>
): string {
  const channel = getChannelDefinition(channelId)
  if (!channel) {
    throw new Error(`Unsupported channel: ${channelId}`)
  }

  const validation = validateChannelForm(channel, formData)
  if (!validation.ok) {
    throw new Error(Object.values(validation.fieldErrors)[0] || `Incomplete channel config for ${channelId}`)
  }

  const values = validation.values

  if (channel.id === 'qqbot') {
    return `${values.appId}:${values.appSecret}`
  }

  throw new Error(`Channel ${channelId} does not support CLI channels add`)
}
