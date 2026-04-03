import { DEFAULT_FEISHU_CHANNEL_SETTINGS } from '../lib/openclaw-channel-registry'
import {
  applyFeishuMultiBotIsolation,
  detectFeishuIsolationDrift,
} from '../lib/feishu-multi-bot-routing'

const DEFAULT_FEISHU_ACCOUNT_ID = 'default'
export const FEISHU_OFFICIAL_PLUGIN_ID = 'feishu'
const LEGACY_FEISHU_PLUGIN_IDS = ['feishu-openclaw-plugin', 'openclaw-lark']
const LEGACY_FEISHU_AGENT_IDS = ['feishu-bot']

export interface FeishuBotItem {
  accountId: string
  name: string
  appId: string
  enabled: boolean
  isDefault: boolean
  agentId: string
}

export interface AddFeishuBotInput {
  name: string
  appId: string
  appSecret: string
}

function cloneConfig(config: Record<string, any> | null): Record<string, any> {
  if (!config) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ensureFeishuRoot(config: Record<string, any>): Record<string, any> {
  config.channels = config.channels || {}
  config.channels.feishu = config.channels.feishu || {}
  return config.channels.feishu as Record<string, any>
}

function createDisplayName(rawName: string, accountId: string, isDefault: boolean): string {
  if (rawName) return rawName
  if (isDefault) return '默认 Bot'
  return `Bot ${accountId}`
}

function createAccountId(name: string, appId: string, existingIds: Set<string>): string {
  const appTail = appId.replace(/^cli_/i, '').slice(-8).toLowerCase()
  const baseText = (name || appTail || 'bot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const base = baseText && baseText !== DEFAULT_FEISHU_ACCOUNT_ID ? baseText : 'bot'
  let candidate = base
  let i = 2
  while (existingIds.has(candidate)) {
    candidate = `${base}-${i}`
    i += 1
  }
  return candidate
}

export function listFeishuBots(config: Record<string, any> | null): FeishuBotItem[] {
  const feishu = config?.channels?.feishu as Record<string, any> | undefined
  if (!feishu || typeof feishu !== 'object') return []

  const bots: FeishuBotItem[] = []

  const defaultAppId = normalizeText(feishu.appId)
  if (defaultAppId) {
    bots.push({
      accountId: DEFAULT_FEISHU_ACCOUNT_ID,
      name: createDisplayName(normalizeText(feishu.name), DEFAULT_FEISHU_ACCOUNT_ID, true),
      appId: defaultAppId,
      enabled: feishu.enabled !== false,
      isDefault: true,
        agentId: DEFAULT_FEISHU_ACCOUNT_ID,
    })
  }

  const accounts = feishu.accounts as Record<string, any> | undefined
  if (accounts && typeof accounts === 'object') {
    for (const [accountId, raw] of Object.entries(accounts)) {
      const account = raw as Record<string, any>
      const appId = normalizeText(account.appId)
      if (!appId) continue
      bots.push({
        accountId,
        name: createDisplayName(normalizeText(account.name), accountId, false),
        appId,
        enabled: account.enabled !== false,
        isDefault: false,
        agentId: accountId,
      })
    }
  }

  return bots.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

export function listResidualLegacyFeishuAgentIds(config: Record<string, any> | null): string[] {
  const activeAgentIds = new Set(listFeishuBots(config).map((bot) => bot.agentId))
  const currentAgents = Array.isArray(config?.agents?.list) ? (config?.agents?.list as Record<string, any>[]) : []
  const residualAgentIds = new Set<string>()

  for (const agent of currentAgents) {
    const agentId = normalizeText(agent?.id)
    if (!agentId || activeAgentIds.has(agentId)) continue
    if (LEGACY_FEISHU_AGENT_IDS.includes(agentId)) {
      residualAgentIds.add(agentId)
    }
  }

  return Array.from(residualAgentIds).sort((left, right) => left.localeCompare(right, 'en'))
}

export function addFeishuBotConfig(
  config: Record<string, any> | null,
  input: AddFeishuBotInput
): { nextConfig: Record<string, any>; accountId: string } {
  const name = normalizeText(input.name)
  const appId = normalizeText(input.appId)
  const appSecret = normalizeText(input.appSecret)

  if (!name) throw new Error('Bot 名称不能为空')
  if (!appId) throw new Error('App ID 不能为空')
  if (!appSecret) throw new Error('App Secret 不能为空')

  const next = cloneConfig(config)
  const feishu = ensureFeishuRoot(next)
  const existingBots = listFeishuBots(next)
  const duplicated = existingBots.some(bot => bot.appId.toLowerCase() === appId.toLowerCase())
  if (duplicated) {
    throw new Error('该 App ID 已存在，请勿重复添加')
  }

  const accounts = (feishu.accounts || {}) as Record<string, any>
  const existingIds = new Set(Object.keys(accounts))
  const accountId = createAccountId(name, appId, existingIds)

  feishu.accounts = accounts
  feishu.accounts[accountId] = {
    enabled: true,
    name,
    appId,
    appSecret,
    dmPolicy: DEFAULT_FEISHU_CHANNEL_SETTINGS.dmPolicy,
    domain: normalizeText(feishu.domain) || DEFAULT_FEISHU_CHANNEL_SETTINGS.domain,
    groupPolicy: normalizeText(feishu.groupPolicy) || DEFAULT_FEISHU_CHANNEL_SETTINGS.groupPolicy,
    streaming:
      typeof feishu.streaming === 'boolean'
        ? feishu.streaming
        : DEFAULT_FEISHU_CHANNEL_SETTINGS.streaming,
    blockStreaming:
      typeof feishu.blockStreaming === 'boolean'
        ? feishu.blockStreaming
        : DEFAULT_FEISHU_CHANNEL_SETTINGS.blockStreaming,
  }
  feishu.enabled = true

  return { nextConfig: applyFeishuMultiBotIsolation(next), accountId }
}

export function removeFeishuBotConfig(
  config: Record<string, any> | null,
  accountId: string
): Record<string, any> {
  const next = cloneConfig(config)
  const feishu = ensureFeishuRoot(next)

  if (accountId === DEFAULT_FEISHU_ACCOUNT_ID) {
    delete feishu.name
    delete feishu.appId
    delete feishu.appSecret
    delete feishu.encryptKey
    delete feishu.verificationToken
  } else if (feishu.accounts && typeof feishu.accounts === 'object') {
    delete feishu.accounts[accountId]
    if (Object.keys(feishu.accounts).length === 0) {
      delete feishu.accounts
    }
  }

  if (listFeishuBots(next).length === 0) {
    feishu.enabled = false
  }

  return applyFeishuMultiBotIsolation(next)
}

export function activateFeishuBotConfig(
  config: Record<string, any> | null,
  accountId: string
): Record<string, any> {
  const next = cloneConfig(config)
  const feishu = ensureFeishuRoot(next)

  if (accountId === DEFAULT_FEISHU_ACCOUNT_ID) {
    if (!normalizeText(feishu.appId) || !normalizeText(feishu.appSecret)) {
      throw new Error('默认飞书 Bot 缺少完整配置，无法直接关联')
    }
  } else {
    const account = feishu.accounts?.[accountId] as Record<string, any> | undefined
    if (!account || !normalizeText(account.appId) || !normalizeText(account.appSecret)) {
      throw new Error('所选飞书 Bot 缺少完整配置，无法关联')
    }
  }

  feishu.enabled = true

  return applyFeishuMultiBotIsolation(next)
}

export function sanitizeFeishuPluginConfig(config: Record<string, any> | null): Record<string, any> {
  const next = cloneConfig(config)
  next.plugins = next.plugins || {}

  if (Array.isArray(next.plugins.allow)) {
    next.plugins.allow = next.plugins.allow.filter(
      (item: unknown) => !LEGACY_FEISHU_PLUGIN_IDS.includes(String(item || '').trim())
    )
  }

  if (next.plugins?.entries && typeof next.plugins.entries === 'object') {
    const entries = { ...next.plugins.entries }
    LEGACY_FEISHU_PLUGIN_IDS.forEach(id => delete entries[id])
    entries[FEISHU_OFFICIAL_PLUGIN_ID] = { ...(entries[FEISHU_OFFICIAL_PLUGIN_ID] || {}), enabled: true }
    next.plugins.entries = entries
  }

  if (next.plugins?.installs && typeof next.plugins.installs === 'object') {
    const installs = { ...next.plugins.installs }
    LEGACY_FEISHU_PLUGIN_IDS.forEach(id => delete installs[id])
    next.plugins.installs = installs
  }

  return next
}

export function stripFeishuOfficialPluginConfig(config: Record<string, any> | null): Record<string, any> {
  const next = sanitizeFeishuPluginConfig(config)
  if (Array.isArray(next.plugins?.allow)) {
    next.plugins.allow = next.plugins.allow.filter(
      (item: unknown) => String(item || '').trim() !== FEISHU_OFFICIAL_PLUGIN_ID
    )
  }
  if (next.plugins?.entries && typeof next.plugins.entries === 'object') {
    const entries = { ...next.plugins.entries }
    delete entries[FEISHU_OFFICIAL_PLUGIN_ID]
    next.plugins.entries = entries
  }
  if (next.plugins?.installs && typeof next.plugins.installs === 'object') {
    const installs = { ...next.plugins.installs }
    delete installs[FEISHU_OFFICIAL_PLUGIN_ID]
    next.plugins.installs = installs
  }
  return next
}

export function normalizeFeishuOfficialPluginConfig(
  config: Record<string, any> | null,
  installedOnDisk: boolean
): Record<string, any> {
  return installedOnDisk
    ? reconcileFeishuOfficialPluginConfig(config)
    : stripFeishuOfficialPluginConfig(config)
}

export function reconcileFeishuOfficialPluginConfig(config: Record<string, any> | null): Record<string, any> {
  return applyFeishuMultiBotIsolation(sanitizeFeishuPluginConfig(config))
}

export function removeFeishuBotConfigForPluginState(
  config: Record<string, any> | null,
  accountId: string,
  installedOnDisk: boolean
): Record<string, any> {
  return normalizeFeishuOfficialPluginConfig(
    removeFeishuBotConfig(config, accountId),
    installedOnDisk
  )
}

export { detectFeishuIsolationDrift }
