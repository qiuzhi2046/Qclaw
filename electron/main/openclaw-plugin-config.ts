const FEISHU_OFFICIAL_PLUGIN_ID = 'feishu'
const LEGACY_PLUGIN_IDS = new Set(['feishu-openclaw-plugin', 'openclaw-lark'])
const LEGACY_PLUGIN_ENTRY_IDS = new Set(['feishu-openclaw-plugin', 'openclaw-lark'])
const LEGACY_PLUGIN_INSTALL_IDS = new Set(['feishu-openclaw-plugin', 'openclaw-lark'])
const FEISHU_RELATED_PLUGIN_IDS = new Set([
  'feishu-openclaw-plugin',
  'openclaw-lark',
  FEISHU_OFFICIAL_PLUGIN_ID,
])

interface TrustedPluginFilterOptions {
  blockedPluginIds?: string[]
}

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config || typeof config !== 'object') return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePluginId(value: unknown): string {
  return String(value || '').trim()
}

function normalizeBlockedPluginIds(values: string[] | undefined): Set<string> {
  return new Set((values || []).map((value) => normalizePluginId(value)).filter(Boolean))
}

function shouldKeepPluginId(value: unknown, blockedPluginIds: Set<string> = new Set()): boolean {
  const pluginId = normalizePluginId(value)
  return !!pluginId && !LEGACY_PLUGIN_IDS.has(pluginId) && !blockedPluginIds.has(pluginId)
}

function pushUniquePluginId(target: string[], seen: Set<string>, value: unknown, blockedPluginIds: Set<string>): void {
  const pluginId = normalizePluginId(value)
  if (!shouldKeepPluginId(pluginId, blockedPluginIds) || seen.has(pluginId)) return
  seen.add(pluginId)
  target.push(pluginId)
}

function hasFeishuPluginContext(config: Record<string, any> | null | undefined): boolean {
  if (hasOwnRecord(config?.channels?.feishu)) {
    return true
  }

  const plugins = config?.plugins
  if (Array.isArray(plugins?.allow)) {
    for (const pluginId of plugins.allow) {
      if (FEISHU_RELATED_PLUGIN_IDS.has(normalizePluginId(pluginId))) {
        return true
      }
    }
  }

  if (hasOwnRecord(plugins?.entries)) {
    for (const pluginId of Object.keys(plugins.entries)) {
      if (FEISHU_RELATED_PLUGIN_IDS.has(normalizePluginId(pluginId))) {
        return true
      }
    }
  }

  if (hasOwnRecord(plugins?.installs)) {
    for (const pluginId of Object.keys(plugins.installs)) {
      if (FEISHU_RELATED_PLUGIN_IDS.has(normalizePluginId(pluginId))) {
        return true
      }
    }
  }

  return false
}

export function sanitizeManagedPluginConfig(
  config: Record<string, any> | null | undefined,
  options: {
    preserveBuiltInFeishuDisable?: boolean
    blockedPluginIds?: string[]
  } = {}
): { changed: boolean; config: Record<string, any> } {
  const nextConfig = cloneConfig(config)
  const blockedPluginIds = normalizeBlockedPluginIds(options.blockedPluginIds)
  const plugins = hasOwnRecord(nextConfig.plugins) ? nextConfig.plugins : null
  if (!plugins) {
    return { changed: false, config: nextConfig }
  }

  let changed = false

  if (Array.isArray(plugins.allow)) {
    const filteredAllow = plugins.allow.filter((pluginId: unknown) => shouldKeepPluginId(pluginId, blockedPluginIds))
    if (filteredAllow.length !== plugins.allow.length) {
      plugins.allow = filteredAllow
      changed = true
    }
  }

  if (plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)) {
    for (const pluginId of new Set([...LEGACY_PLUGIN_ENTRY_IDS, ...blockedPluginIds])) {
      if (pluginId in plugins.entries) {
        delete plugins.entries[pluginId]
        changed = true
      }
    }
  }

  if (plugins.installs && typeof plugins.installs === 'object' && !Array.isArray(plugins.installs)) {
    for (const pluginId of new Set([...LEGACY_PLUGIN_INSTALL_IDS, ...blockedPluginIds])) {
      if (pluginId in plugins.installs) {
        delete plugins.installs[pluginId]
        changed = true
      }
    }
  }

  return {
    changed,
    config: nextConfig,
  }
}

function collectTrustedPluginIds(
  config: Record<string, any> | null | undefined,
  options: TrustedPluginFilterOptions = {}
): string[] {
  const trustedIds: string[] = []
  const seen = new Set<string>()
  const blockedPluginIds = normalizeBlockedPluginIds(options.blockedPluginIds)
  const plugins = config?.plugins

  if (Array.isArray(plugins?.allow)) {
    for (const pluginId of plugins.allow) {
      pushUniquePluginId(trustedIds, seen, pluginId, blockedPluginIds)
    }
  }

  if (plugins?.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)) {
    for (const pluginId of Object.keys(plugins.entries)) {
      pushUniquePluginId(trustedIds, seen, pluginId, blockedPluginIds)
    }
  }

  if (plugins?.installs && typeof plugins.installs === 'object' && !Array.isArray(plugins.installs)) {
    for (const pluginId of Object.keys(plugins.installs)) {
      pushUniquePluginId(trustedIds, seen, pluginId, blockedPluginIds)
    }
  }

  return trustedIds
}

export interface ReconcileTrustedPluginAllowlistResult {
  changed: boolean
  config: Record<string, any>
  trustedPluginIds: string[]
  restoredPluginIds: string[]
}

