import {
  createManagedChannelCapabilitySnapshot,
  createManagedChannelRuntimeSnapshot,
  getManagedChannelLifecycleSpec,
  type ManagedChannelCapabilitySnapshot,
  type ManagedChannelLifecycleId,
  type ManagedChannelPluginInspectResult,
  type ManagedChannelPluginLifecycleSpec,
  type ManagedChannelPluginPrepareResult,
  type ManagedChannelPluginRepairResult,
  type ManagedChannelPluginStatusStage,
  type ManagedChannelPluginStatusStageState,
  type ManagedChannelPluginStatusView,
} from '../../src/shared/managed-channel-plugin-lifecycle'
import type { OfficialChannelActionResult, OfficialChannelAdapterId } from '../../src/shared/official-channel-integration'
import { isPluginAlreadyInstalledError } from '../../src/shared/openclaw-cli-errors'
import type { CliResult, RepairIncompatibleExtensionPluginsOptions } from './cli'
import { withManagedOperationLock, ManagedOperationLockTimeoutError } from './managed-operation-lock'
import type { RepairIncompatibleExtensionsResult } from './plugin-install-safety'
import { reconcileManagedPluginConfig } from './managed-plugin-config-reconciler'
import { dingtalkPreflightHook } from './dingtalk-official-channel'
import { sendRepairProgress, type RepairProgressEvent } from './renderer-notification-bridge'

interface GatewayReloadLikeResult {
  ok: boolean
  running?: boolean
  summary?: string
  stdout?: string
  stderr?: string
  code?: number | null
}

export interface ManagedChannelPluginLifecycleDependencies {
  getOfficialChannelStatus: (channelId: OfficialChannelAdapterId) => Promise<ManagedChannelPluginStatusView>
  repairOfficialChannel: (channelId: OfficialChannelAdapterId) => Promise<OfficialChannelActionResult>
  repairIncompatiblePlugins: (
    options?: RepairIncompatibleExtensionPluginsOptions
  ) => Promise<RepairIncompatibleExtensionsResult>
  installPlugin: (
    name: string,
    expectedPluginIds?: string[],
    options?: {
      registryUrl?: string | null
    }
  ) => Promise<CliResult>
  installPluginNpx: (specifier: string, expectedPluginIds?: string[]) => Promise<CliResult>
  isPluginInstalledOnDisk: (pluginId: string) => Promise<boolean>
  listRegisteredPlugins: () => Promise<string[] | null>
  readConfig: () => Promise<Record<string, any> | null>
  writeConfig: (config: Record<string, any>) => Promise<void>
  reloadGatewayForConfigChange: (
    reason: string,
    options?: { preferEnsureWhenNotRunning?: boolean }
  ) => Promise<GatewayReloadLikeResult>
  now: () => number
}

interface ManagedChannelRepairCooldownState {
  attemptCount: number
  lastFailureKind: string
  cooldownUntil: number
}

const QQBOT_PLUGIN_INSTALL_REGISTRY_URL = 'https://registry.npmmirror.com'

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

function createStatusStage(
  id: ManagedChannelPluginStatusStage['id'],
  state: ManagedChannelPluginStatusStageState,
  source: string,
  message: string
): ManagedChannelPluginStatusStage {
  return {
    id,
    state,
    source,
    message,
  }
}

function createEmptyStatus(spec: ManagedChannelPluginLifecycleSpec, summary: string): ManagedChannelPluginStatusView {
  return {
    channelId: spec.channelId,
    pluginId: spec.canonicalPluginId,
    summary,
    stages: [
      createStatusStage('installed', 'missing', 'status', '当前未确认插件安装'),
      createStatusStage('registered', 'unknown', 'status', '当前未确认插件注册状态'),
      createStatusStage('loaded', 'unknown', 'status', '当前缺少 loaded 证明'),
      createStatusStage('ready', 'unknown', 'status', '当前缺少 ready 证明'),
    ],
    evidence: [],
  }
}

function getInstalledStageState(
  status: ManagedChannelPluginStatusView
): ManagedChannelPluginStatusStageState {
  return status.stages.find((stage) => stage.id === 'installed')?.state || 'unknown'
}

function buildScopedRepairOptions(
  spec: ManagedChannelPluginLifecycleSpec
): RepairIncompatibleExtensionPluginsOptions {
  return {
    scopePluginIds: Array.from(new Set([spec.canonicalPluginId, ...spec.cleanupPluginIds])),
    quarantineOfficialManagedPlugins: true,
  }
}

