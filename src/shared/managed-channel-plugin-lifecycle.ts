import { getManagedChannelPluginByChannelId, listManagedChannelPluginRecords } from './managed-channel-plugin-registry'

export type ManagedChannelLifecycleId =
  | 'feishu'
  | 'wecom'
  | 'dingtalk'
  | 'qqbot'
  | 'openclaw-weixin'

export type ManagedChannelInstallStrategy =
  | 'official-adapter'
  | 'package'
  | 'npx'
  | 'interactive-installer'

export type ManagedChannelPluginScope = 'channel'
export type ManagedChannelEntityScope = 'channel' | 'account' | 'bot'

export type ManagedChannelSetupEvidenceSource =
  | 'doctor'
  | 'repair'
  | 'plugin-install'
  | 'config'
  | 'gateway'
  | 'plugin-probe'
  | 'plugins-list'
  | 'disk'
  | 'status'

export interface ManagedChannelSetupEvidence {
  source: ManagedChannelSetupEvidenceSource
  message: string
  detail?: string
  pluginId?: string
  channelId?: string
  command?: string
  jsonPaths?: string[]
}

export type ManagedChannelPluginStatusStageId = 'installed' | 'registered' | 'loaded' | 'ready'
export type ManagedChannelPluginStatusStageState = 'verified' | 'missing' | 'unknown'

export interface ManagedChannelPluginStatusStage {
  id: ManagedChannelPluginStatusStageId
  state: ManagedChannelPluginStatusStageState
  source: string
  message: string
}

export interface ManagedChannelPluginStatusView {
  channelId: string
  pluginId: string
  summary: string
  stages: ManagedChannelPluginStatusStage[]
  evidence: ManagedChannelSetupEvidence[]
}

export interface ManagedChannelCapabilitySnapshot {
  supportsStatusProbe: boolean
  supportsGatewayReload: boolean
  supportsBackgroundRestore: boolean
  supportsInteractiveRepair: boolean
  blockedReasons: string[]
}

export interface ManagedChannelRuntimeSnapshot {
  installedOnDisk: boolean
  installPath?: string
  registeredState: 'ready' | 'missing' | 'unknown'
  loadedState: 'ready' | 'missing' | 'unknown'
  readyState: 'ready' | 'missing' | 'unknown'
  evidence: string[]
}

export interface ManagedChannelLifecycleContext {
  referenceConfig: Record<string, any> | null | undefined
  currentConfig: Record<string, any> | null | undefined
  runtime: ManagedChannelRuntimeSnapshot
  capabilities: ManagedChannelCapabilitySnapshot
}

export interface ManagedChannelPluginLifecycleSpec {
  channelId: ManagedChannelLifecycleId
  pluginScope: ManagedChannelPluginScope
  entityScope: ManagedChannelEntityScope
  canonicalPluginId: string
  cleanupPluginIds: string[]
  cleanupChannelIds: string[]
  installStrategy: ManagedChannelInstallStrategy
  packageName?: string
  npxSpecifier?: string
  supportsBackgroundRestore: boolean
  supportsInteractiveRepairUi: boolean
  detectConfigured(context: ManagedChannelLifecycleContext): boolean
  /**
   * @deprecated Use reconcileConfig instead. Will be removed after Phase 1 migration.
   */
  normalizeConfig(
    config: Record<string, any> | null | undefined,
    runtime: ManagedChannelRuntimeSnapshot
  ): { config: Record<string, any>; changed: boolean }
  /**
   * Reconcile channel-specific plugin configuration.
   * Replaces normalizeConfig with richer runtime context.
   *
   * - feishu: legacy cleanup + official plugin state + multi-bot isolation
   * - dingtalk: legacy cleanup + fallback config validation
   * - wecom/qqbot: generic cleanup (cleanup IDs removal, canonical allow)
   * - openclaw-weixin: conditional cleanup (only when installedOnDisk=true)
   */
  reconcileConfig(
    config: Record<string, any> | null | undefined,
    runtime: { installedOnDisk: boolean; installPath: string; homeDir: string }
  ): { config: Record<string, any>; changed: boolean }
  /**
   * Channel-specific preflight hook. Called during unified preflight
   * after config reconciliation but before readiness check.
   *
   * - dingtalk: runs `openclaw doctor --fix --non-interactive`
   * - others: undefined (no channel-specific preflight needed)
   */
  preflightHook?: (context: {
    homeDir: string
    config: Record<string, any>
  }) => Promise<{ ok: boolean; evidence?: string[]; error?: string }>
  /**
   * Channel-specific readiness check.
   *
   * - feishu: installedOnDisk && officialPluginConfigured
   * - others: installedOnDisk && registeredInPluginsList
   */
  isReady?: (state: {
    installedOnDisk: boolean
    registeredInPluginsList: boolean
    configuredInConfig: boolean
  }) => boolean
}

