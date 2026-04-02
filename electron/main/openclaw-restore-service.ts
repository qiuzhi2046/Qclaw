import type { OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type {
  OpenClawBackupEntry,
  OpenClawRestorePreviewResult,
  OpenClawRestoreRunResult,
  OpenClawRestoreScope,
} from '../../src/shared/openclaw-phase3'
import { atomicWriteFile } from './atomic-write'
import { collectChangedJsonPaths } from './openclaw-config-diff'
import { applyGatewaySecretAction } from './gateway-secret-apply'
import { resolveGatewayApplyAction } from './gateway-apply-policy'
import { reloadGatewayForConfigChange } from './gateway-lifecycle-controller'
import { readEnvFile as readRuntimeEnvFile, runCli, runCliWithBinary } from './cli'
import {
  createManagedBackupArchive,
  createStateRootBackupArchive,
  getOpenClawBackupEntry,
} from './openclaw-backup-index'
import {
  pruneStalePluginConfigEntries,
  repairStalePluginConfigFromCommandResult,
} from './openclaw-config-warnings'
import { discoverOpenClawInstallations } from './openclaw-install-discovery'
import { resolveOpenClawPathsFromStateRoot } from './openclaw-paths'
import { rerunReadOnlyCommandAfterStalePluginRepair } from './openclaw-readonly-stale-plugin-repair'
import { resolveRuntimeOpenClawPaths } from './openclaw-runtime-paths'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { access, cp, mkdir, readFile, readdir, rm, stat } = fs.promises

const MODEL_RELOAD_PATH_PREFIXES = [
  '$.defaultModel',
  '$.model',
  '$.allowed',
  '$.allow',
  '$.denied',
  '$.deny',
  '$.fallbacks',
  '$.imageFallbacks',
  '$.image_fallbacks',
  '$.aliases',
  '$.models',
  '$.agents.defaults.model',
  '$.agents.defaults.models',
  '$.auth.profiles',
] as const

function isPathMatched(pathValue: string, prefix: string): boolean {
  return pathValue === prefix || pathValue.startsWith(`${prefix}.`) || pathValue.startsWith(`${prefix}[`)
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function ensureObject(parent: Record<string, any>, key: string): Record<string, any> {
  const current = parent[key]
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, any>
  }
  parent[key] = {}
  return parent[key] as Record<string, any>
}

function sanitizeRestoredConfig(config: Record<string, any>): {
  config: Record<string, any>
  warnings: string[]
} {
  const nextConfig = cloneJsonValue(config) || {}
  const warnings: string[] = []
  const legacyDefaultModel = String(nextConfig.defaultModel ?? '').trim()
  const hasLegacyDefaultModel = Object.prototype.hasOwnProperty.call(nextConfig, 'defaultModel')

  if (hasLegacyDefaultModel) {
    const agents = ensureObject(nextConfig, 'agents')
    const defaults = ensureObject(agents, 'defaults')
    const modelConfig = ensureObject(defaults, 'model')
    const currentPrimary = String(modelConfig.primary ?? '').trim()

    if (!currentPrimary && legacyDefaultModel) {
      modelConfig.primary = legacyDefaultModel
      warnings.push('备份中的顶层 defaultModel 已在恢复时迁移到 agents.defaults.model.primary。')
    } else {
      warnings.push('备份中的顶层 defaultModel 已在恢复时移除。')
    }

    delete nextConfig.defaultModel
  }

  return {
    config: nextConfig,
    warnings,
  }
}

async function writeSanitizedConfigFile(
  sourcePath: string,
  targetPath: string,
  description = 'OpenClaw 主配置'
): Promise<string[]> {
  const raw = await readFile(sourcePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('备份中的 openclaw.json 无法解析，已阻止恢复以避免回流损坏配置。')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('备份中的 openclaw.json 不是对象配置，已阻止恢复以避免回流损坏配置。')
  }

  const sanitized = sanitizeRestoredConfig(parsed as Record<string, any>)
  const configMode = (await stat(sourcePath)).mode & 0o777
  await atomicWriteFile(targetPath, `${JSON.stringify(sanitized.config, null, 2)}\n`, {
    description,
    mode: configMode,
  })

  return sanitized.warnings
}

async function sanitizeConfigFileInPlace(filePath: string): Promise<string[]> {
  if (!(await pathExists(filePath))) return []

  const raw = await readFile(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('恢复后的 openclaw.json 无法解析，已阻止继续保留可能损坏的配置。')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('恢复后的 openclaw.json 不是对象配置，已阻止继续保留可能损坏的配置。')
  }

  const sanitized = sanitizeRestoredConfig(parsed as Record<string, any>)
  if (sanitized.warnings.length === 0) return []

  const configMode = (await stat(filePath)).mode & 0o777
  await atomicWriteFile(filePath, `${JSON.stringify(sanitized.config, null, 2)}\n`, {
    description: 'OpenClaw 主配置',
    mode: configMode,
  })

  return sanitized.warnings
}

async function readJsonFileIfExists(filePath: string): Promise<Record<string, any> | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as Record<string, any>
  } catch {
    return null
  }
}

