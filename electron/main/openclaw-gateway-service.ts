import { pollWithBackoff } from '../../src/shared/polling'
import type { ReconcileActionSummary } from '../../src/shared/gateway-runtime-reconcile-state'
import { UI_RUNTIME_DEFAULTS } from '../../src/shared/runtime-policies'
import { classifyGatewayRuntimeState } from '../../src/shared/gateway-runtime-diagnostics'
import {
  type GatewayControlUiAppDiagnostics,
  type GatewayPortOwner,
  type GatewayRecoveryAction,
  type GatewayRecoveryOutcome,
  type GatewayRuntimeEvidence,
  type GatewayRuntimeReasonDetail,
  type GatewayRuntimeStateCode,
  isManagedGatewayPort,
  resolveGatewayConfiguredPort,
} from '../../src/shared/gateway-runtime-state'
import {
  checkNode,
  checkOpenClaw,
  gatewayHealth,
  installPlugin,
  installPluginNpx,
  isPluginInstalledOnDisk,
  gatewayRestart,
  gatewayStop,
  getOpenClawPaths,
  gatewayStart,
  installEnv,
  repairIncompatibleExtensionPlugins,
  readConfig,
  readEnvFile,
  refreshEnvironment,
  runDoctor,
  runCli,
  runShell,
  uninstallPlugin,
  type CliResult,
  type GatewayHealthCheckResult,
} from './cli'
import { notifyRepairResult } from './managed-channel-repair-notifications'
import { guardedWriteConfig } from './openclaw-config-guard'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import { findAvailableLoopbackPort, probeGatewayPortOwner } from './openclaw-gateway-probes'
import { cleanupIsolatedNpmCacheEnv, createIsolatedNpmCacheEnv } from './npm-cache-env'
import { reconcileTrustedPluginAllowlist, sanitizeManagedPluginConfig } from './openclaw-plugin-config'
import {
  getManagedChannelPluginByChannelId,
  listManagedChannelPluginRecords,
  type ManagedChannelPluginRecord,
} from '../../src/shared/managed-channel-plugin-registry'
import { isPluginAlreadyInstalledError } from '../../src/shared/openclaw-cli-errors'
import {
  confirmRuntimeReconcile,
  issueDesiredRuntimeRevision,
  markRuntimeRevisionInProgress,
  recordObservedOpenClawVersion,
  resolveGatewayBlockingReasonFromState,
} from './openclaw-runtime-reconcile'

export type GatewayBootstrapPhase =
  | 'runtime-check'
  | 'probe'
  | 'service-install'
  | 'port-recovery'
  | 'restart'
  | 'start-command'
  | 'waiting-ready'
  | 'doctor-check'
  | 'blocked'
  | 'done'

export interface GatewayBootstrapProgressState {
  phase: GatewayBootstrapPhase
  title: string
  detail: string
  progress: number
  attempt?: number
  elapsedMs?: number
}

export interface GatewayEnsureRunningDiagnostics {
  lastHealth: GatewayHealthCheckResult | null
  doctor: CliResult | null
  portOwner?: GatewayPortOwner | null
  controlUiApp?: GatewayControlUiAppDiagnostics | null
}

export interface GatewayEnsureRunningResult extends CliResult {
  running: boolean
  autoInstalledNode: boolean
  autoInstalledOpenClaw: boolean
  autoInstalledGatewayService: boolean
  autoPortMigrated: boolean
  effectivePort: number
  stateCode: GatewayRuntimeStateCode
  summary: string
  attemptedCommands: string[][]
  evidence: GatewayRuntimeEvidence[]
  repairActionsTried: GatewayRecoveryAction[]
  repairOutcome: GatewayRecoveryOutcome
  safeToRetry: boolean
  reasonDetail?: GatewayRuntimeReasonDetail | null
  diagnostics?: GatewayEnsureRunningDiagnostics
}

interface EnsureGatewayRunningOptions {
  onStateChange?: (state: GatewayBootstrapProgressState) => void
  /** Reuse runtime guarantees from EnvCheck and skip Node/OpenClaw prechecks on the final gate page. */
  skipRuntimePrecheck?: boolean
}

const GATEWAY_SERVICE_NOT_LOADED_PATTERN = /\bgateway service not loaded\b/i
const UNKNOWN_MANAGED_CHANNEL_ID_PATTERN =
  /channels\.([A-Za-z0-9._-]+): unknown channel id: ([A-Za-z0-9._-]+)/gi

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const CLAWHUB_RESOLUTION_FAILED_PATTERN = /resolving clawhub:[\s\S]*fetch failed/i
const QCLAW_PLUGIN_NPM_CACHE_ROOT_DIR = path.join(os.tmpdir(), 'qclaw-lite', 'npm-cache')

function extractFirstNonEmptyLine(text: string): string {
  for (const line of String(text || '').split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function isClawHubResolutionFailure(result: CliResult): boolean {
  const detail = `${String(result.stderr || '')}\n${String(result.stdout || '')}`
  return CLAWHUB_RESOLUTION_FAILED_PATTERN.test(detail)
}

async function installPluginFromPackedNpmArchive(
  packageName: string,
  expectedPluginId: string
): Promise<CliResult> {
  const packRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qclaw-plugin-pack-'))
  let npmCacheDir: string | null = null
  try {
    const npmEnv = await createIsolatedNpmCacheEnv(QCLAW_PLUGIN_NPM_CACHE_ROOT_DIR)
    npmCacheDir = npmEnv.cacheDir
    const packResult = await runShell(
      'npm',
      ['pack', packageName, '--silent'],
      undefined,
      {
        cwd: packRoot,
        controlDomain: 'plugin-install',
        env: npmEnv.env,
      }
    )
    if (!packResult.ok) return packResult

    const archiveName = extractFirstNonEmptyLine(packResult.stdout)
    if (!archiveName) {
      return {
        ok: false,
        stdout: packResult.stdout,
        stderr: packResult.stderr || `npm pack 未返回 ${packageName} 的归档文件名`,
        code: packResult.code ?? 1,
      }
    }

    return installPlugin(path.join(packRoot, archiveName), [expectedPluginId])
  } finally {
    await cleanupIsolatedNpmCacheEnv(npmCacheDir)
    await fs.promises.rm(packRoot, { recursive: true, force: true }).catch(() => {
      // Best effort only.
    })
  }
}

// Singleflight locks to prevent concurrent Gateway lifecycle operations
interface EnsureGatewayRunningInFlight {
  promise: Promise<GatewayEnsureRunningResult>
  listeners: Set<(state: GatewayBootstrapProgressState) => void>
  skipRuntimePrecheck: boolean
}

let ensureGatewayInFlight: EnsureGatewayRunningInFlight | null = null

interface GatewayRecoveryContext {
  attemptedCommands: string[][]
  repairActionsTried: GatewayRecoveryAction[]
  evidence: GatewayRuntimeEvidence[]
  effectivePort: number
  autoPortMigrated: boolean
  portOwner: GatewayPortOwner | null
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean)))
}