export type ManagedChannelPluginInspectResult =
  | {
      kind: 'ok'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      status: ManagedChannelPluginStatusView
      runtime: ManagedChannelRuntimeSnapshot
      capabilities: ManagedChannelCapabilitySnapshot
    }
  | {
      kind: 'config-sync-required'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      status: ManagedChannelPluginStatusView
      reason: string
    }
  | {
      kind: 'plugin-ready-channel-not-ready'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      status: ManagedChannelPluginStatusView
      blockingReason: string
    }
  | {
      kind: 'capability-blocked'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      status: ManagedChannelPluginStatusView
      missingCapabilities: string[]
    }
  | {
      kind: 'inspection-failed'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      error: string
    }

export type ManagedChannelPluginPrepareResult =
  | {
      kind: 'ok'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      action: 'reuse-installed' | 'install-before-setup' | 'repair-before-setup'
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'manual-action-required'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      action: 'launch-interactive-installer'
      reason: string
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'config-sync-required'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      reason: string
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'capability-blocked'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      missingCapabilities: string[]
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'prepare-failed'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      error: string
    }

export type ManagedChannelPluginRepairResult =
  | {
      kind: 'ok'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      action: 'reused-existing' | 'restored' | 'installed'
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'manual-action-required'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      action: 'launch-interactive-installer'
      reason: string
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'config-sync-required'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      reason: string
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'plugin-ready-channel-not-ready'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      blockingReason: string
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'gateway-reload-failed'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      reloadReason: string
      retryable?: boolean
      status: ManagedChannelPluginStatusView
      rolledBack?: boolean
      failedPhase?: string
      rollbackError?: string
    }
  | {
      kind: 'quarantine-failed'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      failureKind: 'permission-denied' | 'filesystem-write-failed' | 'partial-quarantine'
      failedPluginIds: string[]
      failedPaths: string[]
      status: ManagedChannelPluginStatusView
      rolledBack?: boolean
      failedPhase?: string
      rollbackError?: string
    }
  | {
      kind: 'install-failed'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      attemptedInstaller: ManagedChannelInstallStrategy
      status: ManagedChannelPluginStatusView
      error: string
      rolledBack?: boolean
      failedPhase?: string
      rollbackError?: string
    }
  | {
      kind: 'capability-blocked'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      missingCapabilities: string[]
      status: ManagedChannelPluginStatusView
    }
  | {
      kind: 'repair-failed'
      channelId: string
      pluginScope: 'channel'
      entityScope: ManagedChannelEntityScope
      status: ManagedChannelPluginStatusView
      error: string
      rolledBack?: boolean
      failedPhase?: string
      rollbackError?: string
    }

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!hasOwnRecord(config)) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function getLastPathSegment(value: string): string {
  const segments = String(value || '').split(/[\\/]+/).filter(Boolean)
  return segments[segments.length - 1] || ''
}

function hasNonCanonicalManagedInstallPath(
  value: unknown,
  canonicalPluginId: string
): boolean {
  if (!hasOwnRecord(value)) return false
  const installPath = normalizeText(value.installPath)
  if (!installPath) return false

  return getLastPathSegment(installPath) !== canonicalPluginId
}

