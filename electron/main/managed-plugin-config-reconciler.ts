import {
  getManagedChannelLifecycleSpec,
  type ManagedChannelLifecycleId,
} from '../../src/shared/managed-channel-plugin-lifecycle'
import { listManagedChannelPluginRecords } from '../../src/shared/managed-channel-plugin-registry'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import { readConfig } from './cli'
import { reconcileFeishuPluginConfig } from './feishu-official-plugin-state'

const fsp = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

export type ReconcileCaller =
  | 'startup-repair'
  | 'preflight'
  | 'manual-repair'
  | 'gateway-self-heal'
  | 'page-load'

export interface ReconcileOptions {
  /** Cleanup scope: plugins-only or plugins-and-channels. */
  scope: 'plugins-only' | 'plugins-and-channels'
  /** Whether to check disk state for orphan detection. */
  checkDisk: boolean
  /** Whether to detect orphaned plugin config entries. */
  detectOrphans: boolean
  /** Whether to write reconciled config to disk (false = dry-run). */
  apply: boolean
  /** Caller identity for logging and auditing. */
  caller: ReconcileCaller
}

export interface ReconcileResult {
  changed: boolean
  removedFrom: {
    allow: string[]
    entries: string[]
    installs: string[]
    channels: string[]
  }
  orphanedPluginIds: string[]
  appliedAt?: number
}

/**
 * Unified config reconciliation entry point for a single managed channel.
 *
 * Wrapper-mode implementation: delegates to the channel's reconcileConfig hook
 * and optionally detects orphaned plugin config entries.
 *
 * Replaces scattered calls to:
 * - pruneStalePluginConfigEntries (openclaw-config-warnings.ts)
 * - findOrphanedManagedPluginConfigIds (plugin-install-safety.ts)
 * - normalizeGenericManagedPluginConfig (managed-channel-plugin-lifecycle.ts)
 * - buildNormalizedConfig (feishu-official-plugin-state.ts)
 */
export async function reconcileManagedPluginConfig(
  channelId: ManagedChannelLifecycleId,
  homeDir: string,
  options: ReconcileOptions
): Promise<ReconcileResult> {
  const spec = getManagedChannelLifecycleSpec(channelId)
  if (!spec) {
    return { changed: false, removedFrom: { allow: [], entries: [], installs: [], channels: [] }, orphanedPluginIds: [] }
  }

  const beforeConfig = (await readConfig().catch(() => null)) || {}

  const installPath = path.join(homeDir, 'extensions', spec.canonicalPluginId)
  const installedOnDisk = options.checkDisk
    ? await fsp.access(installPath).then(() => true, () => false)
    : false

  // Feishu has channel-specific reconciliation logic in electron/main
  // that can't be in the shared spec. Use the dedicated function instead.
  const reconciled = channelId === 'feishu'
    ? reconcileFeishuPluginConfig(beforeConfig, { installedOnDisk, installPath })
    : spec.reconcileConfig(beforeConfig, { installedOnDisk, installPath, homeDir })

  const orphanedPluginIds: string[] = []
  if (options.detectOrphans && options.checkDisk) {
    const isOrphaned = await detectOrphanedPluginConfig(
      homeDir,
      reconciled.config,
      spec.canonicalPluginId
    )
    if (isOrphaned) {
      orphanedPluginIds.push(spec.canonicalPluginId)
    }
  }

  const removedFrom = diffRemovedEntries(beforeConfig, reconciled.config, spec)

  if (!reconciled.changed && orphanedPluginIds.length === 0) {
    return {
      changed: false,
      removedFrom,
      orphanedPluginIds,
    }
  }

  if (options.apply && reconciled.changed) {
    const result = await applyConfigPatchGuarded({
      beforeConfig,
      afterConfig: reconciled.config,
      reason: 'managed-plugin-config-reconcile',
    })
    return {
      changed: result.wrote === true,
      removedFrom,
      orphanedPluginIds,
      appliedAt: Date.now(),
    }
  }

  return {
    changed: reconciled.changed,
    removedFrom,
    orphanedPluginIds,
  }
}

/**
 * Batch reconciliation: run reconcile for all managed channels.
 * Used for startup repair and global cleanup scenarios.
 */
export async function reconcileAllManagedPluginConfigs(
  homeDir: string,
  options: Omit<ReconcileOptions, 'caller'> & { caller: 'startup-repair' }
): Promise<Map<ManagedChannelLifecycleId, ReconcileResult>> {
  const results = new Map<ManagedChannelLifecycleId, ReconcileResult>()
  const records = listManagedChannelPluginRecords()

  for (const record of records) {
    const channelId = record.channelId as ManagedChannelLifecycleId
    try {
      const result = await reconcileManagedPluginConfig(channelId, homeDir, options)
      results.set(channelId, result)
    } catch {
      results.set(channelId, {
        changed: false,
        removedFrom: { allow: [], entries: [], installs: [], channels: [] },
        orphanedPluginIds: [],
      })
    }
  }

  return results
}

/**
 * Check if a specific plugin's config references a path that doesn't exist on disk.
 */
async function detectOrphanedPluginConfig(
  homeDir: string,
  config: Record<string, any>,
  pluginId: string
): Promise<boolean> {
  const installs = config?.plugins?.installs
  if (!installs || typeof installs !== 'object') return false

  const installRecord = installs[pluginId]
  if (!installRecord) return false

  const expectedPath = path.join(homeDir, 'extensions', pluginId)
  const exists = await fsp.access(expectedPath).then(() => true, () => false)
  return !exists
}

/**
 * Compute what entries were removed between before and after configs.
 */
function diffRemovedEntries(
  before: Record<string, any>,
  after: Record<string, any>,
  spec: { cleanupPluginIds: string[]; cleanupChannelIds: string[] }
): ReconcileResult['removedFrom'] {
  const result: ReconcileResult['removedFrom'] = {
    allow: [],
    entries: [],
    installs: [],
    channels: [],
  }

  const beforeAllow: string[] = Array.isArray(before?.plugins?.allow) ? before.plugins.allow : []
  const afterAllow: string[] = Array.isArray(after?.plugins?.allow) ? after.plugins.allow : []
  const afterAllowSet = new Set(afterAllow)
  for (const id of beforeAllow) {
    if (!afterAllowSet.has(id) && spec.cleanupPluginIds.includes(id)) {
      result.allow.push(id)
    }
  }

  for (const key of ['entries', 'installs'] as const) {
    const beforeMap = before?.plugins?.[key]
    const afterMap = after?.plugins?.[key]
    if (beforeMap && typeof beforeMap === 'object') {
      for (const id of spec.cleanupPluginIds) {
        if (id in beforeMap && (!afterMap || !(id in afterMap))) {
          result[key].push(id)
        }
      }
    }
  }

  if (before?.channels && typeof before.channels === 'object') {
    for (const id of spec.cleanupChannelIds) {
      if (id in before.channels && (!after?.channels || !(id in after.channels))) {
        result.channels.push(id)
      }
    }
  }

  return result
}
