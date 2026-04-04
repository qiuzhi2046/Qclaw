const DEFAULT_FEISHU_ACCOUNT_ID = 'default'
const FEISHU_AGENT_ID_PREFIX = 'feishu-'
const FEISHU_DM_SCOPE = 'per-account-channel-peer'
const LEGACY_FEISHU_AGENT_IDS = ['feishu-bot']

export interface FeishuRoutingBot {
  accountId: string
  name: string
}

export interface FeishuManagedAgent {
  id: string
  name: string
  workspace: string
}

export interface FeishuManagedBinding {
  agentId: string
  match: {
    channel: 'feishu'
    accountId: string
  }
}

export interface FeishuIsolationDrift {
  needsRepair: boolean
  hasMultipleBots: boolean
  dmScopeCorrect: boolean
  missingAgentIds: string[]
  missingBindingAccountIds: string[]
  workspaceMismatches: string[]
  conflictingBindingAccountIds: string[]
}

function cloneConfig(config: Record<string, any> | null): Record<string, any> {
  if (!config) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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

function createDisplayName(rawName: string, accountId: string, isDefault: boolean): string {
  const normalizedLegacyName = normalizeLegacyBotDisplayName(rawName, accountId, isDefault)
  if (normalizedLegacyName) return normalizedLegacyName
  if (isDefault) return '机器人'
  return `机器人 ${accountId}`
}

export function getFeishuManagedAgentId(accountId: string): string {
  return `${FEISHU_AGENT_ID_PREFIX}${accountId === DEFAULT_FEISHU_ACCOUNT_ID ? 'default' : accountId}`
}

export function getFeishuManagedWorkspace(accountId: string): string {
  return `~/.openclaw/workspace-feishu-${accountId === DEFAULT_FEISHU_ACCOUNT_ID ? 'default' : accountId}`
}

export function isFeishuManagedAgentId(agentId: unknown): boolean {
  const normalized = normalizeText(agentId)
  return normalized === `${FEISHU_AGENT_ID_PREFIX}default` || normalized.startsWith(FEISHU_AGENT_ID_PREFIX)
}

export function extractFeishuRoutingBots(config: Record<string, any> | null): FeishuRoutingBot[] {
  const feishu = config?.channels?.feishu as Record<string, any> | undefined
  if (!feishu || typeof feishu !== 'object') return []

  const bots: FeishuRoutingBot[] = []
  const defaultAppId = normalizeText(feishu.appId)
  if (defaultAppId) {
    bots.push({
      accountId: DEFAULT_FEISHU_ACCOUNT_ID,
      name: createDisplayName(normalizeText(feishu.name), DEFAULT_FEISHU_ACCOUNT_ID, true),
    })
  }

  const accounts = feishu.accounts as Record<string, any> | undefined
  if (accounts && typeof accounts === 'object') {
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
      const account = rawAccount as Record<string, any>
      if (!normalizeText(account.appId)) continue
      bots.push({
        accountId,
        name: createDisplayName(normalizeText(account.name), accountId, false),
      })
    }
  }

  return bots.sort((left, right) => {
    if (left.accountId === DEFAULT_FEISHU_ACCOUNT_ID) return -1
    if (right.accountId === DEFAULT_FEISHU_ACCOUNT_ID) return 1
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}

export function buildExpectedFeishuAgents(bots: FeishuRoutingBot[]): FeishuManagedAgent[] {
  return bots.map((bot) => ({
    id: getFeishuManagedAgentId(bot.accountId),
    name: `${bot.name} Agent`,
    workspace: getFeishuManagedWorkspace(bot.accountId),
  }))
}

export function buildExpectedFeishuBindings(bots: FeishuRoutingBot[]): FeishuManagedBinding[] {
  return bots.map((bot) => ({
    agentId: getFeishuManagedAgentId(bot.accountId),
    match: {
      channel: 'feishu',
      accountId: bot.accountId,
    },
  }))
}

function isMatchingFeishuBinding(binding: Record<string, any>, accountId: string, agentId: string): boolean {
  return (
    normalizeText(binding?.agentId) === agentId &&
    normalizeText(binding?.match?.channel) === 'feishu' &&
    normalizeText(binding?.match?.accountId) === accountId
  )
}

function isResidualLegacyFeishuAgentId(agentId: unknown, expectedAgentIds: Set<string>): boolean {
  const normalized = normalizeText(agentId)
  return (
    LEGACY_FEISHU_AGENT_IDS.includes(normalized)
    && expectedAgentIds.has(getFeishuManagedAgentId(DEFAULT_FEISHU_ACCOUNT_ID))
    && !expectedAgentIds.has(normalized)
  )
}

function getLegacyFeishuMigrationSeed(
  expectedAgentId: string,
  currentAgents: Record<string, any>[]
): Record<string, any> | null {
  if (expectedAgentId !== getFeishuManagedAgentId(DEFAULT_FEISHU_ACCOUNT_ID)) {
    return null
  }

  return currentAgents.find(
    (agent: Record<string, any>) => normalizeText(agent?.id) === LEGACY_FEISHU_AGENT_IDS[0]
  ) || null
}

function buildManagedFeishuAgentConfig(
  expectedAgent: FeishuManagedAgent,
  currentAgents: Record<string, any>[]
): Record<string, any> {
  const existingAgent = currentAgents.find(
    (agent: Record<string, any>) => normalizeText(agent?.id) === expectedAgent.id
  )
  const legacySeed = getLegacyFeishuMigrationSeed(expectedAgent.id, currentAgents)
  const migratedLegacy = hasOwnRecord(legacySeed) ? { ...legacySeed } : {}

  delete migratedLegacy.id
  delete migratedLegacy.name
  delete migratedLegacy.workspace
  delete migratedLegacy.default

  return {
    ...migratedLegacy,
    ...(hasOwnRecord(existingAgent) ? existingAgent : {}),
    id: expectedAgent.id,
    name: expectedAgent.name,
    workspace: expectedAgent.workspace,
  }
}

export function applyFeishuMultiBotIsolation(config: Record<string, any> | null): Record<string, any> {
  // 多机器人隔离功能已禁用 - 直接返回原配置
  return cloneConfig(config)
}

export function detectFeishuIsolationDrift(config: Record<string, any> | null): FeishuIsolationDrift {
  const bots = extractFeishuRoutingBots(config)
  const expectedAgents = buildExpectedFeishuAgents(bots)
  const expectedBindings = buildExpectedFeishuBindings(bots)
  const currentAgents = Array.isArray(config?.agents?.list) ? config?.agents?.list : []
  const currentBindings = Array.isArray(config?.bindings) ? config?.bindings : []

  const missingAgentIds: string[] = []
  const workspaceMismatches: string[] = []
  for (const expectedAgent of expectedAgents) {
    const existingAgent = currentAgents.find(
      (agent: Record<string, any>) => normalizeText(agent?.id) === expectedAgent.id
    )
    if (!existingAgent) {
      missingAgentIds.push(expectedAgent.id)
      continue
    }
    if (normalizeText(existingAgent.workspace) !== expectedAgent.workspace) {
      workspaceMismatches.push(expectedAgent.id)
    }
  }

  const missingBindingAccountIds: string[] = []
  const conflictingBindingAccountIds: string[] = []
  for (const expectedBinding of expectedBindings) {
    const matchingBindings = currentBindings.filter(
      (binding) =>
        normalizeText(binding?.match?.channel) === 'feishu' &&
        normalizeText(binding?.match?.accountId) === expectedBinding.match.accountId
    )
    if (!matchingBindings.some((binding) => normalizeText(binding?.agentId) === expectedBinding.agentId)) {
      missingBindingAccountIds.push(expectedBinding.match.accountId)
    }
    if (matchingBindings.some((binding) => normalizeText(binding?.agentId) !== expectedBinding.agentId)) {
      conflictingBindingAccountIds.push(expectedBinding.match.accountId)
    }
  }

  const dmScopeCorrect = normalizeText(config?.session?.dmScope) === FEISHU_DM_SCOPE

  return {
    needsRepair:
      !dmScopeCorrect ||
      missingAgentIds.length > 0 ||
      missingBindingAccountIds.length > 0 ||
      workspaceMismatches.length > 0 ||
      conflictingBindingAccountIds.length > 0,
    hasMultipleBots: bots.length > 1,
    dmScopeCorrect,
    missingAgentIds,
    missingBindingAccountIds,
    workspaceMismatches,
    conflictingBindingAccountIds,
  }
}
