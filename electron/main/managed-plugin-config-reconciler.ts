import {
  createManagedChannelRuntimeSnapshot,
  getManagedChannelLifecycleSpec,
  reconcileManagedChannelPluginConfig,
  type ManagedChannelConfigReconcileResult,
  type ManagedChannelConfigReconcileScope,
  type ManagedChannelPluginLifecycleSpec,
} from '../../src/shared/managed-channel-plugin-lifecycle'
import type { OpenClawGuardedWriteResult } from '../../src/shared/openclaw-phase2'
import type { applyConfigPatchGuarded as ApplyConfigPatchGuarded } from './openclaw-config-coordinator'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { stat } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

export type ManagedPluginConfigReconcileFailureReason =
  | 'unsupported-channel'
  | 'config-read-failed'
  | 'guarded-write-failed'

export interface ManagedPluginConfigRuntimeContext {
  configPath?: string | null
  homeDir?: string | null
  openclawVersion?: string | null
}

export interface ManagedPluginConfigReconcilerManifest {
  channelId: string
  scope: ManagedChannelConfigReconcileScope
  apply: boolean
  changed: boolean
  written: boolean
  retryable: boolean
  removedFrom: ManagedChannelConfigReconcileResult['removedFrom']
  orphanedPluginIds: string[]
  prunedPluginIds: string[]
  runtime: {
    configPath: string | null
    homeDir: string | null
    openclawVersion: string | null
  }
  write?: {
    ok: boolean
    blocked: boolean
    wrote: boolean
    errorCode?: OpenClawGuardedWriteResult['errorCode']
  }
}

export interface ManagedPluginConfigReconcileResult {
  ok: boolean
  channelId: string
  scope: ManagedChannelConfigReconcileScope
  apply: boolean
  changed: boolean
  written: boolean
  configReadFailed: boolean
  retryable: boolean
  failureReason?: ManagedPluginConfigReconcileFailureReason
  message: string
  beforeConfig: Record<string, any> | null
  afterConfig: Record<string, any> | null
  removedFrom: ManagedChannelConfigReconcileResult['removedFrom']
  orphanedPluginIds: string[]
  prunedPluginIds: string[]
  manifest: ManagedPluginConfigReconcilerManifest
  writeResult?: OpenClawGuardedWriteResult
}

export interface ManagedPluginConfigReconcileOptions {
  channelId: string
  runtimeContext?: ManagedPluginConfigRuntimeContext | null
  scope?: ManagedChannelConfigReconcileScope
  apply?: boolean
  applyGatewayPolicy?: boolean
  detectOrphans?: boolean
  desiredConfig?: Record<string, any> | null
  installedOnDisk?: boolean
  currentConfig?: Record<string, any> | null
}

export interface ManagedPluginConfigReconcilerDependencies {
  readConfig?: (options?: { configPath?: string | null }) => Promise<Record<string, any> | null>
  applyConfigPatchGuarded?: typeof ApplyConfigPatchGuarded
  pathExists?: (targetPath: string) => Promise<boolean>
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!hasOwnRecord(config)) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => isDeepEqual(item, right[index]))
  }
  if (hasOwnRecord(left) && hasOwnRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key)
      && isDeepEqual(left[key], right[key])
    )
  }
  return false
}

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

function normalizePluginIds(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => normalizeText(item)).filter(Boolean)))
}

function createEmptyRemovedFrom(): ManagedChannelConfigReconcileResult['removedFrom'] {
  return {
    allow: [],
    entries: [],
    installs: [],
    channels: [],
  }
}

function mergeRemovedFrom(
  left: ManagedChannelConfigReconcileResult['removedFrom'],
  right: ManagedChannelConfigReconcileResult['removedFrom']
): ManagedChannelConfigReconcileResult['removedFrom'] {
  return {
    allow: normalizePluginIds([...left.allow, ...right.allow]),
    entries: normalizePluginIds([...left.entries, ...right.entries]),
    installs: normalizePluginIds([...left.installs, ...right.installs]),
    channels: normalizePluginIds([...left.channels, ...right.channels]),
  }
}