function hasCompleteCredentials(channelConfig: unknown, keys: string[]): boolean {
  if (!hasOwnRecord(channelConfig)) return false
  return keys.every((key) => normalizeText(channelConfig[key]).length > 0)
}

function hasConfigSecretInput(value: unknown): boolean {
  return (
    (typeof value === 'string' && value.trim().length > 0)
    || (
      hasOwnRecord(value)
      && (value.source === 'env' || value.source === 'file')
      && typeof value.provider === 'string'
      && typeof value.id === 'string'
    )
  )
}

function hasConfiguredFeishuChannel(config: Record<string, any> | null | undefined): boolean {
  const feishu = config?.channels?.feishu
  if (hasOwnRecord(feishu) && normalizeText(feishu.appId).length > 0 && hasConfigSecretInput(feishu.appSecret)) {
    return true
  }

  const accounts = hasOwnRecord(feishu) && hasOwnRecord(feishu.accounts)
    ? feishu.accounts
    : null
  if (!accounts) return false

  return Object.values(accounts).some((account) =>
    hasOwnRecord(account)
    && normalizeText(account.appId).length > 0
    && hasConfigSecretInput(account.appSecret)
  )
}

function hasConfiguredWecomChannel(config: Record<string, any> | null | undefined): boolean {
  return hasCompleteCredentials(config?.channels?.wecom, ['botId', 'secret'])
}

function hasConfiguredDingtalkChannel(config: Record<string, any> | null | undefined): boolean {
  const dingtalk = config?.channels?.['dingtalk-connector'] || config?.channels?.dingtalk
  return hasCompleteCredentials(dingtalk, ['clientId', 'clientSecret'])
}

function hasConfiguredQqbotChannel(config: Record<string, any> | null | undefined): boolean {
  const qqbot = config?.channels?.qqbot
  return Boolean(
    hasOwnRecord(qqbot)
    && normalizeText(qqbot.appId)
    && (normalizeText(qqbot.clientSecret) || normalizeText(qqbot.appSecret))
  )
}

function hasConfiguredWeixinChannel(config: Record<string, any> | null | undefined): boolean {
  const weixin = config?.channels?.['openclaw-weixin']
  if (!hasOwnRecord(weixin)) return false
  if (weixin.enabled === true) return true

  const accounts = hasOwnRecord(weixin.accounts) ? weixin.accounts : null
  return Boolean(accounts && Object.keys(accounts).length > 0)
}

function normalizeGenericManagedPluginConfig(
  config: Record<string, any> | null | undefined,
  canonicalPluginId: string,
  cleanupPluginIds: string[]
): { config: Record<string, any>; changed: boolean } {
  const next = cloneConfig(config)
  next.plugins = hasOwnRecord(next.plugins) ? next.plugins : {}

  const blockedPluginIds = new Set(
    cleanupPluginIds
      .map((item) => normalizeText(item))
      .filter((item) => item && item !== canonicalPluginId)
  )
  let changed = false

  const allow = Array.isArray(next.plugins.allow)
    ? next.plugins.allow.map((item: unknown) => normalizeText(item)).filter(Boolean)
    : []
  const normalizedAllow = allow.filter((item: string) => !blockedPluginIds.has(item))
  if (!normalizedAllow.includes(canonicalPluginId)) {
    normalizedAllow.push(canonicalPluginId)
  }
  if (JSON.stringify(allow) !== JSON.stringify(normalizedAllow)) {
    next.plugins.allow = normalizedAllow
    changed = true
  } else if (!Array.isArray(next.plugins.allow)) {
    next.plugins.allow = normalizedAllow
    changed = true
  }

  for (const key of ['entries', 'installs'] as const) {
    if (!hasOwnRecord(next.plugins[key])) continue

    if (hasNonCanonicalManagedInstallPath(next.plugins[key][canonicalPluginId], canonicalPluginId)) {
      delete next.plugins[key][canonicalPluginId]
      changed = true
    }

    for (const blockedPluginId of blockedPluginIds) {
      if (!(blockedPluginId in next.plugins[key])) continue
      delete next.plugins[key][blockedPluginId]
      changed = true
    }
  }

  return {
    config: next,
    changed,
  }
}