async function readEnvFileIfExists(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/g)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex <= 0) continue
      parsed[trimmed.slice(0, separatorIndex)] = trimmed.slice(separatorIndex + 1)
    }
    return parsed
  } catch {
    return {}
  }
}

function collectChangedEnvKeys(
  previousEnv: Record<string, string>,
  nextEnv: Record<string, string>
): string[] {
  const keys = new Set([...Object.keys(previousEnv), ...Object.keys(nextEnv)])
  return Array.from(keys)
    .filter((key) => previousEnv[key] !== nextEnv[key])
    .sort((left, right) => left.localeCompare(right))
}

function hasModelRuntimeChange(changedJsonPaths: string[]): boolean {
  return changedJsonPaths.some((changedPath) =>
    MODEL_RELOAD_PATH_PREFIXES.some((prefix) => isPathMatched(changedPath, prefix))
  )
}

function appendOptionalWarning(warnings: string[], warning?: string): string[] {
  const normalized = String(warning || '').trim()
  return normalized ? [...warnings, normalized] : warnings
}

function buildCliOutput(result: { stdout?: string; stderr?: string } | null | undefined): string {
  return [String(result?.stderr || '').trim(), String(result?.stdout || '').trim()]
    .filter(Boolean)
    .join('\n')
    .trim()
}