function hasPluginResidue(
  config: Record<string, any>,
  spec: ManagedChannelPluginLifecycleSpec,
  scope: ManagedChannelConfigReconcileScope
): boolean {
  const plugins = hasOwnRecord(config.plugins) ? config.plugins : {}
  const allow = Array.isArray(plugins.allow)
    ? plugins.allow.map((item: unknown) => normalizeText(item)).filter(Boolean)
    : []
  const entries = hasOwnRecord(plugins.entries) ? plugins.entries : {}
  const installs = hasOwnRecord(plugins.installs) ? plugins.installs : {}
  const pluginIds = normalizePluginIds(spec.cleanupPluginIds)
  const channels = hasOwnRecord(config.channels) ? config.channels : {}

  if (pluginIds.some((pluginId) => allow.includes(pluginId))) return true
  if (pluginIds.some((pluginId) => Object.prototype.hasOwnProperty.call(entries, pluginId))) return true
  if (pluginIds.some((pluginId) => Object.prototype.hasOwnProperty.call(installs, pluginId))) return true
  return scope === 'plugins-and-channels'
    && spec.cleanupChannelIds.some((channelId) => Object.prototype.hasOwnProperty.call(channels, channelId))
}

function collectConfiguredInstallPaths(config: Record<string, any>, pluginId: string): string[] {
  const plugins = hasOwnRecord(config.plugins) ? config.plugins : {}
  const paths = [
    hasOwnRecord(plugins.installs?.[pluginId]) ? plugins.installs[pluginId].installPath : '',
    hasOwnRecord(plugins.entries?.[pluginId]) ? plugins.entries[pluginId].installPath : '',
  ]
  return normalizePluginIds(paths)
}

function removeValue(values: string[], value: string): string[] {
  return values.filter((item) => item !== value)
}

function restoreCanonicalConfiguredInstallRecords(params: {
  beforeConfig: Record<string, any>
  afterConfig: Record<string, any>
  pluginId: string
  removedFrom: ManagedChannelConfigReconcileResult['removedFrom']
}): {
  config: Record<string, any>
  removedFrom: ManagedChannelConfigReconcileResult['removedFrom']
} {
  const next = cloneConfig(params.afterConfig)
  const beforePlugins = hasOwnRecord(params.beforeConfig.plugins) ? params.beforeConfig.plugins : {}
  const beforeEntries = hasOwnRecord(beforePlugins.entries) ? beforePlugins.entries : {}
  const beforeInstalls = hasOwnRecord(beforePlugins.installs) ? beforePlugins.installs : {}

  if (hasOwnRecord(beforeEntries[params.pluginId])) {
    next.plugins = hasOwnRecord(next.plugins) ? next.plugins : {}
    next.plugins.entries = hasOwnRecord(next.plugins.entries) ? next.plugins.entries : {}
    next.plugins.entries[params.pluginId] = cloneConfig(beforeEntries[params.pluginId])
  }

  if (hasOwnRecord(beforeInstalls[params.pluginId])) {
    next.plugins = hasOwnRecord(next.plugins) ? next.plugins : {}
    next.plugins.installs = hasOwnRecord(next.plugins.installs) ? next.plugins.installs : {}
    next.plugins.installs[params.pluginId] = cloneConfig(beforeInstalls[params.pluginId])
  }

  return {
    config: next,
    removedFrom: {
      ...params.removedFrom,
      entries: removeValue(params.removedFrom.entries, params.pluginId),
      installs: removeValue(params.removedFrom.installs, params.pluginId),
    },
  }
}

function normalizeComparablePath(value: string): string {
  return value ? path.resolve(value) : ''
}

function isHiddenInstallStagePath(homeDir: string, candidatePath: string): boolean {
  const normalizedCandidatePath = normalizeComparablePath(candidatePath)
  if (!normalizedCandidatePath) return false

  const extensionsRoot = normalizeComparablePath(path.join(homeDir, 'extensions'))
  if (!extensionsRoot) return false

  const relativePath = path.relative(extensionsRoot, normalizedCandidatePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false
  }

  const firstSegment = relativePath.split(path.sep)[0] || ''
  return firstSegment.startsWith('.openclaw-install-stage-')
}

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function defaultReadConfig(options?: { configPath?: string | null }): Promise<Record<string, any> | null> {
  const cli = await import('./cli')
  return cli.readConfig(options)
}