function cloneConfig(config: Record<string, any> | null): Record<string, any> | null {
  if (!config || typeof config !== 'object') return null
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function createEmptyHealthCheck(): GatewayHealthCheckResult {
  return {
    running: false,
    raw: '',
    stderr: '',
    code: null,
    stateCode: 'gateway_not_running',
    summary: '网关当前没有在本机运行',
  }
}

function createGatewayRecoveryContext(
  effectivePort: number
): GatewayRecoveryContext {
  return {
    attemptedCommands: [],
    repairActionsTried: [],
    evidence: [],
    effectivePort,
    autoPortMigrated: false,
    portOwner: null,
  }
}

function recordGatewayAction(
  context: GatewayRecoveryContext,
  action: GatewayRecoveryAction,
  command?: string[]
): void {
  if (!context.repairActionsTried.includes(action)) {
    context.repairActionsTried.push(action)
  }
  if (Array.isArray(command) && command.length > 0) {
    context.attemptedCommands.push([...command])
  }
}

function appendGatewayEvidence(
  context: GatewayRecoveryContext,
  evidence: GatewayRuntimeEvidence | GatewayRuntimeEvidence[] | null | undefined
): void {
  if (!evidence) return
  if (Array.isArray(evidence)) {
    context.evidence.push(...evidence)
    return
  }
  context.evidence.push(evidence)
}

function buildGatewayReconcileActions(
  context: GatewayRecoveryContext,
  params: {
    running: boolean
    outcome: ReconcileActionSummary['outcome']
    summary?: string | null
  }
): ReconcileActionSummary[] {
  const actions: ReconcileActionSummary[] = [
    {
      kind: 'probe',
      action: 'gateway-health',
      outcome: params.running ? 'succeeded' : params.outcome,
      detail: String(params.summary || '').trim() || undefined,
    },
  ]

  const seen = new Set<string>()
  for (const repairAction of context.repairActionsTried) {
    if (seen.has(repairAction)) continue
    seen.add(repairAction)
    actions.push({
      kind: repairAction === 'migrate-port' ? 'migration' : 'repair',
      action: repairAction,
      outcome: params.outcome,
    })
  }

  return actions
}

function buildGatewayEnsureResult(
  base: Partial<CliResult>,
  flags: Pick<
    GatewayEnsureRunningResult,
    'running' | 'autoInstalledNode' | 'autoInstalledOpenClaw' | 'autoInstalledGatewayService'
  >,
  context: GatewayRecoveryContext,
  extras: Partial<
    Pick<
      GatewayEnsureRunningResult,
      | 'diagnostics'
      | 'stateCode'
      | 'summary'
      | 'repairOutcome'
      | 'safeToRetry'
      | 'reasonDetail'
      | 'effectivePort'
      | 'autoPortMigrated'
    >
  > = {}
): GatewayEnsureRunningResult {
  const classified = classifyGatewayRuntimeState({
    ...base,
    running: flags.running,
    diagnostics: extras.diagnostics,
    evidence: context.evidence,
    portOwner: extras.diagnostics?.portOwner ?? context.portOwner,
    stateCode: extras.stateCode,
    summary: extras.summary,
  })
  const stateCode = flags.running && base.ok ? 'healthy' : extras.stateCode || classified.stateCode
  const summary =
    flags.running && base.ok
      ? '网关已确认可用'
      : String(extras.summary || classified.summary || '网关尚未完成就绪确认')
  return {
    ok: Boolean(base.ok),
    stdout: String(base.stdout || ''),
    stderr: String(base.stderr || ''),
    code: base.code ?? (base.ok ? 0 : 1),
    ...flags,
    autoPortMigrated: extras.autoPortMigrated ?? context.autoPortMigrated,
    effectivePort: extras.effectivePort ?? context.effectivePort,
    stateCode,
    summary,
    attemptedCommands: [...context.attemptedCommands],
    evidence: [...context.evidence, ...classified.evidence],
    repairActionsTried: [...context.repairActionsTried],
    repairOutcome:
      extras.repairOutcome ??
      (flags.running && base.ok
        ? context.repairActionsTried.length > 0 || context.autoPortMigrated
          ? 'recovered'
          : 'not-needed'
        : 'failed'),
    safeToRetry: extras.safeToRetry ?? (flags.running && base.ok ? true : classified.safeToRetry),
    reasonDetail: extras.reasonDetail ?? classified.reasonDetail ?? null,
    diagnostics: extras.diagnostics,
  }
}

function shouldInspectControlUiApp(stateCode: GatewayRuntimeStateCode): boolean {
  return (
    stateCode === 'token_mismatch' ||
    stateCode === 'websocket_1006' ||
    stateCode === 'auth_missing'
  )
}

function buildGatewayDiagnosticsWithControlUi(
  diagnostics: GatewayEnsureRunningDiagnostics,
  controlUiApp: GatewayControlUiAppDiagnostics | null
): GatewayEnsureRunningDiagnostics {
  if (!controlUiApp) return diagnostics
  return {
    ...diagnostics,
    controlUiApp,
  }
}

function projectControlUiAppDiagnostics(input: {
  connected?: boolean
  hasClient?: boolean
  lastError?: string
  appKeys?: string[]
} | null): GatewayControlUiAppDiagnostics | null {
  if (!input) return null
  return {
    source: 'control-ui-app',
    connected: Boolean(input.connected),
    hasClient: Boolean(input.hasClient),
    lastError: String(input.lastError || '').trim() || undefined,
    appKeys: Array.isArray(input.appKeys) ? input.appKeys.map((item) => String(item || '').trim()).filter(Boolean) : [],
  }
}

async function collectControlUiAppDiagnostics(
  stateCode: GatewayRuntimeStateCode
): Promise<GatewayControlUiAppDiagnostics | null> {
  if (!shouldInspectControlUiApp(stateCode)) return null

  try {
    const { inspectControlUiAppViaBrowser } = await import('./openclaw-control-ui-rpc')
    const inspection = await inspectControlUiAppViaBrowser({
      readConfig,
      readEnvFile,
    })
    return projectControlUiAppDiagnostics(inspection)
  } catch {
    return null
  }
}

function joinNonEmpty(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n')
}

function combineCliOutput(result: Partial<CliResult> | null | undefined): string {
  return [String(result?.stderr || '').trim(), String(result?.stdout || '').trim()]
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isSafeAlreadyInstalledManagedPluginInstallError(detail: string): boolean {
  return isPluginAlreadyInstalledError(detail)
    && !String(detail || '').includes('已自动隔离')
    && !String(detail || '').includes('安全修复失败')
}

function resolveManagedChannelRecordByChannelAlias(channelId: string): ManagedChannelPluginRecord | null {
  const directRecord = getManagedChannelPluginByChannelId(channelId)
  if (directRecord) return directRecord

  const normalizedChannelId = normalizeText(channelId).toLowerCase()
  if (!normalizedChannelId) return null

  return listManagedChannelPluginRecords().find((record) =>
    uniqueStrings([record.channelId, ...record.cleanupChannelIds])
      .some((candidate) => candidate.toLowerCase() === normalizedChannelId)
  ) || null
}

function extractUnknownManagedChannelRecords(output: string): ManagedChannelPluginRecord[] {
  const seen = new Set<string>()
  const records: ManagedChannelPluginRecord[] = []

  for (const match of String(output || '').matchAll(UNKNOWN_MANAGED_CHANNEL_ID_PATTERN)) {
    const candidates = [match[1], match[2]]
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean)

    for (const candidate of candidates) {
      const record = resolveManagedChannelRecordByChannelAlias(candidate)
      if (!record || seen.has(record.channelId)) continue
      seen.add(record.channelId)
      records.push(record)
      break
    }
  }

  return records
}

function ensureManagedPluginAllowed(
  config: Record<string, any> | null | undefined,
  record: Pick<ManagedChannelPluginRecord, 'pluginId' | 'cleanupPluginIds'>
): { changed: boolean; config: Record<string, any> } {
  const blockedPluginIds = record.cleanupPluginIds.filter((candidate) => normalizeText(candidate) !== record.pluginId)
  const sanitized = sanitizeManagedPluginConfig(config, {
    blockedPluginIds,
  })
  const nextConfig = sanitized.config
  nextConfig.plugins = hasOwnRecord(nextConfig.plugins) ? nextConfig.plugins : {}
  const allow = Array.isArray(nextConfig.plugins.allow)
    ? nextConfig.plugins.allow
        .map((value: unknown) => normalizeText(value))
        .filter(Boolean)
    : []

  if (!allow.includes(record.pluginId)) {
    allow.push(record.pluginId)
  }

  const allowChanged =
    !Array.isArray(nextConfig.plugins.allow)
    || JSON.stringify(nextConfig.plugins.allow) !== JSON.stringify(allow)
  if (allowChanged) {
    nextConfig.plugins.allow = allow
  }

  return {
    changed: sanitized.changed || allowChanged,
    config: nextConfig,
  }
}

async function tryRepairUnknownManagedChannels(
  options: EnsureGatewayRunningOptions,
  context: GatewayRecoveryContext,
  sourceOutput: string
): Promise<{
  handled: boolean
  recovered: boolean
  blockingFailure: boolean
  health: GatewayHealthCheckResult
  summary: string
} | null> {
  const repairableRecords = extractUnknownManagedChannelRecords(sourceOutput)
  if (repairableRecords.length === 0) {
    return null
  }

  emitGatewayBootstrapState(options, {
    phase: 'doctor-check',
    title: '正在修复渠道插件',
    detail: '检测到旧渠道插件残留或官方插件缺失，系统正在按渠道注册表执行受管插件修复。',
    progress: 94,
  })
  const { repairManagedChannelPlugin } = await import('./managed-channel-plugin-lifecycle')

  for (const record of repairableRecords) {
    recordGatewayAction(
      context,
      'install-plugin',
      ['managed-channel-plugin', 'repair', record.channelId]
    )
    const repairResult = await repairManagedChannelPlugin(record.channelId)
    notifyRepairResult(repairResult, 'gateway-self-heal')
    if (repairResult.kind === 'ok') {
      continue
    }

    if (record.channelId === 'openclaw-weixin' && repairResult.kind === 'manual-action-required') {
      const pluginInstalledBefore = await isPluginInstalledOnDisk(record.pluginId)
      if (!pluginInstalledBefore) {
        let installResult = await installPlugin(record.packageName || '', [record.pluginId])
        if (!installResult.ok && record.packageName && isClawHubResolutionFailure(installResult)) {
          installResult = await installPluginFromPackedNpmArchive(record.packageName, record.pluginId)
        }
        const installedAfterAlreadyExists = isSafeAlreadyInstalledManagedPluginInstallError(installResult.stderr || '')
          ? await isPluginInstalledOnDisk(record.pluginId)
          : false
        if (!installResult.ok && !installedAfterAlreadyExists) {
          const summary = installResult.stderr || `${record.channelId} 插件安装失败`
          appendGatewayEvidence(context, {
            source: 'config',
            message: summary,
            detail: summary,
          })
          return {
            handled: true,
            recovered: false,
            blockingFailure: true,
            health: createEmptyHealthCheck(),
            summary,
          }
        }
      }

      const currentConfig = await readConfig().catch(() => null)
      if (!hasOwnRecord(currentConfig)) {
        appendGatewayEvidence(context, {
          source: 'config',
          message: repairResult.reason,
          detail: '当前 OpenClaw 配置读取失败，后台不会在未知配置上继续写入个人微信插件修复。',
        })
        return {
          handled: true,
          recovered: false,
          blockingFailure: true,
          health: createEmptyHealthCheck(),
          summary: repairResult.reason,
        }
      }

      const normalizedConfig = ensureManagedPluginAllowed(currentConfig, record)
      if (normalizedConfig.changed) {
        const writeResult = await guardedWriteConfig({
          config: normalizedConfig.config,
          reason: 'managed-channel-plugin-repair',
        }).catch(() => null)
        if (!writeResult?.ok) {
          const summary = writeResult?.message || repairResult.reason
          appendGatewayEvidence(context, {
            source: 'config',
            message: summary,
            detail: '个人微信插件已补装，但受管配置写入失败，后台停止继续修复。',
          })
          return {
            handled: true,
            recovered: false,
            blockingFailure: true,
            health: createEmptyHealthCheck(),
            summary,
          }
        }
      }

      const repairedHealth = await safeGatewayHealth()
      appendGatewayEvidence(context, {
        source: 'config',
        message: repairedHealth.running
          ? '个人微信插件已补装并确认网关恢复可用'
          : '个人微信插件已补装，系统将继续按正常启动链路复检网关',
        detail: repairedHealth.summary,
      })

      if (repairedHealth.running) {
        return {
          handled: true,
          recovered: true,
          blockingFailure: false,
          health: repairedHealth,
          summary: '已补装个人微信插件并确认网关恢复可用。',
        }
      }

      if (repairedHealth.stateCode !== 'config_invalid') {
        return {
          handled: true,
          recovered: false,
          blockingFailure: false,
          health: repairedHealth,
          summary: '已补装个人微信插件，网关将继续尝试启动。',
        }
      }
    }

    const summary =
      repairResult.kind === 'gateway-reload-failed'
        ? repairResult.reloadReason
        : repairResult.kind === 'install-failed' || repairResult.kind === 'repair-failed'
          ? repairResult.error
          : repairResult.kind === 'config-sync-required'
            ? repairResult.reason
            : repairResult.kind === 'plugin-ready-channel-not-ready'
              ? repairResult.blockingReason
              : repairResult.kind === 'capability-blocked'
                ? repairResult.missingCapabilities.join('；') || repairResult.status.summary
                : repairResult.kind === 'quarantine-failed'
                  ? repairResult.status.summary || `插件隔离失败：${repairResult.failureKind}`
                  : repairResult.reason

    appendGatewayEvidence(context, {
      source: 'config',
      message: summary,
      detail: repairResult.kind === 'manual-action-required'
        ? '当前后台流程不会自动拉起交互式安装器，请用户在前台手动修复该插件。'
        : summary,
    })
    return {
      handled: true,
      recovered: false,
      blockingFailure: true,
      health: createEmptyHealthCheck(),
      summary,
    }
  }

  const repairedHealth = await safeGatewayHealth()
  appendGatewayEvidence(context, {
    source: 'config',
    message: repairedHealth.running
      ? '受管渠道插件已修复并确认网关恢复可用'
      : '受管渠道插件已修复，网关将继续尝试启动',
    detail: [
      repairedHealth.summary,
    ].filter(Boolean).join('\n').slice(0, 2000),
  })

  return {
    handled: true,
    recovered: Boolean(repairedHealth.running),
    blockingFailure: false,
    health: repairedHealth,
    summary: repairedHealth.running
      ? '已完成受管渠道插件修复并确认网关恢复可用。'
      : '已完成受管渠道插件修复，网关将继续尝试启动。',
  }
}

function doctorSuggestsOfficialRepair(result: Partial<CliResult> | null | undefined): boolean {
  const corpus = combineCliOutput(result).toLowerCase()
  if (!corpus) return false
  return (
    corpus.includes('doctor --fix') ||
    corpus.includes('doctor --repair') ||
    corpus.includes('unknown config keys') ||
    corpus.includes('unrecognized key') ||
    corpus.includes('driver: "extension"') ||
    corpus.includes('browser.relaybindhost') ||
    (corpus.includes('existing-session') && corpus.includes('browser'))
  )
}

async function runDoctorSafely(options?: { fix?: boolean }): Promise<CliResult> {
  return runDoctor(options).catch(
    (error) =>
      ({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error || ''),
        code: 1,
      }) satisfies CliResult
  )
}