function doctorSuggestsOfficialRepair(result: { stdout?: string; stderr?: string } | null | undefined): boolean {
  const corpus = buildCliOutput(result).toLowerCase()
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

function isUnsupportedDoctorFixFlag(result: { ok: boolean; stdout?: string; stderr?: string }): boolean {
  if (result.ok) return false
  const corpus = `${String(result.stderr || '')}\n${String(result.stdout || '')}`.toLowerCase()
  return /unknown option|unknown flag|unknown argument|invalid option|no such option|unexpected argument/.test(corpus)
    && corpus.includes('--fix')
}

function combineOptionalNotes(...notes: Array<string | undefined>): string | undefined {
  const combined = notes
    .map((note) => String(note || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return combined || undefined
}

function buildTargetCliEnvOverride(
  runtimeEnv: Record<string, string>,
  targetEnv: Record<string, string>
): Partial<NodeJS.ProcessEnv> | undefined {
  const keys = new Set([...Object.keys(runtimeEnv), ...Object.keys(targetEnv)])
  const overrides: Partial<NodeJS.ProcessEnv> = {}

  for (const key of keys) {
    if (runtimeEnv[key] === targetEnv[key]) continue
    overrides[key] = Object.prototype.hasOwnProperty.call(targetEnv, key) ? targetEnv[key] : undefined
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function resolveAvailableScopes(backup: OpenClawBackupEntry): OpenClawRestoreScope[] {
  const scopes: OpenClawRestoreScope[] = []
  const hasConfigScope =
    backup.scopeAvailability.hasConfigData ||
    backup.scopeAvailability.hasEnvData ||
    backup.scopeAvailability.hasCredentialsData
  if (hasConfigScope) scopes.push('config')
  if (backup.scopeAvailability.hasMemoryData) scopes.push('memory')
  if (hasConfigScope && backup.scopeAvailability.hasMemoryData) scopes.push('all')
  return scopes
}

function buildRestoreItems(backup: OpenClawBackupEntry): string[] {
  const items: string[] = []
  if (backup.scopeAvailability.hasConfigData) {
    items.push('备份中包含 OpenClaw 主配置 openclaw.json。')
  }
  if (backup.scopeAvailability.hasEnvData) {
    items.push('备份中包含环境变量文件 .env。')
  }
  if (backup.scopeAvailability.hasCredentialsData) {
    items.push('备份中包含 credentials 目录。')
  }
  if (backup.scopeAvailability.hasMemoryData) {
    items.push('备份中包含完整 openclaw-home，可恢复用户记忆数据。')
  }
  return items
}

async function resolveSourcePaths(backup: OpenClawBackupEntry): Promise<{
  homeDir: string | null
  configFile: string | null
  envFile: string | null
  credentialsDir: string | null
}> {
  const fullHomeDir = path.join(backup.archivePath, 'openclaw-home')
  const rootConfigFile = (await pathExists(path.join(backup.archivePath, 'openclaw.json')))
    ? path.join(backup.archivePath, 'openclaw.json')
    : null
  const rootEnvFile = (await pathExists(path.join(backup.archivePath, '.env'))) ? path.join(backup.archivePath, '.env') : null
  const rootCredentialsDir = (await pathExists(path.join(backup.archivePath, 'credentials')))
    ? path.join(backup.archivePath, 'credentials')
    : null
  if (await pathExists(fullHomeDir)) {
    return {
      homeDir: fullHomeDir,
      configFile: rootConfigFile ||
        ((await pathExists(path.join(fullHomeDir, 'openclaw.json')))
          ? path.join(fullHomeDir, 'openclaw.json')
          : null),
      envFile: (await pathExists(path.join(fullHomeDir, '.env'))) ? path.join(fullHomeDir, '.env') : rootEnvFile,
      credentialsDir: (await pathExists(path.join(fullHomeDir, 'credentials')))
        ? path.join(fullHomeDir, 'credentials')
        : rootCredentialsDir,
    }
  }

  return {
    homeDir: null,
    configFile: rootConfigFile,
    envFile: rootEnvFile,
    credentialsDir: rootCredentialsDir,
  }
}

function resolveCurrentCandidate(candidates: OpenClawInstallCandidate[]): OpenClawInstallCandidate | null {
  return candidates.find((candidate) => candidate.isPathActive) || candidates[0] || null
}

function normalizePathForCompare(inputPath: string): string {
  const normalized = String(inputPath || '').trim()
  if (!normalized) return ''
  const resolved = path.resolve(normalized)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

interface RestoreTargetResolution {
  targetPaths: ReturnType<typeof resolveOpenClawPathsFromStateRoot>
  candidate: OpenClawInstallCandidate | null
  warning?: string
}

async function resolveRestoreTarget(
  backup: OpenClawBackupEntry
): Promise<RestoreTargetResolution> {
  const sourceStateRoot = String(backup.sourceStateRoot || '').trim()
  const sourceConfigPath = String(backup.sourceConfigPath || '').trim()
  const normalizedSourceStateRoot = normalizePathForCompare(sourceStateRoot)
  const normalizedSourceConfigPath = normalizePathForCompare(sourceConfigPath)
  const backupProvidedSourcePath = Boolean(normalizedSourceStateRoot || normalizedSourceConfigPath)

  const discovery = await discoverOpenClawInstallations()
  const matchingCandidate = discovery.candidates.find((candidate) => {
    const candidateStateRoot = normalizePathForCompare(candidate.stateRoot)
    const candidateConfigPath = normalizePathForCompare(candidate.configPath)
    return (
      (normalizedSourceStateRoot && candidateStateRoot === normalizedSourceStateRoot) ||
      (normalizedSourceConfigPath && candidateConfigPath === normalizedSourceConfigPath)
    )
  }) || null
  if (matchingCandidate) {
    return {
      targetPaths: resolveOpenClawPathsFromStateRoot({
        stateRoot: matchingCandidate.stateRoot,
        configFile: matchingCandidate.configPath,
      }),
      candidate: matchingCandidate,
    }
  }

  const activeCandidate = resolveCurrentCandidate(discovery.candidates)
  if (activeCandidate) {
    return {
      targetPaths: resolveOpenClawPathsFromStateRoot({
        stateRoot: activeCandidate.stateRoot,
        configFile: activeCandidate.configPath,
      }),
      candidate: activeCandidate,
      warning: backupProvidedSourcePath
        ? '备份记录的原始恢复路径未匹配当前 OpenClaw 安装，已回退到当前活动安装。'
        : undefined,
    }
  }

  return {
    targetPaths: await resolveRuntimeOpenClawPaths(),
    candidate: null,
    warning: backupProvidedSourcePath
      ? '备份记录的原始恢复路径未匹配当前 OpenClaw 安装，已回退到当前默认路径。'
      : undefined,
  }
}

async function createRestorePreflightSnapshot(
  resolution: RestoreTargetResolution
) {
  if (resolution.candidate && (await pathExists(resolution.candidate.stateRoot))) {
    return createManagedBackupArchive({
      candidate: resolution.candidate,
      backupType: 'restore-preflight',
      copyMode: 'full-state',
    })
  }

  if (await pathExists(resolution.targetPaths.homeDir)) {
    return createStateRootBackupArchive({
      stateRoot: resolution.targetPaths.homeDir,
      backupType: 'restore-preflight',
    })
  }

  return null
}

async function copyPathIfExists(sourcePath: string | null, targetPath: string): Promise<void> {
  if (!sourcePath) return
  if (!(await pathExists(sourcePath))) return
  await cp(sourcePath, targetPath, { recursive: true, force: true })
}

async function removeIfExists(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true })
}

async function restoreConfigScope(
  backup: OpenClawBackupEntry,
  targetPaths: ReturnType<typeof resolveOpenClawPathsFromStateRoot>
): Promise<{ restoredItems: string[]; restoredCredentials: boolean; warnings: string[] }> {
  const sourcePaths = await resolveSourcePaths(backup)
  const restoredItems: string[] = []
  const warnings: string[] = []
  let restoredCredentials = false

  await mkdir(targetPaths.homeDir, { recursive: true })

  if (sourcePaths.configFile) {
    await mkdir(path.dirname(targetPaths.configFile), { recursive: true })
    warnings.push(...(await writeSanitizedConfigFile(sourcePaths.configFile, targetPaths.configFile)))
    restoredItems.push('已恢复 openclaw.json')
  }
  if (sourcePaths.envFile) {
    await copyPathIfExists(sourcePaths.envFile, targetPaths.envFile)
    restoredItems.push('已恢复 .env')
  }
  if (sourcePaths.credentialsDir) {
    await removeIfExists(targetPaths.credentialsDir)
    await copyPathIfExists(sourcePaths.credentialsDir, targetPaths.credentialsDir)
    restoredItems.push('已恢复 credentials 目录')
    restoredCredentials = true
  }

  return {
    restoredItems,
    restoredCredentials,
    warnings,
  }
}

async function restoreMemoryScope(
  backup: OpenClawBackupEntry,
  targetPaths: ReturnType<typeof resolveOpenClawPathsFromStateRoot>,
  replaceAll: boolean
): Promise<{ restoredItems: string[]; warnings: string[] }> {
  const sourcePaths = await resolveSourcePaths(backup)
  if (!sourcePaths.homeDir) {
    throw new Error('当前备份不包含完整的记忆数据，无法执行记忆恢复。')
  }

  if (replaceAll) {
    await removeIfExists(targetPaths.homeDir)
    await copyPathIfExists(sourcePaths.homeDir, targetPaths.homeDir)
    const homeConfigPath = path.join(targetPaths.homeDir, 'openclaw.json')
    const warnings =
      normalizePathForCompare(homeConfigPath) === normalizePathForCompare(targetPaths.configFile)
        ? []
        : await sanitizeConfigFileInPlace(homeConfigPath)
    return {
      restoredItems: ['已整体恢复 openclaw-home（配置与记忆数据）'],
      warnings,
    }
  }

  await mkdir(targetPaths.homeDir, { recursive: true })
  const restoredItems: string[] = []
  const entries = await readdir(sourcePaths.homeDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'openclaw.json' || entry.name === '.env' || entry.name === 'credentials') {
      continue
    }

    const sourcePath = path.join(sourcePaths.homeDir, entry.name)
    const targetPath = path.join(targetPaths.homeDir, entry.name)
    await removeIfExists(targetPath)
    await copyPathIfExists(sourcePath, targetPath)
    restoredItems.push(`已恢复 ${entry.name}`)
  }

  return {
    restoredItems,
    warnings: [],
  }
}

async function applyRestoreRuntimeChanges(params: {
  scope: OpenClawRestoreScope
  targetResolution: RestoreTargetResolution
  targetPaths: ReturnType<typeof resolveOpenClawPathsFromStateRoot>
  beforeConfig: Record<string, any> | null
  beforeEnv: Record<string, string>
  beforeCredentialsPresent: boolean
  forceRestart: boolean
}): Promise<{
  gatewayApply: NonNullable<OpenClawRestoreRunResult['gatewayApply']>
  warnings: string[]
}> {
  if (params.scope === 'memory') {
    return {
      gatewayApply: {
        ok: true,
        requestedAction: 'none',
        appliedAction: 'none',
      },
      warnings: [],
    }
  }

  const officialRepair = await runOfficialDoctorRepairAfterRestore({
    targetResolution: params.targetResolution,
    targetPaths: params.targetPaths,
  })
  if (!officialRepair.ok) {
    return {
      gatewayApply: {
        ok: false,
        requestedAction: 'restart',
        appliedAction: 'none',
        note: combineOptionalNotes(officialRepair.summary, ...officialRepair.warnings),
      },
      warnings: officialRepair.warnings,
    }
  }

  const afterConfig = await readJsonFileIfExists(params.targetPaths.configFile)
  const afterEnv = await readEnvFileIfExists(params.targetPaths.envFile)
  const afterCredentialsPresent = await pathExists(params.targetPaths.credentialsDir)
  const changedJsonPaths = collectChangedJsonPaths(params.beforeConfig, afterConfig)
  const changedEnvKeys = collectChangedEnvKeys(params.beforeEnv, afterEnv)
  const credentialsPresenceChanged = params.beforeCredentialsPresent !== afterCredentialsPresent
  const requiresModelReload = hasModelRuntimeChange(changedJsonPaths)
  const decision = resolveGatewayApplyAction({
    changedJsonPaths,
    changedEnvKeys,
  })

  if (
    !officialRepair.applied &&
    !params.forceRestart &&
    !credentialsPresenceChanged &&
    !requiresModelReload &&
    decision.action === 'none'
  ) {
    return {
      gatewayApply: {
        ok: true,
        requestedAction: 'none',
        appliedAction: 'none',
      },
      warnings: officialRepair.warnings,
    }
  }

  if (
    officialRepair.applied ||
    params.forceRestart ||
    credentialsPresenceChanged ||
    requiresModelReload ||
    decision.action === 'restart'
  ) {
    const reloadResult = await reloadGatewayForRestoreTarget(params.targetResolution)
    return {
      gatewayApply: {
        ok: Boolean(reloadResult?.ok),
        requestedAction: 'restart',
        appliedAction: 'restart',
        note: combineOptionalNotes(
          officialRepair.applied ? officialRepair.summary : undefined,
          reloadResult?.stderr || reloadResult?.stdout || ''
        ),
      },
      warnings: officialRepair.warnings,
    }
  }

  return {
    gatewayApply: await applyGatewaySecretAction({
      requestedAction: 'hot-reload',
      runCommand: (args, timeout) => runCliForRestoreTarget(params.targetResolution, args, timeout, 'config-write'),
    }),
    warnings: officialRepair.warnings,
  }
}

async function runCliForRestoreTarget(
  resolution: RestoreTargetResolution,
  args: string[],
  timeout = MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
  controlDomain: 'config-write' | 'gateway' | 'env-setup' = 'config-write'
) {
  const targetBinaryPath = String(resolution.candidate?.binaryPath || '').trim()
  const runtimeEnv = await readRuntimeEnvFile()
  const targetEnv = await readEnvFileIfExists(resolution.targetPaths.envFile)
  const envOverride = buildTargetCliEnvOverride(runtimeEnv, targetEnv)
  if (targetBinaryPath) {
    return runCliWithBinary(targetBinaryPath, args, timeout, controlDomain, envOverride)
  }
  return runCli(args, timeout, controlDomain)
}

async function writeRestoreConfigSnapshot(filePath: string, config: Record<string, any>): Promise<void> {
  const configMode = (await stat(filePath)).mode & 0o777
  await atomicWriteFile(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    description: 'OpenClaw 主配置',
    mode: configMode,
  })
}

async function repairRestoreTargetStalePluginConfigFromCommandResult(
  resolution: RestoreTargetResolution,
  result: {
    stdout?: string
    stderr?: string
  }
) {
  return repairStalePluginConfigFromCommandResult(result, {
    pruneStalePluginEntries: (pluginIds) =>
      pruneStalePluginConfigEntries(pluginIds, {
        readConfig: () => readJsonFileIfExists(resolution.targetPaths.configFile),
        writeConfig: (config) => writeRestoreConfigSnapshot(resolution.targetPaths.configFile, config),
      }),
  })
}

async function runDoctorForRestoreTarget(
  resolution: RestoreTargetResolution,
  options: { fix?: boolean; nonInteractive?: boolean } = {}
) {
  const nonInteractive = options.nonInteractive !== false
  const args = ['doctor']
  if (options.fix) args.push('--fix')
  if (nonInteractive) args.push('--non-interactive')

  const result = options.fix
    ? await runCliForRestoreTarget(
        resolution,
        args,
        MAIN_RUNTIME_POLICY.cli.doctorTimeoutMs,
        'env-setup'
      )
    : await rerunReadOnlyCommandAfterStalePluginRepair(
        () =>
          runCliForRestoreTarget(
            resolution,
            args,
            MAIN_RUNTIME_POLICY.cli.doctorTimeoutMs,
            'env-setup'
          ),
        {
          repairStalePluginConfigFromCommandResult: (commandResult) =>
            repairRestoreTargetStalePluginConfigFromCommandResult(resolution, commandResult),
        }
      )
  if (!options.fix || !isUnsupportedDoctorFixFlag(result)) {
    return result
  }

  return runCliForRestoreTarget(
    resolution,
    ['doctor', '--repair', ...(nonInteractive ? ['--non-interactive'] : [])],
    MAIN_RUNTIME_POLICY.cli.doctorTimeoutMs,
    'env-setup'
  )
}

interface OfficialRestoreRepairResult {
  ok: boolean
  applied: boolean
  rolledBack: boolean
  summary: string
  warnings: string[]
}

async function runOfficialDoctorRepairAfterRestore(params: {
  targetResolution: RestoreTargetResolution
  targetPaths: ReturnType<typeof resolveOpenClawPathsFromStateRoot>
}): Promise<OfficialRestoreRepairResult> {
  if (!(await pathExists(params.targetPaths.configFile))) {
    return {
      ok: true,
      applied: false,
      rolledBack: false,
      summary: '恢复目标缺少 openclaw.json，已跳过官方 doctor 迁移。',
      warnings: [],
    }
  }

  const preRepairConfig = cloneJsonValue(await readJsonFileIfExists(params.targetPaths.configFile))
  const diagnoseResult = await runDoctorForRestoreTarget(params.targetResolution).catch(
    (error) =>
      ({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error || ''),
        code: 1,
      })
  )

  if (!doctorSuggestsOfficialRepair(diagnoseResult)) {
    return {
      ok: true,
      applied: false,
      rolledBack: false,
      summary: '恢复后官方自检未发现需要迁移的配置，已跳过 doctor --fix。',
      warnings: [],
    }
  }

  const repairResult = await runDoctorForRestoreTarget(params.targetResolution, { fix: true }).catch(
    (error) =>
      ({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error || ''),
        code: 1,
      })
  )

  const rollbackSnapshot = async (): Promise<boolean> => {
    if (!preRepairConfig) return false
    try {
      await writeRestoreConfigSnapshot(params.targetPaths.configFile, preRepairConfig)
      return true
    } catch {
      return false
    }
  }

  if (!repairResult.ok) {
    const rolledBack = await rollbackSnapshot()
    return {
      ok: false,
      applied: true,
      rolledBack,
      summary: rolledBack
        ? '恢复后官方修复执行失败，已回滚到修复前配置快照。'
        : '恢复后官方修复执行失败，当前停留在可诊断状态。',
      warnings: [buildCliOutput(repairResult) || 'doctor --fix 执行失败。'],
    }
  }

  const postRepairConfig = await readJsonFileIfExists(params.targetPaths.configFile)
  if (preRepairConfig && !postRepairConfig) {
    const rolledBack = await rollbackSnapshot()
    return {
      ok: false,
      applied: true,
      rolledBack,
      summary: rolledBack
        ? '恢复后官方修复改坏了本地配置，已回滚到修复前快照。'
        : '恢复后官方修复后配置无法继续解析，当前停留在可诊断状态。',
      warnings: ['doctor --fix 执行后 openclaw.json 无法继续读取。'],
    }
  }

  const repairSummary = buildCliOutput(repairResult)
  return {
    ok: true,
    applied: true,
    rolledBack: false,
    summary: repairSummary
      ? `恢复后官方迁移执行完成。迁移摘要：${repairSummary.split('\n')[0]}`
      : '恢复后官方迁移执行完成。',
    warnings: [],
  }
}