function toRuntimeSnapshot(status: ManagedChannelPluginStatusView) {
  const stateById = new Map(status.stages.map((stage) => [stage.id, stage.state]))
  return createManagedChannelRuntimeSnapshot({
    installedOnDisk: stateById.get('installed') === 'verified',
    registeredState: stateById.get('registered') === 'verified'
      ? 'ready'
      : stateById.get('registered') === 'missing'
        ? 'missing'
        : 'unknown',
    loadedState: stateById.get('loaded') === 'verified'
      ? 'ready'
      : stateById.get('loaded') === 'missing'
        ? 'missing'
        : 'unknown',
    readyState: stateById.get('ready') === 'verified'
      ? 'ready'
      : stateById.get('ready') === 'missing'
        ? 'missing'
        : 'unknown',
    evidence: status.evidence.map((item) => item.message),
  })
}

function getManagedChannelRepairFailureSummary(
  result: Exclude<
    ManagedChannelPluginRepairResult,
    { kind: 'ok' | 'manual-action-required' | 'capability-blocked' }
  >
): string {
  if (result.kind === 'gateway-reload-failed') return result.reloadReason
  if (result.kind === 'install-failed' || result.kind === 'repair-failed') return result.error
  if (result.kind === 'config-sync-required') return result.reason
  if (result.kind === 'plugin-ready-channel-not-ready') return result.blockingReason
  return result.status.summary || `插件隔离失败：${result.failureKind}`
}

function isSafeAlreadyInstalledManagedPluginInstallFailure(result: CliResult): boolean {
  const detail = String(result.stderr || '')
  return isPluginAlreadyInstalledError(detail)
    && !detail.includes('已自动隔离')
    && !detail.includes('安全修复失败')
}

function buildInspectResult(params: {
  spec: ManagedChannelPluginLifecycleSpec
  status: ManagedChannelPluginStatusView
  capabilities: ManagedChannelCapabilitySnapshot
  configNeedsSync: boolean
}): ManagedChannelPluginInspectResult {
  if (params.capabilities.blockedReasons.length > 0) {
    return {
      kind: 'capability-blocked',
      channelId: params.spec.channelId,
      pluginScope: 'channel',
      entityScope: params.spec.entityScope,
      status: params.status,
      missingCapabilities: params.capabilities.blockedReasons,
    }
  }

  if (params.configNeedsSync) {
    return {
      kind: 'config-sync-required',
      channelId: params.spec.channelId,
      pluginScope: 'channel',
      entityScope: params.spec.entityScope,
      status: params.status,
      reason: '当前插件配置仍待同步',
    }
  }

  const installed = params.status.stages.find((stage) => stage.id === 'installed')?.state
  const registered = params.status.stages.find((stage) => stage.id === 'registered')?.state
  const ready = params.status.stages.find((stage) => stage.id === 'ready')?.state
  if (installed === 'verified' && registered === 'verified' && ready !== 'verified') {
    return {
      kind: 'plugin-ready-channel-not-ready',
      channelId: params.spec.channelId,
      pluginScope: 'channel',
      entityScope: params.spec.entityScope,
      status: params.status,
      blockingReason: '插件安装与注册已确认，但缺少渠道运行状态证明',
    }
  }

  return {
    kind: 'ok',
    channelId: params.spec.channelId,
    pluginScope: 'channel',
    entityScope: params.spec.entityScope,
    status: params.status,
    runtime: toRuntimeSnapshot(params.status),
    capabilities: params.capabilities,
  }
}

function createUnavailableDependencies(): ManagedChannelPluginLifecycleDependencies {
  return {
    getOfficialChannelStatus: async () => {
      throw new Error('getOfficialChannelStatus dependency unavailable')
    },
    repairOfficialChannel: async () => {
      throw new Error('repairOfficialChannel dependency unavailable')
    },
    repairIncompatiblePlugins: async () => {
      throw new Error('repairIncompatiblePlugins dependency unavailable')
    },
    installPlugin: async () => {
      throw new Error('installPlugin dependency unavailable')
    },
    installPluginNpx: async () => {
      throw new Error('installPluginNpx dependency unavailable')
    },
    isPluginInstalledOnDisk: async () => {
      throw new Error('isPluginInstalledOnDisk dependency unavailable')
    },
    listRegisteredPlugins: async () => {
      throw new Error('listRegisteredPlugins dependency unavailable')
    },
    readConfig: async () => {
      throw new Error('readConfig dependency unavailable')
    },
    writeConfig: async () => {
      throw new Error('writeConfig dependency unavailable')
    },
    reloadGatewayForConfigChange: async () => {
      throw new Error('reloadGatewayForConfigChange dependency unavailable')
    },
    now: () => Date.now(),
  }
}

function toOfficialAdapterId(channelId: ManagedChannelLifecycleId): OfficialChannelAdapterId | null {
  if (channelId === 'feishu' || channelId === 'dingtalk') {
    return channelId
  }
  return null
}