interface OfficialGatewayRepairResult {
  recovered: boolean
  repairApplied: boolean
  rolledBack: boolean
  health: GatewayHealthCheckResult
  doctorDiagnostics: CliResult | null
  summary: string
}

async function runOfficialGatewayRepairFlow(
  options: EnsureGatewayRunningOptions,
  context: GatewayRecoveryContext,
  params: {
    triggerSummary: string
    triggerDetail: string
  }
): Promise<OfficialGatewayRepairResult> {
  emitGatewayBootstrapState(options, {
    phase: 'doctor-check',
    title: '正在执行官方升级修复',
    detail: params.triggerDetail,
    progress: 95,
  })

  const preRepairConfig = cloneConfig(await readConfig().catch(() => null))
  if (preRepairConfig) {
    appendGatewayEvidence(context, {
      source: 'config',
      message: '已创建官方修复前配置快照',
      detail: '本次 doctor --fix 如导致配置不可继续解析，将优先回滚到当前快照。',
      port: resolveGatewayConfiguredPort(preRepairConfig),
    })
  }

  recordGatewayAction(context, 'run-doctor', ['doctor', '--non-interactive'])
  const diagnoseResult = await runDoctorSafely()
  const repairRequired = doctorSuggestsOfficialRepair(diagnoseResult)
  if (!repairRequired) {
    const finalHealth = await safeGatewayHealth()
    return {
      recovered: Boolean(finalHealth.running),
      repairApplied: false,
      rolledBack: false,
      health: finalHealth,
      doctorDiagnostics: diagnoseResult,
      summary: finalHealth.running
        ? '官方自检未发现需要迁移的配置，网关已在复检期间恢复可用。'
        : params.triggerSummary,
    }
  }

  recordGatewayAction(context, 'run-doctor', ['doctor', '--fix', '--non-interactive'])
  const repairResult = await runDoctorSafely({ fix: true })

  const rollbackSnapshot = async (): Promise<boolean> => {
    if (!preRepairConfig) return false
    const rollbackResult = await guardedWriteConfig({
      config: preRepairConfig,
      reason: 'unknown',
    }).catch(() => null)
    return Boolean(rollbackResult?.ok)
  }

  if (!repairResult.ok) {
    const rolledBack = await rollbackSnapshot()
    const finalHealth = await safeGatewayHealth()
    appendGatewayEvidence(context, {
      source: 'doctor',
      message: rolledBack
        ? '官方修复失败，已回滚到修复前配置快照'
        : '官方修复失败，当前停留在可诊断状态',
      detail: combineCliOutput(repairResult),
    })
    return {
      recovered: false,
      repairApplied: true,
      rolledBack,
      health: finalHealth,
      doctorDiagnostics: repairResult,
      summary: rolledBack
        ? '官方修复执行失败，已回滚到修复前配置快照。'
        : '官方修复执行失败，当前停留在可诊断状态。',
    }
  }

  const postRepairConfig = await readConfig().catch(() => null)
  if (preRepairConfig && !postRepairConfig) {
    const rolledBack = await rollbackSnapshot()
    const finalHealth = await safeGatewayHealth()
    appendGatewayEvidence(context, {
      source: 'doctor',
      message: rolledBack
        ? '官方修复后配置不可继续解析，已回滚到修复前快照'
        : '官方修复后配置不可继续解析，当前停留在可诊断状态',
      detail: combineCliOutput(repairResult),
    })
    return {
      recovered: false,
      repairApplied: true,
      rolledBack,
      health: finalHealth,
      doctorDiagnostics: repairResult,
      summary: rolledBack
        ? '官方修复后配置无法继续解析，已回滚到修复前快照。'
        : '官方修复后配置无法继续解析，当前停留在可诊断状态。',
    }
  }

  const finalHealth = await safeGatewayHealth()

  appendGatewayEvidence(context, {
    source: 'doctor',
    message: '已执行 OpenClaw 官方迁移',
    detail: combineCliOutput(repairResult) || params.triggerSummary,
  })

  return {
    recovered: Boolean(finalHealth.running),
    repairApplied: true,
    rolledBack: false,
    health: finalHealth,
    doctorDiagnostics: repairResult,
    summary: finalHealth.running
      ? '已执行 OpenClaw 官方迁移并确认网关恢复可用。'
      : '已执行 OpenClaw 官方迁移，但网关仍未完成就绪确认。',
  }
}

function isGatewayServiceNotLoaded(result: Partial<CliResult> | null | undefined): boolean {
  return GATEWAY_SERVICE_NOT_LOADED_PATTERN.test(combineCliOutput(result))
}

function emitGatewayBootstrapState(
  options: EnsureGatewayRunningOptions,
  state: GatewayBootstrapProgressState
): void {
  options.onStateChange?.(state)
}