async function reloadGatewayForRestoreTarget(
  resolution: RestoreTargetResolution
) {
  if (!resolution.candidate || resolution.candidate.isPathActive) {
    return reloadGatewayForConfigChange('restore-config', {
      preferEnsureWhenNotRunning: true,
    })
  }

  const healthResult = await runCliForRestoreTarget(
    resolution,
    ['health', '--json'],
    MAIN_RUNTIME_POLICY.cli.gatewayHealthTimeoutMs,
    'gateway'
  )
  if (!healthResult.ok) {
    return runCliForRestoreTarget(
      resolution,
      ['gateway', 'start'],
      MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
      'gateway'
    )
  }

  return runCliForRestoreTarget(
    resolution,
    ['gateway', 'restart'],
    MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
    'gateway'
  )
}

export async function previewOpenClawRestore(backupId: string): Promise<OpenClawRestorePreviewResult> {
  const backup = await getOpenClawBackupEntry(backupId)
  if (!backup) {
    return {
      ok: false,
      backup: null,
      availableScopes: [],
      restoreItems: [],
      warnings: [],
      blockedReasons: ['未找到指定备份。'],
    }
  }

  const availableScopes = resolveAvailableScopes(backup)
  const blockedReasons =
    availableScopes.length === 0 ? ['该备份不包含可恢复的配置或记忆数据。'] : []
  const warnings: string[] = []
  if (!backup.scopeAvailability.hasMemoryData) {
    warnings.push('该备份不包含完整 openclaw-home，因此不能恢复“仅记忆数据”或“配置 + 记忆数据”。')
  }

  return {
    ok: blockedReasons.length === 0,
    backup,
    availableScopes,
    restoreItems: buildRestoreItems(backup),
    warnings,
    blockedReasons,
  }
}