function createRuntimeSnapshot(runtime?: Partial<ManagedChannelRuntimeSnapshot>): ManagedChannelRuntimeSnapshot {
  return {
    installedOnDisk: runtime?.installedOnDisk === true,
    installPath: normalizeText(runtime?.installPath) || undefined,
    registeredState: runtime?.registeredState || 'unknown',
    loadedState: runtime?.loadedState || 'unknown',
    readyState: runtime?.readyState || 'unknown',
    evidence: Array.isArray(runtime?.evidence) ? [...runtime!.evidence] : [],
  }
}

function buildLifecycleSpec(channelId: ManagedChannelLifecycleId): ManagedChannelPluginLifecycleSpec {
  const record = getManagedChannelPluginByChannelId(channelId)
  if (!record) {
    throw new Error(`Unknown managed channel lifecycle spec: ${channelId}`)
  }

  if (channelId === 'feishu') {
    return {
      channelId,
      pluginScope: 'channel',
      entityScope: 'bot',
      canonicalPluginId: record.pluginId,
      cleanupPluginIds: record.cleanupPluginIds,
      cleanupChannelIds: record.cleanupChannelIds,
      installStrategy: 'official-adapter',
      supportsBackgroundRestore: true,
      supportsInteractiveRepairUi: true,
      detectConfigured: ({ referenceConfig, currentConfig }) =>
        hasConfiguredFeishuChannel(referenceConfig) || hasConfiguredFeishuChannel(currentConfig),
      normalizeConfig: (config) => ({
        config: cloneConfig(config),
        changed: false,
      }),
      // Feishu reconciliation requires main-process imports (sanitizeManagedPluginConfig,
      // reconcileTrustedPluginAllowlist, applyFeishuMultiBotIsolation) that can't live in
      // src/shared/. The real logic is in reconcileFeishuPluginConfig (electron/main/
      // feishu-official-plugin-state.ts), called by the reconciler directly.
      // Do NOT call spec.reconcileConfig() for feishu outside the reconciler.
      reconcileConfig: (config) => ({
        config: cloneConfig(config),
        changed: false,
      }),
      isReady: (state) => state.installedOnDisk && state.configuredInConfig,
    }
  }

  if (channelId === 'dingtalk') {
    return {
      channelId,
      pluginScope: 'channel',
      entityScope: 'channel',
      canonicalPluginId: record.pluginId,
      cleanupPluginIds: record.cleanupPluginIds,
      cleanupChannelIds: record.cleanupChannelIds,
      installStrategy: 'official-adapter',
      packageName: record.packageName,
      supportsBackgroundRestore: true,
      supportsInteractiveRepairUi: true,
      detectConfigured: ({ referenceConfig, currentConfig }) =>
        hasConfiguredDingtalkChannel(referenceConfig) || hasConfiguredDingtalkChannel(currentConfig),
      normalizeConfig: (config) => normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds),
      reconcileConfig: (config) => normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds),
      isReady: (state) => state.installedOnDisk && state.registeredInPluginsList,
    }
  }

  if (channelId === 'wecom') {
    return {
      channelId,
      pluginScope: 'channel',
      entityScope: 'channel',
      canonicalPluginId: record.pluginId,
      cleanupPluginIds: record.cleanupPluginIds,
      cleanupChannelIds: record.cleanupChannelIds,
      installStrategy: 'npx',
      npxSpecifier: record.npxSpecifier,
      supportsBackgroundRestore: true,
      supportsInteractiveRepairUi: true,
      detectConfigured: ({ referenceConfig, currentConfig }) =>
        hasConfiguredWecomChannel(referenceConfig) || hasConfiguredWecomChannel(currentConfig),
      normalizeConfig: (config) => normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds),
      reconcileConfig: (config) => normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds),
      isReady: (state) => state.installedOnDisk && state.registeredInPluginsList,
    }
  }

  if (channelId === 'qqbot') {
    return {
      channelId,
      pluginScope: 'channel',
      entityScope: 'channel',
      canonicalPluginId: record.pluginId,
      cleanupPluginIds: record.cleanupPluginIds,
      cleanupChannelIds: record.cleanupChannelIds,
      installStrategy: 'package',
      packageName: record.packageName,
      supportsBackgroundRestore: true,
      supportsInteractiveRepairUi: true,
      detectConfigured: ({ referenceConfig, currentConfig }) =>
        hasConfiguredQqbotChannel(referenceConfig) || hasConfiguredQqbotChannel(currentConfig),
      normalizeConfig: (config) => normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds),
      reconcileConfig: (config) => normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds),
      isReady: (state) => state.installedOnDisk && state.registeredInPluginsList,
    }
  }

  return {
    channelId: 'openclaw-weixin',
    pluginScope: 'channel',
    entityScope: 'account',
    canonicalPluginId: record.pluginId,
    cleanupPluginIds: record.cleanupPluginIds,
    cleanupChannelIds: record.cleanupChannelIds,
    installStrategy: 'interactive-installer',
    packageName: record.packageName,
    npxSpecifier: record.npxSpecifier,
    supportsBackgroundRestore: false,
    supportsInteractiveRepairUi: true,
    detectConfigured: ({ referenceConfig, currentConfig }) =>
      hasConfiguredWeixinChannel(referenceConfig) || hasConfiguredWeixinChannel(currentConfig),
    normalizeConfig: (config, runtime) => {
      if (!runtime.installedOnDisk) {
        return {
          config: cloneConfig(config),
          changed: false,
        }
      }
      return normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds)
    },
    reconcileConfig: (config, runtime) => {
      if (!runtime.installedOnDisk) {
        return {
          config: cloneConfig(config),
          changed: false,
        }
      }
      return normalizeGenericManagedPluginConfig(config, record.pluginId, record.cleanupPluginIds)
    },
    isReady: (state) => state.installedOnDisk && state.registeredInPluginsList,
  }
}