async function buildGenericStatus(
  spec: ManagedChannelPluginLifecycleSpec,
  dependencies: ManagedChannelPluginLifecycleDependencies
): Promise<{
  status: ManagedChannelPluginStatusView
  configNeedsSync: boolean
  configAvailable: boolean
  currentConfig: Record<string, any> | null
  normalizedConfig: { config: Record<string, any>; changed: boolean }
}> {
  const [installedOnDisk, registeredPlugins, currentConfig] = await Promise.all([
    dependencies.isPluginInstalledOnDisk(spec.canonicalPluginId),
    dependencies.listRegisteredPlugins(),
    dependencies.readConfig(),
  ])
  const registeredState: ManagedChannelPluginStatusStageState = registeredPlugins == null
    ? 'unknown'
    : registeredPlugins.includes(spec.canonicalPluginId)
      ? 'verified'
      : 'missing'
  const runtime = createManagedChannelRuntimeSnapshot({
    installedOnDisk,
    registeredState: registeredState === 'verified'
      ? 'ready'
      : registeredState === 'missing'
        ? 'missing'
        : 'unknown',
  })
  const normalizedConfig = spec.normalizeConfig(currentConfig, runtime)
  const configAvailable = hasOwnRecord(currentConfig)
  const configNeedsSync = configAvailable && normalizedConfig.changed

  return {
    status: {
      channelId: spec.channelId,
      pluginId: spec.canonicalPluginId,
      summary: !installedOnDisk
        ? `${spec.channelId} 官方插件尚未安装。`
        : configNeedsSync
          ? `${spec.channelId} 官方插件已安装，但配置仍待同步。`
          : registeredState === 'verified'
            ? `${spec.channelId} 官方插件已安装并已注册；loaded / ready 仍待上游证据。`
            : registeredState === 'missing'
              ? `${spec.channelId} 官方插件已安装，但尚未在上游 plugins list 中确认注册。`
              : `${spec.channelId} 官方插件已安装；registered / loaded / ready 仍待更多上游证据。`,
      stages: [
        createStatusStage(
          'installed',
          installedOnDisk ? 'verified' : 'missing',
          'disk',
          installedOnDisk ? '已确认本机存在插件安装' : '当前未确认到插件安装目录'
        ),
        createStatusStage(
          'registered',
          registeredState,
          'plugins-list',
          registeredState === 'verified'
            ? '已在上游 plugins list 中确认插件已注册'
            : registeredState === 'missing'
              ? '当前未在上游 plugins list 中确认插件已注册'
              : '当前命令行工具未提供可解析的 plugins list'
        ),
        createStatusStage('loaded', 'unknown', 'status', '当前缺少上游 loaded 证明'),
        createStatusStage('ready', 'unknown', 'status', '当前缺少上游 ready 证明'),
      ],
      evidence: [
        {
          source: 'disk',
          channelId: spec.channelId,
          pluginId: spec.canonicalPluginId,
          message: installedOnDisk ? '已确认插件安装目录存在' : '当前未确认到插件安装目录',
        },
        {
          source: 'plugins-list',
          channelId: spec.channelId,
          pluginId: spec.canonicalPluginId,
          message: registeredState === 'verified'
            ? '已在上游 plugins list 中确认插件已注册'
            : registeredState === 'missing'
              ? '当前未在上游 plugins list 中确认插件已注册'
              : '当前命令行工具未提供可解析的 plugins list，registered 暂记为 unknown / 未证实',
        },
        ...(configNeedsSync
          ? [{
              source: 'config' as const,
              channelId: spec.channelId,
              pluginId: spec.canonicalPluginId,
              message: '检测到插件配置仍待同步',
            }]
          : []),
      ],
    },
    configNeedsSync,
    configAvailable,
    currentConfig: configAvailable ? currentConfig : null,
    normalizedConfig,
  }
}

