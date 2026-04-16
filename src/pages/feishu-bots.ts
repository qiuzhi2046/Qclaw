import { DEFAULT_FEISHU_CHANNEL_SETTINGS } from '../lib/openclaw-channel-registry'
import {
  applyFeishuMultiBotIsolation,
  detectFeishuIsolationDrift,
  getFeishuManagedAgentId,
  isFeishuManagedAgentId,
} from '../lib/feishu-multi-bot-routing'

const DEFAULT_FEISHU_ACCOUNT_ID = 'default'
const BUILTIN_FEISHU_PLUGIN_ID = 'feishu'
const LEGACY_FEISHU_PLUGIN_IDS = ['feishu-openclaw-plugin']
const LEGACY_FEISHU_AGENT_IDS = ['feishu-bot']
const FEISHU_RUNTIME_DEFAULT_CONNECTION_MODE = 'websocket'
const FEISHU_RUNTIME_DEFAULT_WEBHOOK_PATH = '/feishu/events'
const FEISHU_RUNTIME_DEFAULT_REACTION_NOTIFICATIONS = 'own'

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
  appSecret: unknown
}

function cloneConfig(config: Record<string, any> | null): Record<string, any> {
  if (!config) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeAllowFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const users = new Set<string>()
  for (const item of value) {
    const normalized = normalizeText(item)
    if (normalized) users.add(normalized)
  }
  return Array.from(users)
}

function normalizeLegacyBotDisplayName(rawName: string, accountId: string, isDefault: boolean): string {
  const normalized = normalizeText(rawName)
  if (!normalized) return ''
  if (isDefault && /^默认\s*bot$/i.test(normalized)) return '机器人'
  const normalizedAccountId = normalizeText(accountId)
  if (normalizedAccountId && normalized.toLowerCase() === `bot ${normalizedAccountId}`.toLowerCase()) {
    return `机器人 ${normalizedAccountId}`
  }
  return normalized
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFeishuSecretRefLike(value: unknown): value is { source: 'env' | 'file'; provider: string; id: string } {
  return hasOwnRecord(value)
    && (value.source === 'env' || value.source === 'file')
    && typeof value.provider === 'string'
    && typeof value.id === 'string'
}

function hasFeishuSecretInput(value: unknown): boolean {
  return normalizeText(value).length > 0 || isFeishuSecretRefLike(value)
}

function cloneFeishuSecretInput<T>(value: T): T {
  if (!hasOwnRecord(value)) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function ensureFeishuRoot(config: Record<string, any>): Record<string, any> {
  config.channels = config.channels || {}
  config.channels.feishu = config.channels.feishu || {}
  return config.channels.feishu as Record<string, any>
}

function normalizeFeishuBlockStreamingCoalesce(blockStreaming: unknown): { enabled: boolean } | undefined {
  if (typeof blockStreaming !== 'boolean') return undefined
  return { enabled: blockStreaming }
}

function alignFeishuAccountConfigWithRuntime(account: Record<string, any>): void {
  if (!hasOwnRecord(account)) return

  const allowFrom = normalizeAllowFrom(account.allowFrom)
  if (allowFrom.length > 0) {
    account.allowFrom = allowFrom
  } else {
    delete account.allowFrom
  }

  if (!hasOwnRecord(account.blockStreamingCoalesce)) {
    const nextBlockStreamingCoalesce = normalizeFeishuBlockStreamingCoalesce(account.blockStreaming)
    if (nextBlockStreamingCoalesce) {
      account.blockStreamingCoalesce = nextBlockStreamingCoalesce
    }
  }

  delete account.blockStreaming
}

function alignFeishuChannelConfigWithRuntime(feishu: Record<string, any>): void {
  if (!hasOwnRecord(feishu)) return

  const allowFrom = normalizeAllowFrom(feishu.allowFrom)
  if (allowFrom.length > 0) {
    feishu.allowFrom = allowFrom
  } else {
    delete feishu.allowFrom
  }

  if (!normalizeText(feishu.connectionMode)) {
    feishu.connectionMode = FEISHU_RUNTIME_DEFAULT_CONNECTION_MODE
  }
  if (!normalizeText(feishu.webhookPath)) {
    feishu.webhookPath = FEISHU_RUNTIME_DEFAULT_WEBHOOK_PATH
  }
  if (!normalizeText(feishu.reactionNotifications)) {
    feishu.reactionNotifications = FEISHU_RUNTIME_DEFAULT_REACTION_NOTIFICATIONS
  }
  if (typeof feishu.typingIndicator !== 'boolean') {
    feishu.typingIndicator = true
  }
  if (typeof feishu.resolveSenderNames !== 'boolean') {
    feishu.resolveSenderNames = true
  }

  alignFeishuAccountConfigWithRuntime(feishu)

  if (hasOwnRecord(feishu.accounts)) {
    for (const account of Object.values(feishu.accounts)) {
      if (!hasOwnRecord(account)) continue
      alignFeishuAccountConfigWithRuntime(account)
    }
  }
}

function createDisplayName(rawName: string, accountId: string, isDefault: boolean): string {
  const normalizedLegacyName = normalizeLegacyBotDisplayName(rawName, accountId, isDefault)
  if (normalizedLegacyName) return normalizedLegacyName
  if (isDefault) return '机器人'
  return `机器人 ${accountId}`
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
      agentId: getFeishuManagedAgentId(DEFAULT_FEISHU_ACCOUNT_ID),
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
        agentId: getFeishuManagedAgentId(accountId),
      })
    }
  }

  const sorted = bots.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  const nameCount = new Map<string, number>()
  for (const bot of sorted) {
    nameCount.set(bot.name, (nameCount.get(bot.name) || 0) + 1)
  }
  const nameIndex = new Map<string, number>()
  for (const bot of sorted) {
    if ((nameCount.get(bot.name) || 0) > 1) {
      const idx = (nameIndex.get(bot.name) || 0) + 1
      nameIndex.set(bot.name, idx)
      bot.name = `${bot.name} (${idx})`
    }
  }

  return sorted
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