function addEnsureGatewayListener(
  inFlight: EnsureGatewayRunningInFlight,
  listener?: (state: GatewayBootstrapProgressState) => void
): () => void {
  if (!listener) return () => undefined
  inFlight.listeners.add(listener)
  return () => {
    inFlight.listeners.delete(listener)
  }
}

function emitEnsureGatewayState(
  listeners: Set<(state: GatewayBootstrapProgressState) => void>,
  state: GatewayBootstrapProgressState
): void {
  for (const listener of listeners) {
    listener(state)
  }
}

async function safeGatewayHealth(): Promise<GatewayHealthCheckResult> {
  return gatewayHealth().catch(() => createEmptyHealthCheck())
}

async function waitForGatewayReady(
  options: EnsureGatewayRunningOptions
): Promise<{
  running: boolean
  health: GatewayHealthCheckResult
  attempts: number
  elapsedMs: number
}> {
  let lastHealth = createEmptyHealthCheck()
  const readiness = await pollWithBackoff({
    policy: UI_RUNTIME_DEFAULTS.gatewayReadiness.poll,
    execute: async (context) => {
      emitGatewayBootstrapState(options, {
        phase: 'waiting-ready',
        title: '正在等待网关就绪',
        detail:
          context.attempt > 1
            ? `正在进行第 ${context.attempt} 次就绪确认，请稍候。`
            : '启动命令已执行，正在确认网关是否真正可用。',
        progress: Math.min(92, 58 + context.attempt * 6),
        attempt: context.attempt,
        elapsedMs: context.elapsedMs,
      })
      lastHealth = await safeGatewayHealth()
      return lastHealth
    },
    isSuccess: (value) => Boolean(value.running),
  })

  return {
    running: readiness.ok && Boolean(readiness.value?.running),
    health: readiness.value || lastHealth,
    attempts: readiness.attempts,
    elapsedMs: readiness.elapsedMs,
  }
}

function normalizeGatewayPortOwner(port: number, owner?: GatewayPortOwner | null): GatewayPortOwner {
  if (owner) return owner
  return {
    kind: 'unknown',
    port,
    source: 'unknown',
  }
}

async function restartGatewayAndWait(
  options: EnsureGatewayRunningOptions,
  context: GatewayRecoveryContext,
  detail = '检测到 token 或连接握手异常，系统正在重载网关以尝试恢复。'
): Promise<{
  ok: boolean
  result: CliResult
  ready?: Awaited<ReturnType<typeof waitForGatewayReady>>
}> {
  emitGatewayBootstrapState(options, {
    phase: 'restart',
    title: '正在重载网关',
    detail,
    progress: 72,
  })
  recordGatewayAction(context, 'restart-gateway', ['gateway', 'restart'])
  const restartResult = await gatewayRestart()
  if (!restartResult.ok) {
    appendGatewayEvidence(context, {
      source: 'restart',
      message: '网关重载失败',
      detail: combineCliOutput(restartResult),
    })
    return {
      ok: false,
      result: restartResult,
    }
  }

  recordGatewayAction(context, 'wait-ready')
  const ready = await waitForGatewayReady(options)
  return {
    ok: ready.running,
    result: restartResult,
    ready,
  }
}

async function tryRecoverPortConflict(
  options: EnsureGatewayRunningOptions,
  context: GatewayRecoveryContext
): Promise<{
  recovered: boolean
  startResult?: CliResult
  rollbackConfig?: Record<string, any> | null
}> {
  const currentConfig = await readConfig().catch(() => null)
  const currentPort = resolveGatewayConfiguredPort(currentConfig)
  context.effectivePort = currentPort

  const portOwner = normalizeGatewayPortOwner(
    currentPort,
    await probeGatewayPortOwner(currentPort).catch(() => null)
  )
  context.portOwner = portOwner
  appendGatewayEvidence(context, {
    source: 'port-owner',
    message: '检测到网关端口占用进程',
    detail: [portOwner.processName, portOwner.command, portOwner.pid ? `pid=${portOwner.pid}` : '']
      .filter(Boolean)
      .join(' / '),
    port: currentPort,
    owner: portOwner,
  })

  if (portOwner.kind === 'gateway' || portOwner.kind === 'openclaw') {
    emitGatewayBootstrapState(options, {
      phase: 'port-recovery',
      title: '正在回收旧的网关端口',
      detail: '检测到旧的 OpenClaw/网关进程仍占用端口，系统正在先停止旧实例再重试启动。',
      progress: 50,
    })
    recordGatewayAction(context, 'stop-gateway', ['gateway', 'stop'])
    const stopResult = await gatewayStop().catch(
      (error) =>
        ({
          ok: false,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error || ''),
          code: 1,
        }) satisfies CliResult
    )
    if (stopResult.ok) {
      emitGatewayBootstrapState(options, {
        phase: 'start-command',
        title: '正在重新启动网关',
        detail: '旧实例已经停止，系统正在重新拉起网关。',
        progress: 56,
      })
      recordGatewayAction(context, 'start-gateway', ['gateway', 'start'])
      const retryStart = await gatewayStart()
      if (retryStart.ok) {
        return {
          recovered: true,
          startResult: retryStart,
          rollbackConfig: currentConfig,
        }
      }
    }
  }

  if (!isManagedGatewayPort(currentConfig, currentPort)) {
    return {
      recovered: false,
      rollbackConfig: currentConfig,
    }
  }

  const nextPort = await findAvailableLoopbackPort().catch(() => 0)
  if (!Number.isInteger(nextPort) || nextPort <= 0 || nextPort === currentPort) {
    return {
      recovered: false,
      rollbackConfig: currentConfig,
    }
  }

  emitGatewayBootstrapState(options, {
    phase: 'port-recovery',
    title: '正在切换网关端口',
    detail: `检测到默认端口 ${currentPort} 已被占用，系统正在自动迁移到新的本地端口 ${nextPort}。`,
    progress: 52,
  })

  const migratedConfig = cloneConfig(currentConfig) || {}
  if (!migratedConfig.gateway || typeof migratedConfig.gateway !== 'object' || Array.isArray(migratedConfig.gateway)) {
    migratedConfig.gateway = {}
  }
  migratedConfig.gateway.port = nextPort
  const writeResult = await guardedWriteConfig({
    config: migratedConfig,
    reason: 'gateway-port-recovery',
  })
  if (!writeResult.ok) {
    appendGatewayEvidence(context, {
      source: 'config',
      message: '网关端口迁移写入失败',
      detail: writeResult.message,
      port: currentPort,
      owner: portOwner,
    })
    return {
      recovered: false,
      rollbackConfig: currentConfig,
    }
  }

  context.autoPortMigrated = true
  context.effectivePort = nextPort
  recordGatewayAction(context, 'migrate-port')
  appendGatewayEvidence(context, {
    source: 'config',
    message: `网关已从端口 ${currentPort} 迁移到 ${nextPort}`,
    detail: writeResult.message,
    port: nextPort,
  })

  emitGatewayBootstrapState(options, {
    phase: 'start-command',
    title: '正在使用新端口启动网关',
    detail: `配置已更新到 ${nextPort}，系统正在重新启动网关。`,
    progress: 58,
  })
  recordGatewayAction(context, 'start-gateway', ['gateway', 'start'])
  const retryStart = await gatewayStart()
  if (retryStart.ok) {
    return {
      recovered: true,
      startResult: retryStart,
      rollbackConfig: currentConfig,
    }
  }

  if (currentConfig) {
    await guardedWriteConfig({
      config: currentConfig,
      reason: 'gateway-port-recovery',
    }).catch(() => undefined)
  }
  context.autoPortMigrated = false
  context.effectivePort = currentPort
  appendGatewayEvidence(context, {
    source: 'config',
    message: '新端口启动失败，已回滚网关配置',
    detail: combineCliOutput(retryStart),
    port: currentPort,
  })
  return {
    recovered: false,
    startResult: retryStart,
    rollbackConfig: currentConfig,
  }
}