export function reconcileTrustedPluginAllowlist(
  config: Record<string, any> | null | undefined,
  options: TrustedPluginFilterOptions = {}
): ReconcileTrustedPluginAllowlistResult {
  const blockedPluginIds = normalizeBlockedPluginIds(options.blockedPluginIds)
  const sanitized = sanitizeManagedPluginConfig(cloneConfig(config), {
    blockedPluginIds: [...blockedPluginIds],
  })
  const nextConfig = sanitized.config
  const trustedPluginIds = collectTrustedPluginIds(nextConfig, {
    blockedPluginIds: [...blockedPluginIds],
  })
  if (trustedPluginIds.length === 0) {
    return {
      changed: sanitized.changed,
      config: nextConfig,
      trustedPluginIds,
      restoredPluginIds: [],
    }
  }

  nextConfig.plugins = nextConfig.plugins || {}
  const allow = Array.isArray(nextConfig.plugins.allow) ? nextConfig.plugins.allow : []
  const allowSet = new Set(
    allow
      .map((pluginId: unknown) => normalizePluginId(pluginId))
      .filter((pluginId: string) => shouldKeepPluginId(pluginId, blockedPluginIds))
  )
  const restoredPluginIds: string[] = []

  for (const pluginId of trustedPluginIds) {
    if (allowSet.has(pluginId)) continue
    allowSet.add(pluginId)
    allow.push(pluginId)
    restoredPluginIds.push(pluginId)
  }

  if (restoredPluginIds.length === 0 && Array.isArray(nextConfig.plugins.allow)) {
    return {
      changed: sanitized.changed,
      config: nextConfig,
      trustedPluginIds,
      restoredPluginIds,
    }
  }

  nextConfig.plugins.allow = allow
  return {
    changed: sanitized.changed || restoredPluginIds.length > 0 || !Array.isArray(config?.plugins?.allow),
    config: nextConfig,
    trustedPluginIds,
    restoredPluginIds,
  }
}

export interface RestoreTrustedPluginConfigResult {
  changed: boolean
  config: Record<string, any>
  restoredPluginIds: string[]
}

export function restoreTrustedPluginConfig(
  referenceConfig: Record<string, any> | null | undefined,
  nextConfigInput: Record<string, any> | null | undefined,
  options: TrustedPluginFilterOptions = {}
): RestoreTrustedPluginConfigResult {
  const blockedPluginIds = normalizeBlockedPluginIds(options.blockedPluginIds)
  const preserveBuiltInFeishuDisable =
    hasFeishuPluginContext(referenceConfig) || hasFeishuPluginContext(nextConfigInput)
  const referenceConfigClone = sanitizeManagedPluginConfig(cloneConfig(referenceConfig), {
    preserveBuiltInFeishuDisable,
    blockedPluginIds: [...blockedPluginIds],
  }).config
  const sanitizedNext = sanitizeManagedPluginConfig(cloneConfig(nextConfigInput), {
    preserveBuiltInFeishuDisable,
    blockedPluginIds: [...blockedPluginIds],
  })
  const nextConfig = sanitizedNext.config
  const referencePlugins = referenceConfigClone.plugins
  const trustedPluginIds = collectTrustedPluginIds(referenceConfigClone, {
    blockedPluginIds: [...blockedPluginIds],
  })

  if (trustedPluginIds.length === 0) {
    return {
      changed: sanitizedNext.changed,
      config: nextConfig,
      restoredPluginIds: [],
    }
  }

  nextConfig.plugins = nextConfig.plugins || {}
  const nextPlugins = nextConfig.plugins
  const restoredPluginIds: string[] = []

  const allow = Array.isArray(nextPlugins.allow) ? nextPlugins.allow : []
  const allowSet = new Set(
    allow
      .map((pluginId: unknown) => normalizePluginId(pluginId))
      .filter((pluginId: string) => shouldKeepPluginId(pluginId, blockedPluginIds))
  )

  for (const pluginId of trustedPluginIds) {
    let restoredThisPlugin = false

    if (!allowSet.has(pluginId)) {
      allowSet.add(pluginId)
      allow.push(pluginId)
      restoredThisPlugin = true
    }

    if (
      referencePlugins?.entries &&
      typeof referencePlugins.entries === 'object' &&
      !Array.isArray(referencePlugins.entries) &&
      referencePlugins.entries[pluginId] !== undefined
    ) {
      if (!nextPlugins.entries || typeof nextPlugins.entries !== 'object' || Array.isArray(nextPlugins.entries)) {
        nextPlugins.entries = {}
      }
      if (nextPlugins.entries[pluginId] === undefined) {
        nextPlugins.entries[pluginId] = cloneConfig(referencePlugins.entries[pluginId])
        restoredThisPlugin = true
      }
    }

    if (
      referencePlugins?.installs &&
      typeof referencePlugins.installs === 'object' &&
      !Array.isArray(referencePlugins.installs) &&
      referencePlugins.installs[pluginId] !== undefined
    ) {
      if (!nextPlugins.installs || typeof nextPlugins.installs !== 'object' || Array.isArray(nextPlugins.installs)) {
        nextPlugins.installs = {}
      }
      if (nextPlugins.installs[pluginId] === undefined) {
        nextPlugins.installs[pluginId] = cloneConfig(referencePlugins.installs[pluginId])
        restoredThisPlugin = true
      }
    }

    if (restoredThisPlugin) {
      restoredPluginIds.push(pluginId)
    }
  }

  if (restoredPluginIds.length === 0 && Array.isArray(nextPlugins.allow)) {
    return {
      changed: sanitizedNext.changed,
      config: nextConfig,
      restoredPluginIds,
    }
  }

  nextPlugins.allow = allow
  return {
    changed:
      sanitizedNext.changed ||
      restoredPluginIds.length > 0 ||
      !Array.isArray(nextConfigInput?.plugins?.allow),
    config: nextConfig,
    restoredPluginIds,
  }
}