async function defaultApplyConfigPatchGuarded(
  ...args: Parameters<typeof ApplyConfigPatchGuarded>
): ReturnType<typeof ApplyConfigPatchGuarded> {
  const coordinator = await import('./openclaw-config-coordinator')
  return coordinator.applyConfigPatchGuarded(...args)
}

async function hasExistingConfiguredInstallPath(
  homeDir: string,
  configuredInstallPaths: string[],
  pathExists: (targetPath: string) => Promise<boolean>
): Promise<boolean> {
  for (const configuredInstallPath of configuredInstallPaths) {
    if (isHiddenInstallStagePath(homeDir, configuredInstallPath)) continue
    if (await pathExists(configuredInstallPath)) return true
  }
  return false
}

function removePluginConfigIds(
  config: Record<string, any>,
  pluginIds: string[],
  channelIds: string[],
  scope: ManagedChannelConfigReconcileScope
): {
  config: Record<string, any>
  removedFrom: ManagedChannelConfigReconcileResult['removedFrom']
} {
  const next = cloneConfig(config)
  const removedFrom = createEmptyRemovedFrom()
  const targetPluginIds = normalizePluginIds(pluginIds)
  const targetChannelIds = normalizePluginIds(channelIds)

  if (!hasOwnRecord(next.plugins)) {
    return { config: next, removedFrom }
  }

  if (Array.isArray(next.plugins.allow)) {
    const beforeAllow = next.plugins.allow.map((item: unknown) => normalizeText(item)).filter(Boolean)
    const afterAllow = beforeAllow.filter((pluginId: string) => !targetPluginIds.includes(pluginId))
    removedFrom.allow.push(...beforeAllow.filter((pluginId: string) => targetPluginIds.includes(pluginId)))
    next.plugins.allow = afterAllow
  }

  for (const key of ['entries', 'installs'] as const) {
    if (!hasOwnRecord(next.plugins[key])) continue
    for (const pluginId of targetPluginIds) {
      if (!Object.prototype.hasOwnProperty.call(next.plugins[key], pluginId)) continue
      delete next.plugins[key][pluginId]
      removedFrom[key].push(pluginId)
    }
  }

  if (scope === 'plugins-and-channels' && hasOwnRecord(next.channels)) {
    for (const channelId of targetChannelIds) {
      if (!Object.prototype.hasOwnProperty.call(next.channels, channelId)) continue
      delete next.channels[channelId]
      removedFrom.channels.push(channelId)
    }
  }

  return {
    config: next,
    removedFrom,
  }
}

async function collectOrphanedManagedPluginIds(params: {
  config: Record<string, any>
  homeDir: string
  installedOnDisk: boolean
  pathExists: (targetPath: string) => Promise<boolean>
  spec: ManagedChannelPluginLifecycleSpec
}): Promise<string[]> {
  const plugins = hasOwnRecord(params.config.plugins) ? params.config.plugins : {}
  const allow = Array.isArray(plugins.allow)
    ? plugins.allow.map((item: unknown) => normalizeText(item)).filter(Boolean)
    : []
  const entries = hasOwnRecord(plugins.entries) ? plugins.entries : {}
  const installs = hasOwnRecord(plugins.installs) ? plugins.installs : {}
  const orphanedPluginIds: string[] = []

  for (const pluginId of params.spec.orphanPruneCandidateIds) {
    const hasResidue =
      allow.includes(pluginId)
      || Object.prototype.hasOwnProperty.call(entries, pluginId)
      || Object.prototype.hasOwnProperty.call(installs, pluginId)
    if (!hasResidue) continue

    const canonicalInstallPath = path.join(params.homeDir, 'extensions', pluginId)
    const canonicalExists = pluginId === params.spec.canonicalPluginId
      ? params.installedOnDisk || await params.pathExists(canonicalInstallPath)
      : await params.pathExists(canonicalInstallPath)
    if (canonicalExists) continue

    const configuredInstallPaths = collectConfiguredInstallPaths(params.config, pluginId)
    if (await hasExistingConfiguredInstallPath(params.homeDir, configuredInstallPaths, params.pathExists)) {
      continue
    }

    orphanedPluginIds.push(pluginId)
  }

  return normalizePluginIds(orphanedPluginIds)
}