export function createManagedChannelPluginLifecycleService(
  dependencies: Partial<ManagedChannelPluginLifecycleDependencies> = {}
) {
  const resolvedDependencies: ManagedChannelPluginLifecycleDependencies = {
    ...createUnavailableDependencies(),
    ...dependencies,
  }
  const repairCooldowns = new Map<string, ManagedChannelRepairCooldownState>()

  async function resolveHomeDir(): Promise<string | null> {
    try {
      const { getOpenClawPaths } = await import('./cli')
      const paths = await getOpenClawPaths()
      return paths.homeDir || null
    } catch {
      return null
    }
  }

  function resolvePreflightHook(
    channelId: ManagedChannelLifecycleId
  ): ((context: { homeDir: string; config: Record<string, any> }) => Promise<{ ok: boolean; evidence?: string[]; error?: string }>) | null {
    if (channelId === 'dingtalk') return dingtalkPreflightHook
    return null
  }

  function createCapabilities(spec: ManagedChannelPluginLifecycleSpec) {
    return createManagedChannelCapabilitySnapshot({
      supportsBackgroundRestore: spec.supportsBackgroundRestore,
      supportsInteractiveRepair: spec.supportsInteractiveRepairUi,
    })
  }

  function recordFailure(channelId: string, failureKind: string) {
    const previous = repairCooldowns.get(channelId)
    const attemptCount = (previous?.attemptCount || 0) + 1
    repairCooldowns.set(channelId, {
      attemptCount,
      lastFailureKind: failureKind,
      cooldownUntil: resolvedDependencies.now() + Math.min(attemptCount, 3) * 5_000,
    })
  }

  function resetFailure(channelId: string) {
    repairCooldowns.delete(channelId)
  }

  async function repairManagedPluginScope(
    spec: ManagedChannelPluginLifecycleSpec
  ): Promise<RepairIncompatibleExtensionsResult> {
    return resolvedDependencies.repairIncompatiblePlugins(buildScopedRepairOptions(spec))
  }

  function toPrepareResultFromRepairResult(
    result: ManagedChannelPluginRepairResult
  ): ManagedChannelPluginPrepareResult {
    if (result.kind === 'ok') {
      return {
        kind: 'ok',
        channelId: result.channelId,
        pluginScope: 'channel',
        entityScope: result.entityScope,
        action: 'repair-before-setup',
        status: result.status,
      }
    }

    if (result.kind === 'manual-action-required') {
      return {
        kind: 'manual-action-required',
        channelId: result.channelId,
        pluginScope: 'channel',
        entityScope: result.entityScope,
        action: result.action,
        reason: result.reason,
        status: result.status,
      }
    }

    if (result.kind === 'capability-blocked') {
      return {
        kind: 'capability-blocked',
        channelId: result.channelId,
        pluginScope: 'channel',
        entityScope: result.entityScope,
        missingCapabilities: result.missingCapabilities,
        status: result.status,
      }
    }

    return {
      kind: 'prepare-failed',
      channelId: result.channelId,
      pluginScope: 'channel',
      entityScope: result.entityScope,
      error: getManagedChannelRepairFailureSummary(result),
    }
  }

  async function getManagedChannelPluginStatus(channelId: string): Promise<ManagedChannelPluginStatusView> {
    const spec = getManagedChannelLifecycleSpec(channelId)
    if (!spec) {
      throw new Error(`Unsupported managed channel: ${channelId}`)
    }

    const officialAdapterId = toOfficialAdapterId(spec.channelId)
    if (officialAdapterId) {
      return resolvedDependencies.getOfficialChannelStatus(officialAdapterId)
    }

    const { status } = await buildGenericStatus(spec, resolvedDependencies)
    return status
  }

  async function inspectManagedChannelPlugin(channelId: string): Promise<ManagedChannelPluginInspectResult> {
    const spec = getManagedChannelLifecycleSpec(channelId)
    if (!spec) {
      return {
        kind: 'inspection-failed',
        channelId,
        pluginScope: 'channel',
        entityScope: 'channel',
        error: `Unsupported managed channel: ${channelId}`,
      }
    }

    try {
      const officialAdapterId = toOfficialAdapterId(spec.channelId)
      const { status, configNeedsSync } = officialAdapterId
        ? {
            status: await getManagedChannelPluginStatus(spec.channelId),
            configNeedsSync: false,
          }
        : await buildGenericStatus(spec, resolvedDependencies)

      return buildInspectResult({
        spec,
        status,
        capabilities: createCapabilities(spec),
        configNeedsSync,
      })
    } catch (error) {
      return {
        kind: 'inspection-failed',
        channelId: spec.channelId,
        pluginScope: 'channel',
        entityScope: spec.entityScope,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function prepareManagedChannelPluginForSetup(channelId: string): Promise<ManagedChannelPluginPrepareResult> {
    const spec = getManagedChannelLifecycleSpec(channelId)
    if (!spec) {
      return {
        kind: 'prepare-failed',
        channelId,
        pluginScope: 'channel',
        entityScope: 'channel',
        error: `Unsupported managed channel: ${channelId}`,
      }
    }

    // Phase 2: unified config reconciliation via reconciler
    const homeDir = await resolveHomeDir()
    if (homeDir) {
      await reconcileManagedPluginConfig(
        spec.channelId,
        homeDir,
        { scope: 'plugins-only', checkDisk: true, detectOrphans: true, apply: true, caller: 'preflight' }
      ).catch(() => null)
    }

    // Phase 2: channel-specific preflight hook (e.g. dingtalk doctor --fix)
    const preflightHook = resolvePreflightHook(spec.channelId)
    if (preflightHook && homeDir) {
      const currentConfig = await resolvedDependencies.readConfig().catch(() => null)
      const hookResult = await preflightHook({ homeDir, config: currentConfig || {} }).catch(() => ({
        ok: false as const,
        error: 'preflight hook threw an exception',
      }))
      if (!hookResult.ok) {
        return {
          kind: 'prepare-failed',
          channelId: spec.channelId,
          pluginScope: 'channel',
          entityScope: spec.entityScope,
          error: hookResult.error || 'channel-specific preflight check failed',
        }
      }
    }

    if (spec.installStrategy === 'interactive-installer') {
      try {
      return await withManagedOperationLock(`managed-channel-plugin:${spec.channelId}`, async () => {
        const preflightRepair = await repairManagedPluginScope(spec)
        if (!preflightRepair.ok) {
          recordFailure(spec.channelId, preflightRepair.failureKind || 'prepare-repair-failed')
          return {
            kind: 'prepare-failed' as const,
            channelId: spec.channelId,
            pluginScope: 'channel' as const,
            entityScope: spec.entityScope,
            error: preflightRepair.summary || preflightRepair.stderr || '损坏插件环境修复失败',
          }
        }

        resetFailure(spec.channelId)
        const status = await buildGenericStatus(spec, resolvedDependencies)
          .then((result) => result.status)
          .catch(() => createEmptyStatus(spec, '该渠道需要交互式安装器。'))
        return {
          kind: 'manual-action-required' as const,
          channelId: spec.channelId,
          pluginScope: 'channel' as const,
          entityScope: spec.entityScope,
          action: 'launch-interactive-installer' as const,
          reason: '该渠道需要交互式安装器，不能在后台自动安装。',
          status,
        }
      })
      } catch (error) {
        if (error instanceof ManagedOperationLockTimeoutError) {
          return {
            kind: 'prepare-failed' as const,
            channelId: spec.channelId,
            pluginScope: 'channel' as const,
            entityScope: spec.entityScope,
            error: `预检操作等待超时（${Math.round(error.timeoutMs / 1000)}秒），请稍后重试。`,
          }
        }
        throw error
      }
    }

    const inspection = await inspectManagedChannelPlugin(spec.channelId)
    if (inspection.kind === 'config-sync-required') {
      if (getInstalledStageState(inspection.status) === 'verified') {
        return toPrepareResultFromRepairResult(await repairManagedChannelPlugin(spec.channelId))
      }
      return {
        kind: 'ok',
        channelId: spec.channelId,
        pluginScope: 'channel',
        entityScope: spec.entityScope,
        action: 'install-before-setup',
        status: inspection.status,
      }
    }
    if (inspection.kind === 'capability-blocked') {
      return {
        kind: 'capability-blocked',
        channelId: inspection.channelId,
        pluginScope: 'channel',
        entityScope: inspection.entityScope,
        missingCapabilities: inspection.missingCapabilities,
        status: inspection.status,
      }
    }
    if (inspection.kind === 'inspection-failed') {
      return {
        kind: 'prepare-failed',
        channelId: inspection.channelId,
        pluginScope: 'channel',
        entityScope: inspection.entityScope,
        error: inspection.error,
      }
    }

    const installedStage = getInstalledStageState(inspection.status)
    return {
      kind: 'ok',
      channelId: spec.channelId,
      pluginScope: 'channel',
      entityScope: spec.entityScope,
      action: installedStage === 'verified' ? 'reuse-installed' : 'install-before-setup',
      status: inspection.status,
    }
  }

  function emitRepairProgress(channelId: string, phase: string, status: RepairProgressEvent['status'], message: string): void {
    sendRepairProgress({ channelId, phase, status, message, timestamp: Date.now() })
  }

  async function repairViaInteractiveInstaller(
    spec: ManagedChannelPluginLifecycleSpec
  ): Promise<ManagedChannelPluginRepairResult> {
    const preflightRepair = await repairManagedPluginScope(spec)
    if (!preflightRepair.ok) {
      if (preflightRepair.failureKind && preflightRepair.failedPluginIds && preflightRepair.failedPaths) {
        recordFailure(spec.channelId, preflightRepair.failureKind)
        return {
          kind: 'quarantine-failed',
          channelId: spec.channelId,
          pluginScope: 'channel',
          entityScope: spec.entityScope,
          failureKind: preflightRepair.failureKind,
          failedPluginIds: preflightRepair.failedPluginIds,
          failedPaths: preflightRepair.failedPaths,
          status: createEmptyStatus(spec, preflightRepair.summary || '插件隔离失败'),
        }
      }
      recordFailure(spec.channelId, 'repair-failed')
      return {
        kind: 'repair-failed',
        channelId: spec.channelId,
        pluginScope: 'channel',
        entityScope: spec.entityScope,
        status: createEmptyStatus(spec, preflightRepair.summary || '损坏插件环境修复失败'),
        error: preflightRepair.summary || preflightRepair.stderr || '损坏插件环境修复失败',
      }
    }
    resetFailure(spec.channelId)
    return {
      kind: 'manual-action-required',
      channelId: spec.channelId,
      pluginScope: 'channel',
      entityScope: spec.entityScope,
      action: 'launch-interactive-installer',
      reason: '该渠道需要交互式安装器，不能通过后台修复自动完成。',
      status: createEmptyStatus(spec, '该渠道需要交互式安装器。'),
    }
  }

  async function repairViaOfficialAdapter(
    spec: ManagedChannelPluginLifecycleSpec,
    officialAdapterId: OfficialChannelAdapterId
  ): Promise<ManagedChannelPluginRepairResult> {
    const result = await resolvedDependencies.repairOfficialChannel(officialAdapterId)
    if (!result.ok) {
      recordFailure(spec.channelId, 'official-repair-failed')
      return {
        kind: 'repair-failed',
        channelId: spec.channelId,
        pluginScope: 'channel',
        entityScope: spec.entityScope,
        status: createEmptyStatus(spec, result.summary),
        error: result.message || result.summary,
      }
    }
    resetFailure(spec.channelId)
    const status = await resolvedDependencies.getOfficialChannelStatus(officialAdapterId)
    return {
      kind: 'ok',
      channelId: spec.channelId,
      pluginScope: 'channel',
      entityScope: spec.entityScope,
      action: result.installedThisRun ? 'installed' : 'reused-existing',
      status,
    }
  }

  async function repairAndInstallGenericPlugin(
    spec: ManagedChannelPluginLifecycleSpec
  ): Promise<
    | { ok: false; result: ManagedChannelPluginRepairResult }
    | { ok: true; action: 'reused-existing' | 'installed' | 'restored' }
  > {
    const repairResult = await repairManagedPluginScope(spec)
    if (!repairResult.ok) {
      if (repairResult.failureKind && repairResult.failedPluginIds && repairResult.failedPaths) {
        recordFailure(spec.channelId, repairResult.failureKind)
        return { ok: false, result: {
          kind: 'quarantine-failed',
          channelId: spec.channelId,
          pluginScope: 'channel',
          entityScope: spec.entityScope,
          failureKind: repairResult.failureKind,
          failedPluginIds: repairResult.failedPluginIds,
          failedPaths: repairResult.failedPaths,
          status: createEmptyStatus(spec, repairResult.summary || '插件隔离失败'),
        } }
      }
      recordFailure(spec.channelId, 'repair-failed')
      return { ok: false, result: {
        kind: 'repair-failed',
        channelId: spec.channelId,
        pluginScope: 'channel',
        entityScope: spec.entityScope,
        status: createEmptyStatus(spec, repairResult.summary || '损坏插件环境修复失败'),
        error: repairResult.summary || repairResult.stderr || '损坏插件环境修复失败',
      } }
    }

    const installedBefore = await resolvedDependencies.isPluginInstalledOnDisk(spec.canonicalPluginId)
    let action: 'reused-existing' | 'installed' | 'restored' = repairResult.repaired ? 'restored' : 'reused-existing'
    if (!installedBefore) {
      const installResult = spec.installStrategy === 'npx'
        ? await resolvedDependencies.installPluginNpx(spec.npxSpecifier || '', [spec.canonicalPluginId])
        : await resolvedDependencies.installPlugin(
            spec.packageName || '',
            [spec.canonicalPluginId],
            spec.channelId === 'qqbot'
              ? { registryUrl: QQBOT_PLUGIN_INSTALL_REGISTRY_URL }
              : undefined
          )
      if (!installResult.ok) {
        const installedAfterAlreadyExists = isSafeAlreadyInstalledManagedPluginInstallFailure(installResult)
          ? await resolvedDependencies.isPluginInstalledOnDisk(spec.canonicalPluginId)
          : false
        if (!installedAfterAlreadyExists) {
          recordFailure(spec.channelId, 'install-failed')
          return { ok: false, result: {
            kind: 'install-failed',
            channelId: spec.channelId,
            pluginScope: 'channel',
            entityScope: spec.entityScope,
            attemptedInstaller: spec.installStrategy,
            status: createEmptyStatus(spec, installResult.stderr || `${spec.channelId} 插件安装失败`),
            error: installResult.stderr || `${spec.channelId} 插件安装失败`,
          } }
        }
        action = repairResult.repaired ? 'restored' : 'reused-existing'
      } else {
        action = 'installed'
      }
    }
    return { ok: true, action }
  }

  async function reconcileAndWriteConfig(
    spec: ManagedChannelPluginLifecycleSpec
  ): Promise<
    | { ok: false; result: ManagedChannelPluginRepairResult }
    | { ok: true; status: ManagedChannelPluginStatusView }
  > {
    const statusBeforeNormalize = await buildGenericStatus(spec, resolvedDependencies)
    if (statusBeforeNormalize.normalizedConfig.changed && !statusBeforeNormalize.configAvailable) {
      recordFailure(spec.channelId, 'repair-failed')
      return { ok: false, result: {
        kind: 'repair-failed',
        channelId: spec.channelId,
        pluginScope: 'channel',
        entityScope: spec.entityScope,
        status: statusBeforeNormalize.status,
        error: '当前 OpenClaw 配置读取失败或格式异常，已停止自动修复以避免覆盖现有配置。',
      } }
    }
    if (statusBeforeNormalize.normalizedConfig.changed) {
      emitRepairProgress(spec.channelId, 'config-write', 'in-progress', '正在同步配置...')
      const { applyConfigPatchGuarded } = await import('./openclaw-config-coordinator')
      const writeResult = await applyConfigPatchGuarded({
        beforeConfig: statusBeforeNormalize.currentConfig,
        afterConfig: statusBeforeNormalize.normalizedConfig.config,
        reason: 'managed-channel-plugin-repair',
      })
      if (!writeResult.ok) {
        emitRepairProgress(spec.channelId, 'config-write', 'failed', writeResult.message || '插件配置同步失败')
        recordFailure(spec.channelId, 'repair-failed')
        return { ok: false, result: {
          kind: 'repair-failed',
          channelId: spec.channelId,
          pluginScope: 'channel',
          entityScope: spec.entityScope,
          status: statusBeforeNormalize.status,
          error: writeResult.message || '插件配置同步失败',
        } }
      }
    }
    return { ok: true, status: statusBeforeNormalize.status }
  }

  async function reloadGatewayAfterRepair(
    spec: ManagedChannelPluginLifecycleSpec,
    action: 'reused-existing' | 'installed' | 'restored',
    fallbackStatus: ManagedChannelPluginStatusView
  ): Promise<ManagedChannelPluginRepairResult> {
    emitRepairProgress(spec.channelId, 'gateway-reload', 'in-progress', '正在重载网关...')
    const reloadResult = await resolvedDependencies.reloadGatewayForConfigChange(
      'managed-channel-plugin-repair',
      { preferEnsureWhenNotRunning: true }
    )
    if (!reloadResult.ok || reloadResult.running !== true) {
      emitRepairProgress(spec.channelId, 'gateway-reload', 'failed', reloadResult.summary || reloadResult.stderr || '网关重载失败')
      recordFailure(spec.channelId, 'gateway-reload-failed')
      return {
        kind: 'gateway-reload-failed',
        channelId: spec.channelId,
        pluginScope: 'channel',
        entityScope: spec.entityScope,
        reloadReason: reloadResult.summary || reloadResult.stderr || '网关重载失败',
        retryable: true,
        status: fallbackStatus,
        failedPhase: 'gateway-reload',
      }
    }
    resetFailure(spec.channelId)
    const finalStatus = await buildGenericStatus(spec, resolvedDependencies)
    emitRepairProgress(spec.channelId, 'gateway-reload', 'success', finalStatus.status.summary)
    return {
      kind: 'ok',
      channelId: spec.channelId,
      pluginScope: 'channel',
      entityScope: spec.entityScope,
      action,
      status: finalStatus.status,
    }
  }

  async function repairManagedChannelPlugin(channelId: string, options?: { skipGatewayReload?: boolean }): Promise<ManagedChannelPluginRepairResult> {
    const spec = getManagedChannelLifecycleSpec(channelId)
    if (!spec) {
      return {
        kind: 'repair-failed',
        channelId,
        pluginScope: 'channel',
        entityScope: 'channel',
        status: createEmptyStatus({
          channelId: channelId as ManagedChannelLifecycleId,
          pluginScope: 'channel',
          entityScope: 'channel',
          canonicalPluginId: channelId,
          cleanupPluginIds: [],
          cleanupChannelIds: [],
          installStrategy: 'package',
          supportsBackgroundRestore: true,
          supportsInteractiveRepairUi: true,
          detectConfigured: () => false,
          normalizeConfig: (config) => ({ config: hasOwnRecord(config) ? config : {}, changed: false }),
          reconcileConfig: (config) => ({ config: hasOwnRecord(config) ? config : {}, changed: false }),
        }, '不支持的 managed channel'),
        error: `Unsupported managed channel: ${channelId}`,
      }
    }

    try {
      return await withManagedOperationLock(`managed-channel-plugin:${spec.channelId}`, async () => {
        if (spec.installStrategy === 'interactive-installer') {
          return repairViaInteractiveInstaller(spec)
        }
        const officialAdapterId = toOfficialAdapterId(spec.channelId)
        if (officialAdapterId) {
          return repairViaOfficialAdapter(spec, officialAdapterId)
        }
        const installOutcome = await repairAndInstallGenericPlugin(spec)
        if (!installOutcome.ok) return installOutcome.result
        const configOutcome = await reconcileAndWriteConfig(spec)
        if (!configOutcome.ok) return configOutcome.result
        if (options?.skipGatewayReload) {
          resetFailure(spec.channelId)
          return {
            kind: 'ok',
            channelId: spec.channelId,
            pluginScope: 'channel',
            entityScope: spec.entityScope,
            action: installOutcome.action,
            status: configOutcome.status,
          }
        }
        return reloadGatewayAfterRepair(spec, installOutcome.action, configOutcome.status)
      })
    } catch (error) {
      if (error instanceof ManagedOperationLockTimeoutError) {
        recordFailure(spec.channelId, 'lock-timeout')
        return {
          kind: 'repair-failed',
          channelId: spec.channelId,
          pluginScope: 'channel' as const,
          entityScope: spec.entityScope,
          status: createEmptyStatus(spec, '修复操作等待超时'),
          error: `修复操作等待超时（${Math.round(error.timeoutMs / 1000)}秒），可能有其他修复正在进行，请稍后重试。`,
        }
      }
      throw error
    }
  }

  async function retryGatewayReload(channelId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await resolvedDependencies.reloadGatewayForConfigChange(
        'managed-channel-plugin-repair-retry',
        { preferEnsureWhenNotRunning: true }
      )
      if (result.ok && result.running === true) {
        resetFailure(channelId)
        return { ok: true }
      }
      return { ok: false, error: result.summary || result.stderr || '网关重载重试失败' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    getManagedChannelPluginStatus,
    inspectManagedChannelPlugin,
    prepareManagedChannelPluginForSetup,
    repairManagedChannelPlugin,
    retryGatewayReload,
    getRepairCooldown(channelId: string) {
      return repairCooldowns.get(channelId) || null
    },
    resetRepairCooldown(channelId?: string) {
      if (!channelId) {
        repairCooldowns.clear()
        return
      }
      repairCooldowns.delete(channelId)
    },
  }
}

let defaultManagedChannelPluginLifecycleServicePromise:
  | Promise<ReturnType<typeof createManagedChannelPluginLifecycleService>>
  | null = null

async function getDefaultManagedChannelPluginLifecycleService() {
  if (!defaultManagedChannelPluginLifecycleServicePromise) {
    defaultManagedChannelPluginLifecycleServicePromise = (async () => {
      const cli = await import('./cli')
      const gateway = await import('./gateway-lifecycle-controller')
      const officialAdapters = await import('./official-channel-adapters')
      const commandOutput = await import('./openclaw-command-output')

      return createManagedChannelPluginLifecycleService({
        getOfficialChannelStatus: officialAdapters.getOfficialChannelStatus,
        repairOfficialChannel: officialAdapters.repairOfficialChannel,
        repairIncompatiblePlugins: cli.repairIncompatibleExtensionPlugins,
        installPlugin: cli.installPlugin,
        installPluginNpx: cli.installPluginNpx,
        isPluginInstalledOnDisk: cli.isPluginInstalledOnDisk,
        listRegisteredPlugins: async () => {
          const result = await cli.runCli(['plugins', 'list', '--json'], undefined, 'plugin-install').catch(() => null)
          if (!result?.ok) return null
          const payload = commandOutput.parseJsonFromCommandResult<unknown>(result)
          if (Array.isArray(payload)) {
            return payload.map((item) => normalizeText(item)).filter(Boolean)
          }
          if (hasOwnRecord(payload) && Array.isArray(payload.plugins)) {
            return payload.plugins
              .map((item) => {
                if (typeof item === 'string') return normalizeText(item)
                if (!hasOwnRecord(item)) return ''
                return normalizeText(item.id || item.pluginId || item.name)
              })
              .filter(Boolean)
          }
          return []
        },
        readConfig: cli.readConfig,
        writeConfig: cli.writeConfig,
        reloadGatewayForConfigChange: gateway.reloadGatewayForConfigChange,
        now: () => Date.now(),
      })
    })()
  }

  return defaultManagedChannelPluginLifecycleServicePromise
}

export async function inspectManagedChannelPlugin(channelId: string): Promise<ManagedChannelPluginInspectResult> {
  const service = await getDefaultManagedChannelPluginLifecycleService()
  return service.inspectManagedChannelPlugin(channelId)
}

export async function getManagedChannelPluginStatus(channelId: string): Promise<ManagedChannelPluginStatusView> {
  const service = await getDefaultManagedChannelPluginLifecycleService()
  return service.getManagedChannelPluginStatus(channelId)
}

export async function prepareManagedChannelPluginForSetup(channelId: string): Promise<ManagedChannelPluginPrepareResult> {
  const service = await getDefaultManagedChannelPluginLifecycleService()
  return service.prepareManagedChannelPluginForSetup(channelId)
}

export async function repairManagedChannelPlugin(channelId: string, options?: { skipGatewayReload?: boolean }): Promise<ManagedChannelPluginRepairResult> {
  const service = await getDefaultManagedChannelPluginLifecycleService()
  return service.repairManagedChannelPlugin(channelId, options)
}