async function ensureRuntimeReady(
  options: EnsureGatewayRunningOptions,
  context: GatewayRecoveryContext
): Promise<{
  ok: boolean
  result?: GatewayEnsureRunningResult
  autoInstalledNode: boolean
  autoInstalledOpenClaw: boolean
  openClawVersion: string | null
}> {
  const nodeResult = await checkNode()
  const openclawResult = await checkOpenClaw()
  const needNode = !nodeResult.installed
  const needOpenClaw = !openclawResult.installed
  const autoInstalledNode = needNode
  const autoInstalledOpenClaw = needOpenClaw
  const observeVersion = async (version: string | null | undefined): Promise<string | null> => {
    const normalized = String(version || '').trim()
    if (!normalized) return null
    await recordObservedOpenClawVersion(normalized).catch(() => undefined)
    return normalized
  }

  if (nodeResult.installed && nodeResult.needsUpgrade) {
    const upgradeHint = nodeResult.targetVersion
      ? `建议手动升级到 ${nodeResult.targetVersion}`
      : '建议手动升级到 Node.js 最新稳定版'
    return {
      ok: false,
      result: buildGatewayEnsureResult(
        {
          ok: false,
          stdout: '',
          stderr: `Node.js 版本过低（当前 ${nodeResult.version || '未知'}，OpenClaw 需要 Node.js ${nodeResult.requiredVersion} 或更高版本，${upgradeHint}）`,
          code: 1,
        },
        {
          running: false,
          autoInstalledNode: false,
          autoInstalledOpenClaw: false,
          autoInstalledGatewayService: false,
        },
        context,
        {
          summary: 'Node.js 版本过低，网关暂时无法继续启动，请先手动升级 Node.js',
          safeToRetry: false,
        }
      ),
      autoInstalledNode: false,
      autoInstalledOpenClaw: false,
      openClawVersion: null,
    }
  }

  if (!needNode && !needOpenClaw) {
    const openClawVersion = await observeVersion(openclawResult.version)
    return {
      ok: true,
      autoInstalledNode,
      autoInstalledOpenClaw,
      openClawVersion,
    }
  }

  emitGatewayBootstrapState(options, {
    phase: 'runtime-check',
    title: '正在准备运行组件',
    detail: `检测到当前机器还缺少${[needNode ? ' Node.js' : '', needOpenClaw ? ' OpenClaw 命令行工具' : '']
      .filter(Boolean)
      .join(' 和')}，系统正在自动补齐。`,
    progress: 16,
  })
  const installResult = await installEnv({
    needNode,
    needOpenClaw,
  })
  if (!installResult.ok) {
    return {
      ok: false,
      result: buildGatewayEnsureResult(
        installResult,
        {
          running: false,
          autoInstalledNode,
          autoInstalledOpenClaw,
          autoInstalledGatewayService: false,
        },
        context
      ),
      autoInstalledNode,
      autoInstalledOpenClaw,
      openClawVersion: null,
    }
  }

  emitGatewayBootstrapState(options, {
    phase: 'runtime-check',
    title: '正在刷新本机环境',
    detail: '运行组件安装完成，系统正在刷新 PATH 和命令探测结果。',
    progress: 24,
  })
  await refreshEnvironment().catch(() => ({ ok: false }))

  const refreshedNode = await checkNode()
  if (needNode && !refreshedNode.installed) {
    return {
      ok: false,
      result: buildGatewayEnsureResult(
        {
          ok: false,
          stdout: installResult.stdout,
          stderr: 'Node.js 安装后仍不可用',
          code: 1,
        },
        {
          running: false,
          autoInstalledNode,
          autoInstalledOpenClaw,
          autoInstalledGatewayService: false,
        },
        context
      ),
      autoInstalledNode,
      autoInstalledOpenClaw,
      openClawVersion: null,
    }
  }

  const refreshedOpenClaw = await checkOpenClaw()
  if (needOpenClaw && !refreshedOpenClaw.installed) {
    return {
      ok: false,
      result: buildGatewayEnsureResult(
        {
          ok: false,
          stdout: installResult.stdout,
          stderr: 'OpenClaw 命令行工具安装后仍不可用',
          code: 1,
        },
        {
          running: false,
          autoInstalledNode,
          autoInstalledOpenClaw,
          autoInstalledGatewayService: false,
        },
        context
      ),
      autoInstalledNode,
      autoInstalledOpenClaw,
      openClawVersion: null,
    }
  }

  const openClawVersion = await observeVersion(refreshedOpenClaw.version)
  return {
    ok: true,
    autoInstalledNode,
    autoInstalledOpenClaw,
    openClawVersion,
  }
}

/**
 * Ensure gateway.mode is set in the config. Without this, `gateway start`
 * will refuse to run. Defaults to 'local' (single-machine mode).
 * Also ensures the home directory and essential subdirectories exist.
 */
async function ensureGatewayModeConfig(
  existingConfig: Record<string, any> | null
): Promise<boolean> {
  const openClawPaths = await getOpenClawPaths()
  const homeDir = openClawPaths.homeDir

  // Ensure home dir and session dir exist with correct permissions
  const sessionsDir = path.join(homeDir, 'agents', 'main', 'sessions')
  await fs.promises.mkdir(sessionsDir, { recursive: true }).catch(() => undefined)
  if (process.platform !== 'win32') {
    await fs.promises.chmod(homeDir, 0o700).catch(() => undefined)
  }

  // Ensure gateway.mode is set
  const gatewayMode = existingConfig?.gateway?.mode
  if (gatewayMode) return false

  const config: Record<string, any> = existingConfig ? { ...existingConfig } : {}
  if (!config.gateway || typeof config.gateway !== 'object') {
    config.gateway = {}
  }
  config.gateway = { ...config.gateway, mode: 'local' }
  const writeResult = await applyConfigPatchGuarded({
    beforeConfig: existingConfig,
    afterConfig: config,
    reason: 'unknown',
  }, undefined, { applyGatewayPolicy: false })
  if (!writeResult.ok) {
    throw new Error(writeResult.message || '网关 mode 配置写入失败')
  }
  return true
}