export async function runOpenClawRestore(
  backupId: string,
  scope: OpenClawRestoreScope
): Promise<OpenClawRestoreRunResult> {
  const preview = await previewOpenClawRestore(backupId)
  if (!preview.backup) {
    return {
      ok: false,
      backup: null,
      scope,
      preflightSnapshot: null,
      restoredItems: [],
      warnings: preview.warnings,
      message: '未找到指定备份。',
      errorCode: 'backup_not_found',
    }
  }

  if (!preview.availableScopes.includes(scope)) {
    return {
      ok: false,
      backup: preview.backup,
      scope,
      preflightSnapshot: null,
      restoredItems: [],
      warnings: preview.warnings,
      message: '当前备份不支持所选恢复范围。',
      errorCode: 'scope_unavailable',
    }
  }

  let preflightSnapshot = null
  const targetResolution = await resolveRestoreTarget(preview.backup)
  const beforeConfig = await readJsonFileIfExists(targetResolution.targetPaths.configFile)
  const beforeEnv = await readEnvFileIfExists(targetResolution.targetPaths.envFile)
  const beforeCredentialsPresent = await pathExists(targetResolution.targetPaths.credentialsDir)
  try {
    preflightSnapshot = await createRestorePreflightSnapshot(targetResolution)
  } catch (error) {
    return {
      ok: false,
      backup: preview.backup,
      scope,
      preflightSnapshot: null,
      restoredItems: [],
      warnings: preview.warnings,
      message: error instanceof Error ? error.message : String(error),
      errorCode: 'preflight_failed',
    }
  }

  try {
    let restoredItems: string[] = []
    let restoredCredentials = false
    let restoreWarnings: string[] = []
    if (scope === 'config') {
      const result = await restoreConfigScope(preview.backup, targetResolution.targetPaths)
      restoredItems = result.restoredItems
      restoredCredentials = result.restoredCredentials
      restoreWarnings = result.warnings
    } else if (scope === 'memory') {
      const result = await restoreMemoryScope(preview.backup, targetResolution.targetPaths, false)
      restoredItems = result.restoredItems
      restoreWarnings = result.warnings
    } else {
      const memoryResult = await restoreMemoryScope(preview.backup, targetResolution.targetPaths, true)
      const configResult = await restoreConfigScope(preview.backup, targetResolution.targetPaths)
      restoredItems = [...memoryResult.restoredItems, ...configResult.restoredItems]
      restoredCredentials = configResult.restoredCredentials
      restoreWarnings = [...memoryResult.warnings, ...configResult.warnings]
    }

    const runtimeApply = await applyRestoreRuntimeChanges({
      scope,
      targetResolution,
      targetPaths: targetResolution.targetPaths,
      beforeConfig,
      beforeEnv,
      beforeCredentialsPresent,
      forceRestart: restoredCredentials,
    })
    const gatewayApply = runtimeApply.gatewayApply
    const gatewayApplyFailed = !gatewayApply.ok

    return {
      ok: !gatewayApplyFailed,
      backup: preview.backup,
      scope,
      preflightSnapshot,
      restoredItems,
      warnings: [
        ...appendOptionalWarning(preview.warnings, targetResolution.warning),
        ...restoreWarnings,
        ...runtimeApply.warnings,
      ],
      gatewayApply,
      errorCode: gatewayApplyFailed ? 'runtime_apply_failed' : undefined,
      message: gatewayApplyFailed
        ? '恢复执行完成，但当前状态生效失败。请稍后手动重载网关。'
        : '恢复执行完成。',
    }
  } catch (error) {
    return {
      ok: false,
      backup: preview.backup,
      scope,
      preflightSnapshot,
      restoredItems: [],
      warnings: preview.warnings,
      message: error instanceof Error ? error.message : String(error),
      errorCode: 'restore_failed',
    }
  }
}