const MANAGED_CHANNEL_LIFECYCLE_SPECS: ManagedChannelPluginLifecycleSpec[] =
  listManagedChannelPluginRecords().map((record) => buildLifecycleSpec(record.channelId as ManagedChannelLifecycleId))

export function listManagedChannelLifecycleSpecs(): ManagedChannelPluginLifecycleSpec[] {
  return MANAGED_CHANNEL_LIFECYCLE_SPECS.map((spec) => ({
    ...spec,
    cleanupPluginIds: [...spec.cleanupPluginIds],
    cleanupChannelIds: [...spec.cleanupChannelIds],
  }))
}

export function getManagedChannelLifecycleSpec(
  channelId: string
): ManagedChannelPluginLifecycleSpec | null {
  const normalizedChannelId = normalizeText(channelId).toLowerCase()
  const spec = MANAGED_CHANNEL_LIFECYCLE_SPECS.find((item) => item.channelId === normalizedChannelId)
  return spec
    ? {
        ...spec,
        cleanupPluginIds: [...spec.cleanupPluginIds],
        cleanupChannelIds: [...spec.cleanupChannelIds],
      }
    : null
}

export function createManagedChannelCapabilitySnapshot(params: {
  supportsBackgroundRestore: boolean
  supportsInteractiveRepair: boolean
  blockedReasons?: string[]
}): ManagedChannelCapabilitySnapshot {
  return {
    supportsStatusProbe: true,
    supportsGatewayReload: true,
    supportsBackgroundRestore: params.supportsBackgroundRestore,
    supportsInteractiveRepair: params.supportsInteractiveRepair,
    blockedReasons: [...(params.blockedReasons || [])],
  }
}

export function createManagedChannelRuntimeSnapshot(
  runtime?: Partial<ManagedChannelRuntimeSnapshot>
): ManagedChannelRuntimeSnapshot {
  return createRuntimeSnapshot(runtime)
}