async function ensureGatewayRunningImpl(
  options: EnsureGatewayRunningOptions = {}
): Promise<GatewayEnsureRunningResult> {
  const existingConfig = await readConfig().catch(() => null)
  const context = createGatewayRecoveryContext(resolveGatewayConfiguredPort(existingConfig))
  const installedFlags = {
    autoInstalledNode: false,
    autoInstalledOpenClaw: false,
  }
  let reconcileRevision: number | null = null
  let openClawVersion: string | null = null

  const ensureGatewayRuntimeRevision = async (
    pendingReason: string,
    summary: string
  ): Promise<number> => {
    if (reconcileRevision !== null) return reconcileRevision
    const pendingStore = await issueDesiredRuntimeRevision('gateway-bootstrap', pendingReason, {
      actions: [
        {
          kind: 'repair',
          action: 'gateway-runtime-reconcile',
          outcome: 'scheduled',
          detail: summary,
        },
      ],
    })
    reconcileRevision = pendingStore.runtime.desiredRevision
    await markRuntimeRevisionInProgress(reconcileRevision, {
      summary,
      actions: pendingStore.runtime.lastActions,
    })
    return reconcileRevision
  }

  const persistGatewayRuntimeReconcile = async (params: {
    result: Pick<
      GatewayEnsureRunningResult,
      'ok' | 'running' | 'stateCode' | 'summary' | 'safeToRetry' | 'reasonDetail'
    >
    summary?: string
  }): Promise<void> => {
    const confirmed = Boolean(params.result.ok && params.result.running)
    const persistedSummary =
      params.result.reasonDetail ? params.result.summary : params.summary || params.result.summary
    await confirmRuntimeReconcile({
      confirmed,
      revision: reconcileRevision ?? undefined,
      blockingReason: resolveGatewayBlockingReasonFromState({
        gatewayStateCode: params.result.stateCode,
      }),
      blockingDetail: params.result.reasonDetail,
      safeToRetry: confirmed ? true : params.result.safeToRetry,
      summary: persistedSummary,
      actions: buildGatewayReconcileActions(context, {
        running: params.result.running,
        outcome: confirmed ? 'succeeded' : 'failed',
        summary: persistedSummary,
      }),
    })
  }

  if (!options.skipRuntimePrecheck) {
    emitGatewayBootstrapState(options, {
      phase: 'runtime-check',
      title: '正在确认网关运行前置条件',
      detail: '正在确认 Node.js、OpenClaw 命令行工具和基础命令都已就绪。',
      progress: 8,
    })
    const runtimeResult = await ensureRuntimeReady(options, context)
    if (!runtimeResult.ok) {
      return runtimeResult.result as GatewayEnsureRunningResult
    }

    installedFlags.autoInstalledNode = runtimeResult.autoInstalledNode
    installedFlags.autoInstalledOpenClaw = runtimeResult.autoInstalledOpenClaw
    openClawVersion = runtimeResult.openClawVersion
  } else {
    emitGatewayBootstrapState(options, {
      phase: 'probe',
      title: '正在确认网关可放行',
      detail: '当前页将直接复用 EnvCheck 的环境检查结果，只检查本次进入控制面板所需的网关状态。',
      progress: 12,
    })
  }

  const reconciledPluginAllowlist = reconcileTrustedPluginAllowlist(existingConfig)
  const configForStartup = reconciledPluginAllowlist.changed
    ? reconciledPluginAllowlist.config
    : existingConfig
  let configRuntimeApplyRequired = false
  if (reconciledPluginAllowlist.changed) {
    const writeResult = await applyConfigPatchGuarded({
      beforeConfig: existingConfig,
      afterConfig: reconciledPluginAllowlist.config,
      reason: 'unknown',
    }, undefined, { applyGatewayPolicy: false })
    if (!writeResult.ok) {
      throw new Error(writeResult.message || '插件 allowlist 配置写入失败')
    }
    configRuntimeApplyRequired = true
  }

  // Ensure gateway.mode is set — gateway refuses to start without it.
  // Default to 'local' which is the standard single-machine mode.
  const gatewayModePatched = await ensureGatewayModeConfig(configForStartup)
  if (gatewayModePatched) {
    configRuntimeApplyRequired = true
  }

  if (configRuntimeApplyRequired) {
    await ensureGatewayRuntimeRevision(
      'gateway_config_changed',
      '检测到网关启动前配置已修补，正在等待运行状态确认消费最新配置。'
    )
  }

  emitGatewayBootstrapState(options, {
    phase: 'probe',
    title: '正在检查网关当前状态',
    detail: '如果网关已经在运行，会直接放行到控制面板。',
    progress: 18,
  })
  const initialHealth = await safeGatewayHealth()
  appendGatewayEvidence(context, {
    source: 'health',
    message: String(initialHealth.summary || '网关初始健康检查未通过'),
    detail: joinNonEmpty([initialHealth.stderr, initialHealth.raw]).slice(0, 2000),
  })
  const initialClassification = classifyGatewayRuntimeState({
    stderr: initialHealth.stderr,
    stdout: initialHealth.raw,
    diagnostics: {
      lastHealth: initialHealth,
      doctor: null,
    },
    evidence: context.evidence,
  })
  let startupProbeHealth = initialHealth
  let startupProbeClassification = initialClassification
  if (initialHealth.running) {
    if (configRuntimeApplyRequired) {
      const restartAfterConfigPatch = await restartGatewayAndWait(
        options,
        context,
        '网关已在运行，但启动前配置刚刚被修补，系统正在重载并确认其已消费最新配置。'
      )
      if (restartAfterConfigPatch.ok && restartAfterConfigPatch.ready) {
        const result = buildGatewayEnsureResult(
          {
            ok: true,
            stdout: restartAfterConfigPatch.ready.health.raw || restartAfterConfigPatch.result.stdout,
            stderr: restartAfterConfigPatch.ready.health.stderr || restartAfterConfigPatch.result.stderr,
            code: 0,
          },
          {
            running: true,
            autoInstalledGatewayService: false,
            ...installedFlags,
          },
          context
        )
        await persistGatewayRuntimeReconcile({
          result,
          summary: '网关已确认消费启动前修补的最新配置。',
        })
        emitGatewayBootstrapState(options, {
          phase: 'done',
          title: '网关已确认可用',
          detail: '系统已重载网关并确认最新配置生效，正在进入控制面板。',
          progress: 100,
        })
        return result
      }

      const failedResult = buildGatewayEnsureResult(
        restartAfterConfigPatch.result,
        {
          running: false,
          autoInstalledGatewayService: false,
          ...installedFlags,
        },
        context,
        {
          diagnostics: {
            lastHealth: initialHealth,
            doctor: null,
            portOwner: context.portOwner,
          },
        }
      )
      await persistGatewayRuntimeReconcile({
        result: failedResult,
        summary: '网关重载后仍未确认消费启动前修补的配置。',
      })
      return failedResult
    }

    const result = buildGatewayEnsureResult(
      { ok: true, stdout: initialHealth.raw, stderr: initialHealth.stderr, code: 0 },
      {
        running: true,
        autoInstalledGatewayService: false,
        ...installedFlags,
      },
      context
    )
    await persistGatewayRuntimeReconcile({
      result,
      summary:
        openClawVersion && openClawVersion.includes('2026.3.22')
          ? '网关已确认可用，当前 3.22 主链路的运行状态已通过健康探针确认。'
          : '网关已确认可用，运行状态已通过健康探针确认。',
    })
    emitGatewayBootstrapState(options, {
      phase: 'done',
      title: '网关已确认可用',
      detail: '系统检测到网关已经在运行，正在进入控制面板。',
      progress: 100,
    })
    return result
  }

  if (startupProbeClassification.stateCode === 'plugin_load_failure') {
    const pluginRepair = await repairIncompatibleExtensionPlugins({
      quarantineOfficialManagedPlugins: true,
    }).catch((error) => ({
      ok: false,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '损坏插件环境修复失败',
      stderr: error instanceof Error ? error.message : String(error || ''),
    }))

    appendGatewayEvidence(context, {
      source: 'config',
      message: pluginRepair.summary || '已尝试隔离损坏插件环境',
      detail: joinNonEmpty([
        pluginRepair.stderr,
        pluginRepair.quarantinedPluginIds.length > 0
          ? `quarantined: ${pluginRepair.quarantinedPluginIds.join(', ')}`
          : '',
        pluginRepair.prunedPluginIds.length > 0
          ? `pruned: ${pluginRepair.prunedPluginIds.join(', ')}`
          : '',
      ]).slice(0, 2000),
    })

    startupProbeHealth = await safeGatewayHealth()
    startupProbeClassification = classifyGatewayRuntimeState({
      stderr: startupProbeHealth.stderr,
      stdout: startupProbeHealth.raw,
      diagnostics: {
        lastHealth: startupProbeHealth,
        doctor: null,
      },
      portOwner: context.portOwner,
      evidence: context.evidence,
    })
    appendGatewayEvidence(context, startupProbeClassification.evidence)

    if (startupProbeHealth.running) {
      const recoverySummary = pluginRepair.summary || '已隔离损坏插件并确认网关恢复可用。'
      const result = buildGatewayEnsureResult(
        {
          ok: true,
          stdout: startupProbeHealth.raw,
          stderr: startupProbeHealth.stderr,
          code: 0,
        },
        {
          running: true,
          autoInstalledGatewayService: false,
          ...installedFlags,
        },
        context
      )
      await persistGatewayRuntimeReconcile({
        result,
        summary: recoverySummary,
      })
      emitGatewayBootstrapState(options, {
        phase: 'done',
        title: '网关已确认可用',
        detail: recoverySummary,
        progress: 100,
      })
      return result
    }
  }

  if (startupProbeClassification.stateCode === 'config_invalid') {
    const managedChannelRepair = await tryRepairUnknownManagedChannels(
      options,
      context,
      joinNonEmpty([startupProbeHealth.stderr, startupProbeHealth.raw, startupProbeHealth.summary])
    )
    if (managedChannelRepair?.recovered) {
      const result = buildGatewayEnsureResult(
        {
          ok: true,
          stdout: managedChannelRepair.health.raw,
          stderr: managedChannelRepair.health.stderr,
          code: 0,
        },
        {
          running: true,
          autoInstalledGatewayService: false,
          ...installedFlags,
        },
        context
      )
      await persistGatewayRuntimeReconcile({
        result,
        summary: managedChannelRepair.summary,
      })
      emitGatewayBootstrapState(options, {
        phase: 'done',
        title: '网关已确认可用',
        detail: managedChannelRepair.summary,
        progress: 100,
      })
      return result
    }

    if (managedChannelRepair?.blockingFailure) {
      const failedResult = buildGatewayEnsureResult(
        {
          ok: false,
          stdout: managedChannelRepair.health.raw,
          stderr: managedChannelRepair.health.stderr || managedChannelRepair.summary,
          code: managedChannelRepair.health.code || 1,
        },
        {
          running: false,
          autoInstalledGatewayService: false,
          ...installedFlags,
        },
        context,
        {
          stateCode: 'plugin_load_failure',
          summary: managedChannelRepair.summary,
          repairOutcome: 'blocked',
          safeToRetry: false,
          diagnostics: {
            lastHealth: managedChannelRepair.health,
            doctor: null,
            portOwner: context.portOwner,
          },
        }
      )
      await persistGatewayRuntimeReconcile({
        result: failedResult,
        summary: managedChannelRepair.summary,
      })
      return failedResult
    }

    if (
      managedChannelRepair?.handled
      && managedChannelRepair.health.stateCode !== 'config_invalid'
    ) {
      startupProbeHealth = managedChannelRepair.health
      startupProbeClassification = classifyGatewayRuntimeState({
        stderr: startupProbeHealth.stderr,
        stdout: startupProbeHealth.raw,
        diagnostics: {
          lastHealth: startupProbeHealth,
          doctor: null,
        },
        portOwner: context.portOwner,
        evidence: context.evidence,
      })
      appendGatewayEvidence(context, {
        source: 'config',
        message: managedChannelRepair.summary,
        detail: managedChannelRepair.health.summary,
      })
    } else {
      await ensureGatewayRuntimeRevision(
        'gateway_official_repair_required',
        '网关初始健康检查命中了配置不兼容，正在优先执行 OpenClaw 官方修复路径。'
      )
      const officialRepair = await runOfficialGatewayRepairFlow(options, context, {
        triggerSummary: '网关配置不兼容，正在优先执行 OpenClaw 官方修复路径。',
        triggerDetail: '健康检查已识别到配置与当前 OpenClaw 契约不兼容，系统将先执行 doctor --fix 再复检。',
      })
      if (officialRepair.recovered) {
        const result = buildGatewayEnsureResult(
          {
            ok: true,
            stdout: officialRepair.health.raw,
            stderr: officialRepair.health.stderr,
            code: 0,
          },
          {
            running: true,
            autoInstalledGatewayService: false,
            ...installedFlags,
          },
          context
        )
        await persistGatewayRuntimeReconcile({
          result,
          summary: officialRepair.summary,
        })
        emitGatewayBootstrapState(options, {
          phase: 'done',
          title: '网关已确认可用',
          detail: officialRepair.summary,
          progress: 100,
        })
        return result
      }

      const failedDiagnosticsBase = {
        lastHealth: officialRepair.health,
        doctor: officialRepair.doctorDiagnostics,
        portOwner: context.portOwner,
      }
      let failedClassification = classifyGatewayRuntimeState({
        stderr: officialRepair.summary,
        stdout: '',
        diagnostics: {
          lastHealth: failedDiagnosticsBase.lastHealth,
          doctor: failedDiagnosticsBase.doctor,
        },
        portOwner: context.portOwner,
        evidence: context.evidence,
      })
      const failedControlUiApp = await collectControlUiAppDiagnostics(failedClassification.stateCode)
      const failedDiagnostics = buildGatewayDiagnosticsWithControlUi(failedDiagnosticsBase, failedControlUiApp)
      if (failedControlUiApp) {
        failedClassification = classifyGatewayRuntimeState({
          stderr: officialRepair.summary,
          stdout: '',
          diagnostics: failedDiagnostics,
          portOwner: context.portOwner,
          evidence: context.evidence,
        })
      }
      appendGatewayEvidence(context, failedClassification.evidence)

      const failedResult = buildGatewayEnsureResult(
        {
          ok: false,
          stdout: '',
          stderr: officialRepair.summary,
          code: 1,
        },
        {
          running: false,
          autoInstalledGatewayService: false,
          ...installedFlags,
        },
          context,
          {
            stateCode: failedClassification.stateCode,
            summary: failedClassification.reasonDetail
              ? failedClassification.summary
              : officialRepair.summary || failedClassification.summary,
            repairOutcome: failedClassification.safeToRetry ? 'failed' : 'blocked',
            safeToRetry: failedClassification.safeToRetry,
            reasonDetail: failedClassification.reasonDetail,
            diagnostics: failedDiagnostics,
          }
        )
      await persistGatewayRuntimeReconcile({
        result: failedResult,
        summary: officialRepair.summary,
      })
      return failedResult
    }
  }

  let autoInstalledGatewayService = false
  let rollbackConfig: Record<string, any> | null | undefined = undefined
  let restartRepairAttempted = false
  await ensureGatewayRuntimeRevision(
    configRuntimeApplyRequired ? 'gateway_runtime_apply' : 'gateway_start_required',
    configRuntimeApplyRequired
      ? '网关正在应用启动前修补后的配置并确认运行状态。'
      : '网关正在启动并确认当前配置已被运行状态消费。'
  )
  emitGatewayBootstrapState(options, {
    phase: 'start-command',
    title: '正在启动网关',
    detail: '如果后台服务尚未安装，系统会先自动补装。',
    progress: 36,
  })
  recordGatewayAction(context, 'start-gateway', ['gateway', 'start'])
  let startResult = await gatewayStart()
  // The CLI may exit 0 even when the service is not loaded (it prints a hint instead of failing).
  // Check the output text regardless of exit code.
  if (isGatewayServiceNotLoaded(startResult)) {
    emitGatewayBootstrapState(options, {
      phase: 'service-install',
      title: '正在补装网关服务',
      detail: '检测到当前机器还没加载后台服务，正在自动补装。',
      progress: 48,
    })
    recordGatewayAction(context, 'install-service', ['gateway', 'install'])
    // Stop any stale gateway processes before reinstalling the daemon service.
    // Multiple residual processes cause bonjour name conflicts and port races.
    await gatewayStop().catch(() => undefined)
    const installGatewayResult = await runCli(['gateway', 'install'], undefined, 'gateway')
    if (!installGatewayResult.ok) {
      appendGatewayEvidence(context, {
        source: 'service',
        message: '网关服务补装失败',
        detail: combineCliOutput(installGatewayResult),
      })
      const result = buildGatewayEnsureResult(
        installGatewayResult,
        {
          running: false,
          autoInstalledGatewayService,
          ...installedFlags,
        },
        context,
        {
          stateCode: 'service_install_failed',
          summary: '网关后台服务补装失败',
        }
      )
      await persistGatewayRuntimeReconcile({ result })
      return result
    }

    autoInstalledGatewayService = true
    // gateway install may overwrite config (regenerate auth token, reset fields).
    // Re-ensure gateway.mode survives the overwrite.
    const postInstallConfig = await readConfig().catch(() => null)
    await ensureGatewayModeConfig(postInstallConfig)
    emitGatewayBootstrapState(options, {
      phase: 'start-command',
      title: '正在重新启动网关',
      detail: '后台服务补装完成，正在再次启动网关。',
      progress: 56,
    })
    recordGatewayAction(context, 'start-gateway', ['gateway', 'start'])
    startResult = await gatewayStart()
  }

  if (!startResult.ok) {
    const startDiagnosticsBase = {
      lastHealth: startupProbeHealth,
      doctor: null,
      portOwner: context.portOwner,
    }
    let startClassification = classifyGatewayRuntimeState({
      ...startResult,
      diagnostics: {
        lastHealth: null,
        doctor: startDiagnosticsBase.doctor,
      },
      portOwner: context.portOwner,
      evidence: context.evidence,
    })
    const startControlUiApp = await collectControlUiAppDiagnostics(startClassification.stateCode)
    const startDiagnostics = buildGatewayDiagnosticsWithControlUi(startDiagnosticsBase, startControlUiApp)
    if (startControlUiApp) {
      startClassification = classifyGatewayRuntimeState({
        ...startResult,
        diagnostics: {
          lastHealth: null,
          doctor: startDiagnostics.doctor,
          portOwner: startDiagnostics.portOwner,
          controlUiApp: startDiagnostics.controlUiApp,
        },
        portOwner: context.portOwner,
        evidence: context.evidence,
      })
    }
	    appendGatewayEvidence(context, startClassification.evidence)

	    if (startClassification.stateCode === 'config_invalid') {
	      await ensureGatewayRuntimeRevision(
	        'gateway_official_repair_required',
	        '网关启动命令命中了配置不兼容，正在优先执行 OpenClaw 官方修复路径。'
	      )
	      const doctorFlow = await runOfficialGatewayRepairFlow(options, context, {
	        triggerSummary: '网关启动时检测到配置不兼容，系统正在优先执行 OpenClaw 官方修复路径。',
	        triggerDetail: '网关启动命令已识别到配置与当前 OpenClaw 契约不兼容，系统将先执行 doctor --fix 再复检。',
	      })
	      if (doctorFlow.recovered) {
	        const result = buildGatewayEnsureResult(
	          {
	            ok: true,
	            stdout: doctorFlow.health.raw || startResult.stdout,
	            stderr: doctorFlow.health.stderr || startResult.stderr,
	            code: 0,
	          },
	          {
	            running: true,
	            autoInstalledGatewayService,
	            ...installedFlags,
	          },
	          context
	        )
	        await persistGatewayRuntimeReconcile({
	          result,
	          summary: doctorFlow.summary,
	        })
	        emitGatewayBootstrapState(options, {
	          phase: 'done',
	          title: '网关已确认可用',
	          detail: doctorFlow.summary,
	          progress: 100,
	        })
	        return result
	      }

	      const failedDiagnosticsBase = {
	        lastHealth: doctorFlow.health,
	        doctor: doctorFlow.doctorDiagnostics,
	        portOwner: context.portOwner,
	      }
	      let failedClassification = classifyGatewayRuntimeState({
	        stderr: doctorFlow.summary,
	        stdout: combineCliOutput(startResult),
	        diagnostics: {
	          lastHealth: failedDiagnosticsBase.lastHealth,
	          doctor: failedDiagnosticsBase.doctor,
	        },
	        portOwner: context.portOwner,
	        evidence: context.evidence,
	      })
	      const failedControlUiApp = await collectControlUiAppDiagnostics(failedClassification.stateCode)
	      const failedDiagnostics = buildGatewayDiagnosticsWithControlUi(failedDiagnosticsBase, failedControlUiApp)
	      if (failedControlUiApp) {
	        failedClassification = classifyGatewayRuntimeState({
	          stderr: doctorFlow.summary,
	          stdout: combineCliOutput(startResult),
	          diagnostics: failedDiagnostics,
	          portOwner: context.portOwner,
	          evidence: context.evidence,
	        })
	      }
	      appendGatewayEvidence(context, failedClassification.evidence)

	      const result = buildGatewayEnsureResult(
	        {
	          ok: false,
	          stdout: combineCliOutput(startResult),
	          stderr: doctorFlow.summary || startClassification.summary,
	          code: 1,
	        },
	        {
	          running: false,
	          autoInstalledGatewayService,
	          ...installedFlags,
	        },
	        context,
	        {
	          stateCode: failedClassification.stateCode,
	          summary: failedClassification.reasonDetail
	            ? failedClassification.summary
	            : doctorFlow.summary || failedClassification.summary,
	          repairOutcome: failedClassification.safeToRetry ? 'failed' : 'blocked',
	          safeToRetry: failedClassification.safeToRetry,
	          reasonDetail: failedClassification.reasonDetail,
	          diagnostics: failedDiagnostics,
	        }
	      )
	      await persistGatewayRuntimeReconcile({
	        result,
	        summary: doctorFlow.summary,
	      })
	      return result
	    }

	    if (
	      startClassification.stateCode === 'port_conflict_same_gateway' ||
	      startClassification.stateCode === 'port_conflict_foreign_process'
	    ) {
      const recovered = await tryRecoverPortConflict(options, context)
      rollbackConfig = recovered.rollbackConfig
      if (recovered.recovered && recovered.startResult) {
        startResult = recovered.startResult
      } else {
        const result = buildGatewayEnsureResult(
          recovered.startResult || startResult,
          {
            running: false,
            autoInstalledGatewayService,
            ...installedFlags,
          },
          context,
          {
            stateCode: startClassification.stateCode,
            summary: startClassification.summary,
            repairOutcome: 'blocked',
            safeToRetry: startClassification.safeToRetry,
            reasonDetail: startClassification.reasonDetail,
            diagnostics: startDiagnostics,
          }
        )
        await persistGatewayRuntimeReconcile({ result })
        return result
      }
    } else {
      const result = buildGatewayEnsureResult(
        startResult,
        {
          running: false,
          autoInstalledGatewayService,
          ...installedFlags,
        },
        context,
        {
          stateCode: startClassification.stateCode,
          summary: startClassification.summary,
          safeToRetry: startClassification.safeToRetry,
          reasonDetail: startClassification.reasonDetail,
          diagnostics: startDiagnostics,
        }
      )
      await persistGatewayRuntimeReconcile({ result })
      return result
    }
  }

  recordGatewayAction(context, 'wait-ready')
  let ready = await waitForGatewayReady(options)
  if (!ready.running) {
    const readyDiagnosticsBase = {
      lastHealth: ready.health,
      doctor: null,
      portOwner: context.portOwner,
    }
    let readyClassification = classifyGatewayRuntimeState({
      stderr: '网关启动命令已执行，但系统仍未确认网关已经准备完成',
      stdout: combineCliOutput(startResult),
      diagnostics: {
        lastHealth: readyDiagnosticsBase.lastHealth,
        doctor: readyDiagnosticsBase.doctor,
      },
      portOwner: context.portOwner,
      evidence: context.evidence,
    })
    const readyControlUiApp = await collectControlUiAppDiagnostics(readyClassification.stateCode)
    const readyDiagnostics = buildGatewayDiagnosticsWithControlUi(readyDiagnosticsBase, readyControlUiApp)
    if (readyControlUiApp) {
      readyClassification = classifyGatewayRuntimeState({
        stderr: '网关启动命令已执行，但系统仍未确认网关已经准备完成',
        stdout: combineCliOutput(startResult),
        diagnostics: readyDiagnostics,
        portOwner: context.portOwner,
        evidence: context.evidence,
      })
    }
    appendGatewayEvidence(context, readyClassification.evidence)

    if (
      !restartRepairAttempted &&
      (readyClassification.stateCode === 'token_mismatch' ||
        readyClassification.stateCode === 'websocket_1006')
    ) {
      restartRepairAttempted = true
      const restartRepair = await restartGatewayAndWait(options, context)
      if (restartRepair.ok && restartRepair.ready) {
        const result = buildGatewayEnsureResult(
          {
            ok: true,
            stdout: restartRepair.ready.health.raw || restartRepair.result.stdout || startResult.stdout,
            stderr: restartRepair.ready.health.stderr || restartRepair.result.stderr || startResult.stderr,
            code: 0,
          },
          {
            running: true,
            autoInstalledGatewayService,
            ...installedFlags,
          },
          context
        )
        await persistGatewayRuntimeReconcile({
          result,
          summary: '网关已通过自动重载确认消费当前运行状态配置。',
        })
        emitGatewayBootstrapState(options, {
          phase: 'done',
          title: '网关已确认可用',
          detail: '系统已经通过自动重载恢复网关，正在进入控制面板。',
          progress: 100,
          elapsedMs: restartRepair.ready.elapsedMs,
        })
        return result
      }
      if (restartRepair.ready) {
        ready = restartRepair.ready
      }
    }

    const doctorFlow = await runOfficialGatewayRepairFlow(options, context, {
      triggerSummary: '网关尚未确认就绪，系统已补充官方诊断并在必要时执行官方修复路径。',
      triggerDetail: '网关尚未确认就绪，系统将先做官方诊断；如命中迁移建议，则优先执行 doctor --fix。',
    })
    const doctorResult = doctorFlow.doctorDiagnostics
    const finalHealth = doctorFlow.health
    if (finalHealth.running) {
      const result = buildGatewayEnsureResult(
        {
          ok: true,
          stdout: finalHealth.raw || startResult.stdout,
          stderr: finalHealth.stderr || startResult.stderr,
          code: 0,
        },
        {
          running: true,
          autoInstalledGatewayService,
          ...installedFlags,
        },
        context
      )
      await persistGatewayRuntimeReconcile({
        result,
        summary: doctorFlow.summary,
      })
      emitGatewayBootstrapState(options, {
        phase: 'done',
        title: '网关已确认可用',
        detail: doctorFlow.summary,
        progress: 100,
      })
      return result
    }

    const failedHealth = finalHealth.raw || finalHealth.stderr ? finalHealth : ready.health
    const finalDiagnosticsBase = {
      lastHealth: failedHealth,
      doctor: doctorResult,
      portOwner: context.portOwner,
    }
    let finalClassification = classifyGatewayRuntimeState({
      stderr: '网关启动命令已执行，但系统仍未确认网关已经准备完成',
      stdout: combineCliOutput(startResult),
      diagnostics: {
        lastHealth: finalDiagnosticsBase.lastHealth,
        doctor: finalDiagnosticsBase.doctor,
      },
      portOwner: context.portOwner,
      evidence: context.evidence,
    })
    const finalControlUiApp = await collectControlUiAppDiagnostics(finalClassification.stateCode)
    const finalDiagnostics = buildGatewayDiagnosticsWithControlUi(finalDiagnosticsBase, finalControlUiApp)
    if (finalControlUiApp) {
      finalClassification = classifyGatewayRuntimeState({
        stderr: '网关启动命令已执行，但系统仍未确认网关已经准备完成',
        stdout: combineCliOutput(startResult),
        diagnostics: finalDiagnostics,
        portOwner: context.portOwner,
        evidence: context.evidence,
      })
    }
    appendGatewayEvidence(context, finalClassification.evidence)

    if (context.autoPortMigrated && rollbackConfig) {
      await guardedWriteConfig({
        config: rollbackConfig,
        reason: 'gateway-port-recovery',
      }).catch(() => undefined)
      appendGatewayEvidence(context, {
        source: 'config',
        message: '网关新端口未验证通过，已回滚到原端口配置',
        port: resolveGatewayConfiguredPort(rollbackConfig),
      })
      context.autoPortMigrated = false
      context.effectivePort = resolveGatewayConfiguredPort(rollbackConfig)
    }

    const result = buildGatewayEnsureResult(
      {
        ok: false,
        stdout: combineCliOutput(startResult),
        stderr: doctorFlow.summary || '网关启动命令已执行，但系统仍未确认网关已经准备完成',
        code: 1,
      },
      {
        running: false,
        autoInstalledGatewayService,
        ...installedFlags,
      },
      context,
      {
        stateCode: finalClassification.stateCode,
        summary: finalClassification.summary,
        repairOutcome: finalClassification.safeToRetry ? 'failed' : 'blocked',
        safeToRetry: finalClassification.safeToRetry,
        reasonDetail: finalClassification.reasonDetail,
        diagnostics: finalDiagnostics,
      }
    )
    await persistGatewayRuntimeReconcile({
      result,
      summary: doctorFlow.summary,
    })
    return result
  }

  emitGatewayBootstrapState(options, {
    phase: 'done',
    title: '网关已确认可用',
    detail: '网关已经准备完成，正在进入控制面板。',
    progress: 100,
    elapsedMs: ready.elapsedMs,
  })
  const result = buildGatewayEnsureResult(
    {
      ok: true,
      stdout: ready.health.raw || startResult.stdout,
      stderr: ready.health.stderr || startResult.stderr,
      code: 0,
    },
    {
      running: true,
      autoInstalledGatewayService,
      ...installedFlags,
    },
    context
  )
  await persistGatewayRuntimeReconcile({
    result,
    summary: '网关已确认消费当前配置并完成就绪。',
  })
  return result
}

