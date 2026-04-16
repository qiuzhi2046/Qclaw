import type { OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type {
  OpenClawConfigPatchWriteRequest,
  OpenClawGuardedWriteResult,
} from '../../src/shared/openclaw-phase2'
import { listManagedChannelLifecycleSpecs } from '../../src/shared/managed-channel-plugin-lifecycle'
import { collectChangedJsonPaths } from './openclaw-config-diff'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import {
  tryAcquireManagedOperationLeases,
  type ManagedOperationLease,
} from './managed-operation-lock'

interface ManagedChannelPatchTarget {
  channelId: string
  lockKey: string
}

export interface ManagedChannelConfigPatchClassification {
  changedJsonPaths: string[]
  targets: ManagedChannelPatchTarget[]
}

export interface ChannelAwareConfigPatchDependencies {
  applyConfigPatchGuardedImpl?: typeof applyConfigPatchGuarded
  tryAcquireManagedOperationLeasesImpl?: typeof tryAcquireManagedOperationLeases
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeId(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function normalizeConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  return hasOwnRecord(config) ? config : {}
}

function normalizePluginIds(values: unknown[]): string[] {
  return Array.from(new Set(values.map((item) => normalizeId(item)).filter(Boolean)))
}

function normalizeJsonPathSegment(value: string): string {
  return String(value || '').trim().toLowerCase()
}

function isFeishuManagedAgentId(value: unknown): boolean {
  const normalized = normalizeId(value)
  return normalized === 'feishu-bot' || normalized === 'feishu-default' || normalized.startsWith('feishu-')
}

function getPluginAllowList(config: Record<string, any>): string[] {
  const plugins = hasOwnRecord(config.plugins) ? config.plugins : {}
  return Array.isArray(plugins.allow) ? normalizePluginIds(plugins.allow) : []
}

function getPluginRecordIds(config: Record<string, any>, key: 'entries' | 'installs'): string[] {
  const plugins = hasOwnRecord(config.plugins) ? config.plugins : {}
  const records = hasOwnRecord(plugins[key]) ? plugins[key] : {}
  return normalizePluginIds(Object.keys(records))
}

function hasPluginIdInChangedConfig(
  beforeConfig: Record<string, any>,
  afterConfig: Record<string, any>,
  pluginIds: string[]
): boolean {
  const targetIds = normalizePluginIds(pluginIds)
  if (targetIds.length === 0) return false

  const beforeIds = new Set([
    ...getPluginAllowList(beforeConfig),
    ...getPluginRecordIds(beforeConfig, 'entries'),
    ...getPluginRecordIds(beforeConfig, 'installs'),
  ])
  const afterIds = new Set([
    ...getPluginAllowList(afterConfig),
    ...getPluginRecordIds(afterConfig, 'entries'),
    ...getPluginRecordIds(afterConfig, 'installs'),
  ])

  return targetIds.some((pluginId) => beforeIds.has(pluginId) || afterIds.has(pluginId))
}

function pathTouchesChannel(path: string, channelIds: string[]): boolean {
  const normalizedPath = normalizeJsonPathSegment(path)
  return channelIds.some((channelId) => {
    const normalizedChannelId = normalizeId(channelId)
    return normalizedPath === `$.channels.${normalizedChannelId}`
      || normalizedPath.startsWith(`$.channels.${normalizedChannelId}.`)
  })
}

function pathTouchesPlugin(path: string, pluginIds: string[]): boolean {
  const normalizedPath = normalizeJsonPathSegment(path)
  if (!normalizedPath.startsWith('$.plugins')) return false

  return pluginIds.some((pluginId) => {
    const normalizedPluginId = normalizeId(pluginId)
    return normalizedPath === `$.plugins.entries.${normalizedPluginId}`
      || normalizedPath.startsWith(`$.plugins.entries.${normalizedPluginId}.`)
      || normalizedPath === `$.plugins.installs.${normalizedPluginId}`
      || normalizedPath.startsWith(`$.plugins.installs.${normalizedPluginId}.`)
  })
}

function pathTouchesPluginAllowList(path: string): boolean {
  const normalizedPath = normalizeJsonPathSegment(path)
  return normalizedPath === '$.plugins.allow' || normalizedPath.startsWith('$.plugins.allow[')
}

function hasFeishuChannelConfig(config: Record<string, any>): boolean {
  const channels = hasOwnRecord(config.channels) ? config.channels : {}
  return Object.prototype.hasOwnProperty.call(channels, 'feishu')
}

function hasFeishuManagedAgentConfig(config: Record<string, any>): boolean {
  const agents = hasOwnRecord(config.agents) ? config.agents : {}
  const agentList = Array.isArray(agents.list) ? agents.list : []
  return agentList.some((agent) => hasOwnRecord(agent) && isFeishuManagedAgentId(agent.id))
}

function hasFeishuBindingConfig(config: Record<string, any>): boolean {
  const bindings = Array.isArray(config.bindings) ? config.bindings : []
  return bindings.some((binding) =>
    hasOwnRecord(binding)
    && (
      normalizeId(binding.match?.channel) === 'feishu'
      || isFeishuManagedAgentId(binding.agentId)
    )
  )
}

function hasFeishuRoutingConfig(
  beforeConfig: Record<string, any>,
  afterConfig: Record<string, any>
): boolean {
  return (
    hasFeishuChannelConfig(beforeConfig)
    || hasFeishuChannelConfig(afterConfig)
    || hasFeishuManagedAgentConfig(beforeConfig)
    || hasFeishuManagedAgentConfig(afterConfig)
    || hasFeishuBindingConfig(beforeConfig)
    || hasFeishuBindingConfig(afterConfig)
  )
}

function pathTouchesFeishuRouting(path: string): boolean {
  const normalizedPath = normalizeJsonPathSegment(path)
  const touchesRoot = (root: string) =>
    normalizedPath === root
    || normalizedPath.startsWith(`${root}.`)
    || normalizedPath.startsWith(`${root}[`)
  return normalizedPath === '$.session.dmscope'
    || touchesRoot('$.agents')
    || touchesRoot('$.bindings')
}

export function classifyManagedChannelConfigPatch(
  request: OpenClawConfigPatchWriteRequest
): ManagedChannelConfigPatchClassification {
  const beforeConfig = normalizeConfig(request.beforeConfig)
  const afterConfig = normalizeConfig(request.afterConfig)
  const changedJsonPaths = collectChangedJsonPaths(beforeConfig, afterConfig)
  const targets: ManagedChannelPatchTarget[] = []

  for (const spec of listManagedChannelLifecycleSpecs()) {
    const channelIds = normalizePluginIds([spec.channelId, ...spec.cleanupChannelIds])
    const pluginIds = normalizePluginIds([spec.canonicalPluginId, ...spec.cleanupPluginIds])
    const touchesChannel = changedJsonPaths.some((path) => pathTouchesChannel(path, channelIds))
    const touchesPluginRecords = changedJsonPaths.some((path) => pathTouchesPlugin(path, pluginIds))
    const touchesPluginAllow = changedJsonPaths.some(pathTouchesPluginAllowList)
      && hasPluginIdInChangedConfig(beforeConfig, afterConfig, pluginIds)
    const touchesFeishuRouting = spec.channelId === 'feishu'
      && changedJsonPaths.some(pathTouchesFeishuRouting)
      && hasFeishuRoutingConfig(beforeConfig, afterConfig)

    if (touchesChannel || touchesPluginRecords || touchesPluginAllow || touchesFeishuRouting) {
      targets.push({
        channelId: spec.channelId,
        lockKey: `managed-channel-plugin:${spec.channelId}`,
      })
    }
  }

  return {
    changedJsonPaths,
    targets: Array.from(new Map(targets.map((target) => [target.lockKey, target])).values()),
  }
}

function buildManagedChannelBusyResult(
  classification: ManagedChannelConfigPatchClassification
): OpenClawGuardedWriteResult {
  return {
    ok: false,
    blocked: true,
    wrote: false,
    target: 'config',
    snapshotCreated: false,
    snapshot: null,
    changedJsonPaths: classification.changedJsonPaths,
    ownershipSummary: null,
    errorCode: 'managed_channel_busy',
    message: `managed channel 配置正在被修复或安装器占用，请稍后重试。channels=${classification.targets
      .map((target) => target.channelId)
      .join(',')}`,
  }
}

function releaseManagedOperationLeases(leases: ManagedOperationLease[]): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    leases[index].release()
  }
}

export async function applyChannelAwareConfigPatchGuarded(
  request: OpenClawConfigPatchWriteRequest,
  preferredCandidate?: OpenClawInstallCandidate | null,
  dependencies: ChannelAwareConfigPatchDependencies = {}
): Promise<OpenClawGuardedWriteResult> {
  const classification = classifyManagedChannelConfigPatch(request)
  const applyImpl = dependencies.applyConfigPatchGuardedImpl || applyConfigPatchGuarded
  if (classification.targets.length === 0) {
    return applyImpl(request, preferredCandidate)
  }

  const lockKeys = classification.targets.map((target) => target.lockKey).sort()
  const leases = (dependencies.tryAcquireManagedOperationLeasesImpl || tryAcquireManagedOperationLeases)(lockKeys)
  if (!leases) {
    return buildManagedChannelBusyResult(classification)
  }

  try {
    return await applyImpl(request, preferredCandidate)
  } finally {
    releaseManagedOperationLeases(leases)
  }
}