function buildManifest(params: {
  apply: boolean
  changed: boolean
  channelId: string
  manifestRuntime: ManagedPluginConfigReconcilerManifest['runtime']
  orphanedPluginIds: string[]
  prunedPluginIds: string[]
  removedFrom: ManagedChannelConfigReconcileResult['removedFrom']
  retryable: boolean
  scope: ManagedChannelConfigReconcileScope
  writeResult?: OpenClawGuardedWriteResult
}): ManagedPluginConfigReconcilerManifest {
  return {
    channelId: params.channelId,
    scope: params.scope,
    apply: params.apply,
    changed: params.changed,
    written: params.writeResult?.wrote === true,
    retryable: params.retryable,
    removedFrom: params.removedFrom,
    orphanedPluginIds: params.orphanedPluginIds,
    prunedPluginIds: params.prunedPluginIds,
    runtime: params.manifestRuntime,
    ...(params.writeResult
      ? {
          write: {
            ok: params.writeResult.ok,
            blocked: params.writeResult.blocked,
            wrote: params.writeResult.wrote,
            ...(params.writeResult.errorCode ? { errorCode: params.writeResult.errorCode } : {}),
          },
        }
      : {}),
  }
}

function buildResult(params: Omit<ManagedPluginConfigReconcileResult, 'manifest'> & {
  manifestRuntime: ManagedPluginConfigReconcilerManifest['runtime']
}): ManagedPluginConfigReconcileResult {
  return {
    ...params,
    manifest: buildManifest({
      apply: params.apply,
      changed: params.changed,
      channelId: params.channelId,
      manifestRuntime: params.manifestRuntime,
      orphanedPluginIds: params.orphanedPluginIds,
      prunedPluginIds: params.prunedPluginIds,
      removedFrom: params.removedFrom,
      retryable: params.retryable,
      scope: params.scope,
      writeResult: params.writeResult,
    }),
  }
}