export async function ensureGatewayRunning(
  options: EnsureGatewayRunningOptions = {}
): Promise<GatewayEnsureRunningResult> {
  const skipRuntimePrecheck = Boolean(options.skipRuntimePrecheck)

  while (true) {
    const active = ensureGatewayInFlight
    if (active) {
      // Do not downgrade strict callers to a skip-runtime run.
      if (!skipRuntimePrecheck && active.skipRuntimePrecheck) {
        await active.promise.catch(() => undefined)
        continue
      }
      const detach = addEnsureGatewayListener(active, options.onStateChange)
      try {
        return await active.promise
      } finally {
        detach()
      }
    }

    const listeners = new Set<(state: GatewayBootstrapProgressState) => void>()
    if (options.onStateChange) {
      listeners.add(options.onStateChange)
    }

    const createdInFlight: EnsureGatewayRunningInFlight = {
      listeners,
      skipRuntimePrecheck,
      promise: ensureGatewayRunningImpl({
        skipRuntimePrecheck,
        onStateChange: (state) => emitEnsureGatewayState(listeners, state),
      }),
    }

    ensureGatewayInFlight = createdInFlight
    const detach = addEnsureGatewayListener(createdInFlight, options.onStateChange)
    try {
      return await createdInFlight.promise
    } finally {
      detach()
      if (ensureGatewayInFlight === createdInFlight) {
        ensureGatewayInFlight = null
      }
      listeners.clear()
    }
  }
}