function stripManagedFeishuRoutingState(config: Record<string, any>): void {
  if (Array.isArray(config?.agents?.list)) {
    config.agents.list = config.agents.list.filter(
      (agent: Record<string, any>) => !isFeishuManagedAgentId(agent?.id)
    )
  }

  if (Array.isArray(config?.bindings)) {
    config.bindings = config.bindings.filter((binding: Record<string, any>) => !(
      normalizeText(binding?.match?.channel) === 'feishu' && isFeishuManagedAgentId(binding?.agentId)
    ))
  }
}

export function addFeishuBotConfig(
  config: Record<string, any> | null,
  input: AddFeishuBotInput
): { nextConfig: Record<string, any>; accountId: string } {
  const name = normalizeText(input.name)
  const appId = normalizeText(input.appId)
  const appSecret = cloneFeishuSecretInput(input.appSecret)

  if (!name) throw new Error('机器人名称不能为空')
  if (!appId) throw new Error('App ID 不能为空')
  if (!hasFeishuSecretInput(appSecret)) throw new Error('App Secret 不能为空')

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
    appSecret: cloneFeishuSecretInput(appSecret),
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
    stripManagedFeishuRoutingState(next)
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
    if (!normalizeText(feishu.appId) || !hasFeishuSecretInput(feishu.appSecret)) {
      throw new Error('默认飞书机器人缺少完整配置，无法直接关联')
    }
  } else {
    const account = feishu.accounts?.[accountId] as Record<string, any> | undefined
    if (!account || !normalizeText(account.appId) || !hasFeishuSecretInput(account.appSecret)) {
      throw new Error('所选飞书机器人缺少完整配置，无法关联')
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
      (item: unknown) => ![BUILTIN_FEISHU_PLUGIN_ID, ...LEGACY_FEISHU_PLUGIN_IDS].includes(String(item || '').trim())
    )
  }

  if (next.plugins.entries && typeof next.plugins.entries === 'object') {
    for (const legacyId of LEGACY_FEISHU_PLUGIN_IDS) {
      delete next.plugins.entries[legacyId]
    }
  }

  if (!hasOwnRecord(next.plugins.entries)) {
    next.plugins.entries = {}
  }
  const currentBuiltInEntry = next.plugins.entries[BUILTIN_FEISHU_PLUGIN_ID]
  next.plugins.entries[BUILTIN_FEISHU_PLUGIN_ID] = hasOwnRecord(currentBuiltInEntry)
    ? {
        ...currentBuiltInEntry,
        enabled: false,
      }
    : { enabled: false }

  if (next.plugins.installs && typeof next.plugins.installs === 'object') {
    for (const legacyId of [BUILTIN_FEISHU_PLUGIN_ID, ...LEGACY_FEISHU_PLUGIN_IDS]) {
      delete next.plugins.installs[legacyId]
    }
  }

  return next
}

export function stripFeishuOfficialPluginConfig(config: Record<string, any> | null): Record<string, any> {
  const next = sanitizeFeishuPluginConfig(config)
  if (Array.isArray(next.plugins?.allow)) {
    next.plugins.allow = next.plugins.allow.filter(
      (item: unknown) => String(item || '').trim() !== 'openclaw-lark'
    )
  }
  if (next.plugins?.entries && typeof next.plugins.entries === 'object') {
    const { ['openclaw-lark']: _removedEntry, ...entries } = next.plugins.entries
    next.plugins.entries = entries
  }
  if (next.plugins?.installs && typeof next.plugins.installs === 'object') {
    const { ['openclaw-lark']: _removedInstall, ...installs } = next.plugins.installs
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
  const next = applyFeishuMultiBotIsolation(sanitizeFeishuPluginConfig(config))
  if (hasOwnRecord(next.channels?.feishu)) {
    alignFeishuChannelConfigWithRuntime(next.channels.feishu)
  }
  return next
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