export async function reconcileManagedPluginConfig(
  options: ManagedPluginConfigReconcileOptions,
  dependencies: ManagedPluginConfigReconcilerDependencies = {}
): Promise<ManagedPluginConfigReconcileResult> {
  const spec = getManagedChannelLifecycleSpec(options.channelId)
  const scope = options.scope || spec?.defaultReconcileScope || 'plugins-only'
  const apply = options.apply === true
  const runtimeContext = options.runtimeContext || {}
  const configPath = normalizeText(runtimeContext.configPath)
  const homeDir = normalizeText(runtimeContext.homeDir)
  const manifestRuntime = {
    configPath: configPath || null,
    homeDir: homeDir || null,
    openclawVersion: normalizeText(runtimeContext.openclawVersion) || null,
  }

  if (!spec) {
    return buildResult({
      ok: false,
      channelId: options.channelId,
      scope,
      apply,
      changed: false,
      written: false,
      configReadFailed: false,
      retryable: false,
      failureReason: 'unsupported-channel',
      message: `Unsupported managed channel: ${options.channelId}`,
      beforeConfig: null,
      afterConfig: null,
      removedFrom: createEmptyRemovedFrom(),
      orphanedPluginIds: [],
      prunedPluginIds: [],
      manifestRuntime,
    })
  }

  const readConfigImpl = dependencies.readConfig || defaultReadConfig
  const rawConfig = options.currentConfig !== undefined
    ? options.currentConfig
    : await readConfigImpl(configPath ? { configPath } : undefined).catch(() => null)

  if (!hasOwnRecord(rawConfig)) {
    return buildResult({
      ok: false,
      channelId: spec.channelId,
      scope,
      apply,
      changed: false,
      written: false,
      configReadFailed: true,
      retryable: true,
      failureReason: 'config-read-failed',
      message: 'OpenClaw 配置读取失败，已停止 managed channel 配置修复以避免覆盖现有配置。',
      beforeConfig: null,
      afterConfig: null,
      removedFrom: createEmptyRemovedFrom(),
      orphanedPluginIds: [],
      prunedPluginIds: [],
      manifestRuntime,
    })
  }

  const beforeConfig = cloneConfig(rawConfig)
  const pathExists = dependencies.pathExists || defaultPathExists
  const canonicalInstallPath = homeDir ? path.join(homeDir, 'extensions', spec.canonicalPluginId) : ''
  const installedOnDisk = options.installedOnDisk === true
    || Boolean(canonicalInstallPath && await pathExists(canonicalInstallPath))
  let afterConfig = options.desiredConfig && hasOwnRecord(options.desiredConfig)
    ? cloneConfig(options.desiredConfig)
    : cloneConfig(beforeConfig)
  let removedFrom = createEmptyRemovedFrom()
  let orphanedPluginIds: string[] = []

  if (!options.desiredConfig) {
    const shouldRunSharedReconcile = installedOnDisk || hasPluginResidue(beforeConfig, spec, scope)
    const sharedReconcile = shouldRunSharedReconcile
      ? reconcileManagedChannelPluginConfig(
          spec.channelId,
          beforeConfig,
          createManagedChannelRuntimeSnapshot({
            installedOnDisk,
            homeDir: homeDir || undefined,
            installPath: installedOnDisk ? canonicalInstallPath || undefined : undefined,
          }),
          { scope }
        )
      : null
    afterConfig = cloneConfig(sharedReconcile?.config || beforeConfig)
    removedFrom = sharedReconcile?.removedFrom || createEmptyRemovedFrom()
    const preserveCanonicalConfiguredPath = homeDir
      ? await hasExistingConfiguredInstallPath(
        homeDir,
        collectConfiguredInstallPaths(beforeConfig, spec.canonicalPluginId),
        pathExists
      )
      : false
    if (preserveCanonicalConfiguredPath) {
      const restored = restoreCanonicalConfiguredInstallRecords({
        beforeConfig,
        afterConfig,
        pluginId: spec.canonicalPluginId,
        removedFrom,
      })
      afterConfig = restored.config
      removedFrom = restored.removedFrom
    }

    orphanedPluginIds = options.detectOrphans === false || !homeDir
      ? []
      : await collectOrphanedManagedPluginIds({
          config: afterConfig,
          homeDir,
          installedOnDisk,
          pathExists,
          spec,
        })

    if (orphanedPluginIds.length > 0) {
      const pruneResult = removePluginConfigIds(
        afterConfig,
        orphanedPluginIds,
        spec.cleanupChannelIds,
        scope
      )
      afterConfig = pruneResult.config
      removedFrom = mergeRemovedFrom(removedFrom, pruneResult.removedFrom)
    }
  }

  const changed = !isDeepEqual(beforeConfig, afterConfig)
  const prunedPluginIds = normalizePluginIds([
    ...removedFrom.allow,
    ...removedFrom.entries,
    ...removedFrom.installs,
  ])

  if (!changed) {
    return buildResult({
      ok: true,
      channelId: spec.channelId,
      scope,
      apply,
      changed: false,
      written: false,
      configReadFailed: false,
      retryable: false,
      message: 'managed channel 配置无需修复。',
      beforeConfig,
      afterConfig,
      removedFrom,
      orphanedPluginIds,
      prunedPluginIds,
      manifestRuntime,
    })
  }

  if (!apply) {
    return buildResult({
      ok: true,
      channelId: spec.channelId,
      scope,
      apply,
      changed: true,
      written: false,
      configReadFailed: false,
      retryable: true,
      message: 'managed channel 配置存在可修复差异；dry-run 未写入。',
      beforeConfig,
      afterConfig,
      removedFrom,
      orphanedPluginIds,
      prunedPluginIds,
      manifestRuntime,
    })
  }

  const writeResult = await (dependencies.applyConfigPatchGuarded || defaultApplyConfigPatchGuarded)(
    {
      beforeConfig,
      afterConfig,
      reason: 'managed-channel-plugin-repair',
    },
    undefined,
    {
      strictRead: true,
      applyGatewayPolicy: options.applyGatewayPolicy === true,
      runtimeContext: configPath ? { configPath } : undefined,
    }
  )

  return buildResult({
    ok: writeResult.ok,
    channelId: spec.channelId,
    scope,
    apply,
    changed: true,
    written: writeResult.wrote === true,
    configReadFailed: writeResult.errorCode === 'config_read_failed',
    retryable: !writeResult.ok,
    ...(writeResult.ok ? {} : { failureReason: 'guarded-write-failed' as const }),
    message: writeResult.ok
      ? 'managed channel 配置修复已写入。'
      : writeResult.message || 'managed channel 配置修复写入失败。',
    beforeConfig,
    afterConfig,
    removedFrom,
    orphanedPluginIds,
    prunedPluginIds,
    manifestRuntime,
    writeResult,
  })
}
