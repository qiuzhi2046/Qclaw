import type { OpenClawDiscoveryResult, OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type { OpenClawUpgradeCheckResult, OpenClawUpgradeRunResult } from '../../src/shared/openclaw-phase4'
import type { OpenClawBackupEntry } from '../../src/shared/openclaw-phase3'
import { compareLooseVersions } from '../../src/shared/openclaw-phase1'
import {
  PINNED_OPENCLAW_VERSION,
  isStrictOpenClawPolicyVersion,
  resolveOpenClawVersionEnforcement,
  supportsPinnedOpenClawCorrection,
} from '../../src/shared/openclaw-version-policy'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import {
  activateManagedWindowsRuntimeSnapshotFromExistingRuntime,
  checkOpenClaw,
  discoverOpenClawForEnvCheck,
  gatewayHealth,
  gatewayStart,
  readConfig,
  runCli,
  runDirect,
  runDoctor,
  runShell,
  writeConfig,
} from './cli'
import {
  isOpenClawInstallPermissionFailureResult,
  probeOpenClawInstallPath,
  type OpenClawInstallPathProbe,
} from './openclaw-install-permissions'
import { discoverOpenClawInstallations } from './openclaw-install-discovery'
import { createManagedBackupArchive } from './openclaw-backup-index'
import { ensureWritableOpenClawBackupRootDirectory } from './openclaw-backup-roots'
import { buildMacNpmCommand } from './node-runtime'
import { resolveOpenClawPathsFromStateRoot } from './openclaw-paths'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { withManagedOperationLock } from './managed-operation-lock'
import {
  OPENCLAW_NPM_REGISTRY_MIRRORS,
  attachOpenClawMirrorFailureDetails,
  buildMirrorAwareTimeoutMs,
  buildOpenClawInstallArgs,
  type OpenClawNpmCommandOptions,
  runOpenClawNpmRegistryFallback,
} from './openclaw-download-fallbacks'
import {
  createPrivilegedOpenClawNpmCommandOptions,
  ensureManagedOpenClawNpmRuntime,
} from './openclaw-npm-runtime'
import {
  runMacOpenClawElevatedLifecycleTransaction,
  type OpenClawElevatedLifecycleTransactionResult,
} from './openclaw-elevated-lifecycle-transaction'
import { appendEnvCheckDiagnostic } from './env-check-diagnostics'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { access, cp, mkdir, rm } = fs.promises
const { homedir, userInfo } = os
const RUNTIME_INSTALL_LOCK_KEY = 'runtime-install'
const USER_MANAGED_INSTALL_SOURCES = new Set<OpenClawInstallCandidate['installSource']>([
  'nvm',
  'fnm',
  'asdf',
  'mise',
  'volta',
])

interface OfficialDoctorRepairResult {
  ok: boolean
  applied: boolean
  rolledBack: boolean
  summary: string
  warnings: string[]
}

function resolveActiveCandidate(candidates: OpenClawInstallCandidate[]): OpenClawInstallCandidate | null {
  return candidates.find((candidate) => candidate.isPathActive) || candidates[0] || null
}

function buildManualUpgradeHint(candidate: OpenClawInstallCandidate | null): string | undefined {
  if (!candidate) return undefined
  if (!isStrictOpenClawPolicyVersion(candidate.version)) {
    return '当前 OpenClaw 版本号无法可靠解析。为避免误改现有安装，请先确认 `openclaw --version` 输出正常，并手动切换到 2026.3.24 后再回到 Qclaw。'
  }
  if (candidate.installSource === 'homebrew' && !supportsPinnedOpenClawCorrection(candidate.installSource, candidate)) {
    return '当前 OpenClaw 由 Homebrew 管理，程序内无法安全回退到 2026.3.24。请先在 Homebrew 环境中手动切换到 2026.3.24；若当前 Homebrew 源无法提供该版本，请先移除 brew 安装后，再让 Qclaw 重新安装 2026.3.24。'
  }
  if (candidate.installSource === 'custom') {
    return '当前 OpenClaw 来自自定义路径，程序内无法安全改写。请在原安装位置或原包管理器中手动安装 2026.3.24，并确认 PATH 指向该版本后再回到 Qclaw。'
  }
  if (candidate.installSource === 'unknown') {
    return '当前 OpenClaw 安装来源无法识别。为避免误改系统环境，请先确认 which openclaw 对应的实际路径，并将 PATH 切换到 2026.3.24，或移除该版本后让 Qclaw 重新安装。'
  }
  return undefined
}

function isQclawOwnedUpgradeSource(
  source: OpenClawInstallCandidate['installSource'] | null | undefined
): boolean {
  return source === 'qclaw-bundled' || source === 'qclaw-managed'
}

async function activateManagedRuntimeAfterQclawOwnedUpgrade(
  candidate: OpenClawInstallCandidate
): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (!isQclawOwnedUpgradeSource(candidate.installSource)) return false
  const selectedRuntimeSnapshot = getSelectedWindowsActiveRuntimeSnapshot()
  const preservedExtensionsDir =
    selectedRuntimeSnapshot &&
    String(selectedRuntimeSnapshot.configPath || '').trim() === String(candidate.configPath || '').trim() &&
    String(selectedRuntimeSnapshot.stateDir || '').trim() === String(candidate.stateRoot || '').trim()
      ? selectedRuntimeSnapshot.extensionsDir
      : null

  const activatedRuntimeSnapshot =
    await activateManagedWindowsRuntimeSnapshotFromExistingRuntime({
      configPath: candidate.configPath,
      stateDir: candidate.stateRoot,
      extensionsDir: String(preservedExtensionsDir || '').trim() || path.join(candidate.stateRoot, 'extensions'),
    }).catch(() => null)

  return Boolean(activatedRuntimeSnapshot)
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function replacePathIfExists(sourcePath: string | null | undefined, targetPath: string): Promise<boolean> {
  const normalizedSource = String(sourcePath || '').trim()
  if (!normalizedSource || !(await pathExists(normalizedSource))) return false
  await rm(targetPath, { recursive: true, force: true })
  await mkdir(path.dirname(targetPath), { recursive: true })
  await cp(normalizedSource, targetPath, { recursive: true, force: true })
  return true
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)))
}

function cloneConfig(config: Record<string, any> | null): Record<string, any> | null {
  if (!config || typeof config !== 'object') return null
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function normalizePathSignature(value: string): string {
  return String(value || '').replace(/\\/g, '/').toLowerCase()
}

function quotePosixShellArg(arg: string): string {
  if (arg === '') return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function looksLikeNpmGlobalCandidate(candidate: OpenClawInstallCandidate): boolean {
  const corpus = [
    candidate.binaryPath,
    candidate.resolvedBinaryPath,
    candidate.packageRoot,
  ]
    .map((value) => normalizePathSignature(value))
    .join('\n')
  const hasHomebrewCellarSignature =
    corpus.includes('/cellar/openclaw') || corpus.includes('/caskroom/openclaw')
  if (hasHomebrewCellarSignature) return false
  return (
    corpus.includes('/node_modules/openclaw') ||
    corpus.includes('/.npm-global/') ||
    corpus.includes('/appdata/roaming/npm/')
  )
}

function isHomebrewMissingOpenClaw(result: { stdout?: string; stderr?: string }): boolean {
  const corpus = `${String(result.stderr || '')}\n${String(result.stdout || '')}`.toLowerCase()
  return (
    corpus.includes("cask 'openclaw' is not installed") ||
    corpus.includes("formula 'openclaw' is not installed") ||
    corpus.includes('no available formula with the name "openclaw"') ||
    corpus.includes("no available cask with the name 'openclaw'")
  )
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

async function restoreUpgradeRollbackSnapshot(params: {
  backup: OpenClawBackupEntry | null
  candidate: OpenClawInstallCandidate
}): Promise<{ rolledBack: boolean; warnings: string[] }> {
  const backup = params.backup
  if (!backup) return { rolledBack: false, warnings: [] }

  const targetPaths = resolveOpenClawPathsFromStateRoot({
    stateRoot: params.candidate.stateRoot,
    configFile: params.candidate.configPath,
  })
  const archiveHomeDir = path.join(backup.archivePath, 'openclaw-home')
  const warnings: string[] = []

  try {
    let restoredHome = false
    if (backup.scopeAvailability.hasMemoryData && (await pathExists(archiveHomeDir))) {
      await rm(targetPaths.homeDir, { recursive: true, force: true })
      await mkdir(path.dirname(targetPaths.homeDir), { recursive: true })
      await cp(archiveHomeDir, targetPaths.homeDir, { recursive: true, force: true })
      restoredHome = true
    }

    const restoredConfig = await replacePathIfExists(
      path.join(backup.archivePath, 'openclaw.json'),
      targetPaths.configFile
    )
    const restoredEnv = await replacePathIfExists(
      path.join(backup.archivePath, '.env'),
      targetPaths.envFile
    )
    const restoredCredentials = await replacePathIfExists(
      path.join(backup.archivePath, 'credentials'),
      targetPaths.credentialsDir
    )

    if (!restoredHome && !restoredConfig && !restoredEnv && !restoredCredentials) {
      warnings.push('升级回滚快照不包含可恢复的数据。')
      return { rolledBack: false, warnings }
    }

    return { rolledBack: true, warnings }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error))
    return { rolledBack: false, warnings }
  }
}

async function runOfficialDoctorRepairAfterUpgrade(params: {
  candidate: OpenClawInstallCandidate
  backupCreated: OpenClawBackupEntry | null
}): Promise<OfficialDoctorRepairResult> {
  const preRepairConfig = cloneConfig(await readConfig().catch(() => null))
  const diagnoseResult = await runDoctor().catch(
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
      summary: '升级后官方自检未发现需要迁移的配置，已跳过 doctor --fix。',
      warnings: [],
    }
  }

  const repairResult = await runDoctor({ fix: true }).catch(
    (error) =>
      ({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error || ''),
        code: 1,
      })
  )

  const rollbackSnapshot = async (): Promise<{ rolledBack: boolean; warnings: string[] }> => {
    if (params.backupCreated) {
      const archiveRollback = await restoreUpgradeRollbackSnapshot({
        backup: params.backupCreated,
        candidate: params.candidate,
      })
      if (archiveRollback.rolledBack || !preRepairConfig) {
        return archiveRollback
      }
    }
    if (!preRepairConfig) return { rolledBack: false, warnings: [] }
    try {
      await writeConfig(preRepairConfig)
      return { rolledBack: true, warnings: [] }
    } catch (error) {
      return {
        rolledBack: false,
        warnings: [error instanceof Error ? error.message : String(error)],
      }
    }
  }

  if (!repairResult.ok) {
    const rollbackResult = await rollbackSnapshot()
    return {
      ok: false,
      applied: true,
      rolledBack: rollbackResult.rolledBack,
      summary: rollbackResult.rolledBack
        ? '升级后官方修复执行失败，已回滚到修复前配置快照。'
        : '升级后官方修复执行失败，当前停留在可诊断状态。',
      warnings: [buildCliOutput(repairResult) || 'doctor --fix 执行失败。', ...rollbackResult.warnings],
    }
  }

  const postRepairConfig = await readConfig().catch(() => null)
  if (preRepairConfig && !postRepairConfig) {
    const rollbackResult = await rollbackSnapshot()
    return {
      ok: false,
      applied: true,
      rolledBack: rollbackResult.rolledBack,
      summary: rollbackResult.rolledBack
        ? '升级后官方修复改坏了本地配置，已回滚到修复前快照。'
        : '升级后官方修复后配置无法继续解析，已停留在可诊断状态。',
      warnings: ['doctor --fix 执行后 openclaw.json 无法继续读取。', ...rollbackResult.warnings],
    }
  }

  const summaryParts = ['升级后官方迁移执行完成。']
  const repairDetails = buildCliOutput(repairResult)
  if (repairDetails) {
    summaryParts.push(`迁移摘要：${repairDetails.split('\n')[0]}`)
  }

  return {
    ok: true,
    applied: true,
    rolledBack: false,
    summary: summaryParts.join(' '),
    warnings: [],
  }
}

async function resolveNpmCommandForCandidate(candidate: OpenClawInstallCandidate): Promise<string> {
  const suffix = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const directories = dedupe([
    path.dirname(candidate.binaryPath),
    path.dirname(candidate.resolvedBinaryPath),
  ])

  for (const directory of directories) {
    const candidatePath = path.join(directory, suffix)
    if (await pathExists(candidatePath)) {
      return candidatePath
    }
  }

  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function requiresAdminElevation(candidate: OpenClawInstallCandidate): boolean {
  if (process.platform !== 'darwin') return false
  if (candidate.installSource !== 'npm-global') return false
  const userHome = homedir()
  const normalized = [candidate.binaryPath, candidate.resolvedBinaryPath, candidate.packageRoot]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return normalized.every((value) => !value.startsWith(`${userHome}/`) && value !== userHome)
}

function isPathInsideHome(value: string): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  const userHome = homedir()
  return normalized === userHome || normalized.startsWith(`${userHome}/`)
}

function isUserManagedInstall(candidate: OpenClawInstallCandidate): boolean {
  if (USER_MANAGED_INSTALL_SOURCES.has(candidate.installSource)) return true
  if (candidate.installSource !== 'npm-global') return false
  return [candidate.binaryPath, candidate.resolvedBinaryPath, candidate.packageRoot]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .every((value) => isPathInsideHome(value))
}

function dedupeNonEmptyPaths(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

function collectOwnershipRepairDirectories(candidate: OpenClawInstallCandidate): string[] {
  const packageRoot = String(candidate.packageRoot || '').trim()
  const binaryPath = String(candidate.binaryPath || '').trim()
  return dedupeNonEmptyPaths([
    packageRoot,
    packageRoot ? path.dirname(packageRoot) : '',
    binaryPath ? path.dirname(binaryPath) : '',
  ]).filter((value) => isPathInsideHome(value))
}

async function collectOwnershipRepairProbes(
  candidate: OpenClawInstallCandidate
): Promise<OpenClawInstallPathProbe[]> {
  return Promise.all(
    dedupeNonEmptyPaths([
      ...collectOwnershipRepairDirectories(candidate),
      candidate.binaryPath,
    ]).map((pathname) =>
      probeOpenClawInstallPath(pathname)
    )
  )
}

function shouldRepairUserManagedOwnership(
  candidate: OpenClawInstallCandidate,
  probes: OpenClawInstallPathProbe[]
): boolean {
  if (!isUserManagedInstall(candidate)) return false
  return probes.some((probe) => probe.ownerMatchesCurrentUser === false || !probe.writable)
}

function buildMacUpgradeFallbackCommand(
  targetVersion: string,
  options: {
    npmCommandOptions?: OpenClawNpmCommandOptions
    detectedBinDir?: string | null
    npmCacheDir?: string
    fixCacheOwnership?: boolean
    workingDirectory?: string | null
    user?: string
  } = {}
): string {
  const npmCommandOptions = options.npmCommandOptions || {}
  const commands = OPENCLAW_NPM_REGISTRY_MIRRORS.map((mirror) =>
    buildMacNpmCommand(buildOpenClawInstallArgs(targetVersion, mirror.registryUrl, npmCommandOptions), {
      detectedBinDir: options.detectedBinDir,
      npmCacheDir: options.npmCacheDir,
      fixCacheOwnership: options.fixCacheOwnership,
      workingDirectory: options.workingDirectory,
      user: options.user,
    })
  )
  return commands.map((command) => `(${command})`).join(' || ')
}

function buildMacUserManagedOwnershipRepairAndUpgradeCommand(
  candidate: OpenClawInstallCandidate,
  targetVersion: string,
  options: {
    npmCommandOptions: OpenClawNpmCommandOptions
    detectedBinDir?: string | null
    npmCacheDir?: string
    workingDirectory?: string | null
  }
): string {
  const currentUser = userInfo()
  const ownershipTargets = collectOwnershipRepairDirectories(candidate)
    .map((value) => quotePosixShellArg(value))
    .join(' ')
  const repairCommands: string[] = []

  if (ownershipTargets) {
    repairCommands.push(`chown -R ${currentUser.uid}:${currentUser.gid} ${ownershipTargets}`)
  }

  const binaryPath = String(candidate.binaryPath || '').trim()
  if (binaryPath && isPathInsideHome(binaryPath)) {
    repairCommands.push(
      `if [ -e ${quotePosixShellArg(binaryPath)} ] || [ -L ${quotePosixShellArg(binaryPath)} ]; then chown -h ${currentUser.uid}:${currentUser.gid} ${quotePosixShellArg(binaryPath)} >/dev/null 2>&1 || true; fi`
    )
  }

  const upgradeCommand = buildMacUpgradeFallbackCommand(targetVersion, {
    npmCommandOptions: options.npmCommandOptions,
    detectedBinDir: options.detectedBinDir,
    user: String(currentUser.username || ''),
    npmCacheDir: options.npmCacheDir,
    fixCacheOwnership: false,
    workingDirectory: options.workingDirectory,
  })

  if (repairCommands.length === 0) return `(${upgradeCommand})`

  return `(${repairCommands.join(' && ')}) && (${upgradeCommand})`
}

async function runNpmUpgradeWithMirrorFallback(
  npmCommand: string,
  targetVersion: string,
  npmCommandOptions: OpenClawNpmCommandOptions
) {
  const { result, attempts } = await runOpenClawNpmRegistryFallback((mirror) =>
    runShell(
      npmCommand,
      buildOpenClawInstallArgs(targetVersion, mirror.registryUrl, npmCommandOptions),
      MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs,
      'upgrade'
    )
  )
  return attachOpenClawMirrorFailureDetails(result, attempts, {
    operationLabel: 'OpenClaw 升级',
    version: targetVersion,
  })
}

function attachOwnershipRepairHint(result: Awaited<ReturnType<typeof runShell>>): typeof result {
  if (result.ok) return result
  if (!isOpenClawInstallPermissionFailureResult(result)) return result
  const message =
    '检测到当前 OpenClaw 安装目录存在权限/所有权问题，Qclaw 已尝试通过管理员权限修复后重试升级。'
  return {
    ...result,
    stderr: `${message}\n\n${String(result.stderr || '').trim()}`.trim(),
  }
}

function buildUnknownMirrorAttempts() {
  return OPENCLAW_NPM_REGISTRY_MIRRORS.map((mirror) => ({
    mirror,
    result: {
      ok: false,
      stdout: '',
      stderr: '当前执行路径未返回分镜像明细，请按下方命令手动重试。',
      code: null,
    },
  }))
}

function maybeAttachUpgradeMirrorDetails(
  result: OpenClawElevatedLifecycleTransactionResult,
  targetVersion: string
): OpenClawElevatedLifecycleTransactionResult {
  if (result.ok || result.lifecycle.ok || result.status === 'snapshot_failed') {
    return result
  }

  return attachOpenClawMirrorFailureDetails(result, buildUnknownMirrorAttempts(), {
    operationLabel: 'OpenClaw 升级',
    version: targetVersion,
  }) as OpenClawElevatedLifecycleTransactionResult
}

function mapUpgradeFailureErrorCode(result: unknown): OpenClawUpgradeRunResult['errorCode'] {
  const status =
    result && typeof result === 'object' && 'status' in result
      ? String((result as { status?: string | null }).status || '').trim()
      : ''
  switch (status) {
    case 'snapshot_failed':
    case 'lifecycle_failed_environment_repaired':
    case 'post_repair_failed_after_lifecycle':
    case 'post_repair_verification_failed':
      return status
    default:
      return 'upgrade_failed'
  }
}

async function runUserManagedOwnershipRepairUpgrade(
  candidate: OpenClawInstallCandidate,
  targetVersion: string,
  npmCommand: string,
  npmCommandOptions: OpenClawNpmCommandOptions
) {
  if (process.platform !== 'darwin') {
    const ownershipTargets = collectOwnershipRepairDirectories(candidate)
    const recoveryCommands = [
      ownershipTargets.length > 0
        ? `sudo chown -R "$(id -u)":"$(id -g)" ${ownershipTargets.map((value) => quotePosixShellArg(value)).join(' ')}`
        : null,
      isPathInsideHome(candidate.binaryPath)
        ? `sudo chown -h "$(id -u)":"$(id -g)" ${quotePosixShellArg(candidate.binaryPath)}`
        : null,
      `npm install -g openclaw@${targetVersion}`,
    ].filter(Boolean)

    return {
      ok: false,
      stdout: '',
      stderr: [
        '检测到当前 OpenClaw 安装目录存在权限/所有权问题。',
        '当前平台暂不支持在 Qclaw 内自动提权修复，请先在终端执行：',
        ...recoveryCommands.map((command) => `- ${command}`),
      ].join('\n'),
      code: 1,
    }
  }

  const detectedBinDir = path.dirname(npmCommand)
  const safeWorkingDirectory = resolveSafeWorkingDirectory()
  const command = buildMacUserManagedOwnershipRepairAndUpgradeCommand(candidate, targetVersion, {
    npmCommandOptions,
    detectedBinDir,
    npmCacheDir: path.join(homedir(), '.npm'),
    workingDirectory: safeWorkingDirectory,
  })

  const result = await runMacOpenClawElevatedLifecycleTransaction({
    operation: 'upgrade',
    lifecycleCommand: command,
    prompt:
      'Qclaw 检测到当前 OpenClaw 安装目录存在权限/所有权问题，无法直接升级。\n\nQclaw 将先修复该目录的权限/所有权设置，再继续升级到目标版本。\n\n请输入你的 Mac 登录密码以继续。',
    timeoutMs: buildMirrorAwareTimeoutMs(MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs),
    controlDomain: 'upgrade',
    binaryPath: candidate.resolvedBinaryPath || candidate.binaryPath,
    preferredStateRootPath: candidate.stateRoot,
    qclawSafeWorkDir: safeWorkingDirectory,
    includeManagedInstallerRoot: true,
    runDirect,
  })

  if (result.ok) return result

  return maybeAttachUpgradeMirrorDetails(
    attachOwnershipRepairHint(result) as OpenClawElevatedLifecycleTransactionResult,
    targetVersion
  )
}

async function runSourceAwareUpgrade(
  candidate: OpenClawInstallCandidate,
  targetVersion: string
) {
  const resolveManagedNpmCommandOptions = async (): Promise<OpenClawNpmCommandOptions | null> => {
    try {
      const runtime = await ensureManagedOpenClawNpmRuntime({
        workingDirectory: resolveSafeWorkingDirectory(),
      })
      return runtime.commandOptions
    } catch {
      return null
    }
  }

  if (candidate.installSource === 'homebrew') {
    if (!looksLikeNpmGlobalCandidate(candidate)) {
      return {
        ok: false,
        stdout: '',
        stderr: buildManualUpgradeHint(candidate) || '当前 Homebrew 安装暂不支持程序内自动修复。',
        code: 1,
      }
    }

    const npmCommand = await resolveNpmCommandForCandidate(candidate)
    const npmCommandOptions = await resolveManagedNpmCommandOptions()
    if (!npmCommandOptions) {
      return {
        ok: false,
        stdout: '',
        stderr: 'OpenClaw 升级失败：无法初始化安装隔离环境。',
        code: -1,
      }
    }
    return runNpmUpgradeWithMirrorFallback(npmCommand, targetVersion, npmCommandOptions)
  }

  const npmCommand = await resolveNpmCommandForCandidate(candidate)
  const npmCommandOptions = await resolveManagedNpmCommandOptions()
  if (!npmCommandOptions) {
    return {
      ok: false,
      stdout: '',
      stderr: 'OpenClaw 升级失败：无法初始化安装隔离环境。',
      code: -1,
    }
  }

  const ownershipRepairProbes = await collectOwnershipRepairProbes(candidate)
  if (shouldRepairUserManagedOwnership(candidate, ownershipRepairProbes)) {
    return runUserManagedOwnershipRepairUpgrade(candidate, targetVersion, npmCommand, npmCommandOptions)
  }

  if (requiresAdminElevation(candidate)) {
    const detectedBinDir = path.dirname(npmCommand)
    const privilegedNpmCommandOptions = createPrivilegedOpenClawNpmCommandOptions(npmCommandOptions)
    const safeWorkingDirectory = resolveSafeWorkingDirectory()
    const command = buildMacUpgradeFallbackCommand(targetVersion, {
      npmCommandOptions: privilegedNpmCommandOptions,
      detectedBinDir,
      user: userInfo().username,
      npmCacheDir: path.join(homedir(), '.npm'),
      fixCacheOwnership: false,
      workingDirectory: safeWorkingDirectory,
    })

    const result = await runMacOpenClawElevatedLifecycleTransaction({
      operation: 'upgrade',
      lifecycleCommand: command,
      prompt:
        'Qclaw 需要将当前 OpenClaw 升级到最新版本。\n\n升级不会迁移配置位置或数据位置。\n\n请输入你的 Mac 登录密码以继续。',
      timeoutMs: buildMirrorAwareTimeoutMs(MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs),
      controlDomain: 'upgrade',
      binaryPath: candidate.resolvedBinaryPath || candidate.binaryPath,
      preferredStateRootPath: candidate.stateRoot,
      qclawSafeWorkDir: safeWorkingDirectory,
      includeManagedInstallerRoot: true,
      runDirect,
    })

    return maybeAttachUpgradeMirrorDetails(result, targetVersion)
  }

  const upgradeResult = await runNpmUpgradeWithMirrorFallback(npmCommand, targetVersion, npmCommandOptions)
  if (
    !upgradeResult.ok &&
    isOpenClawInstallPermissionFailureResult(upgradeResult) &&
    isUserManagedInstall(candidate)
  ) {
    return runUserManagedOwnershipRepairUpgrade(candidate, targetVersion, npmCommand, npmCommandOptions)
  }

  return upgradeResult
}

async function resolveUpgradeDiscovery(): Promise<OpenClawDiscoveryResult> {
  if (process.platform === 'win32') {
    return await discoverOpenClawForEnvCheck().catch(() => ({
      status: 'absent',
      candidates: [],
      activeCandidateId: null,
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: '',
    }))
  }

  return discoverOpenClawInstallations()
}

export async function checkOpenClawUpgrade(): Promise<OpenClawUpgradeCheckResult> {
  const discovery = await resolveUpgradeDiscovery()
  return checkOpenClawUpgradeFromDiscovery(discovery)
}

export async function checkOpenClawUpgradeForEnvCheck(
  discovery: OpenClawDiscoveryResult | null | undefined
): Promise<OpenClawUpgradeCheckResult> {
  await appendEnvCheckDiagnostic('main-openclaw-upgrade-check-env-start', {
    status: discovery?.status ?? null,
    activeCandidateId: discovery?.activeCandidateId ?? null,
    candidateCount: Array.isArray(discovery?.candidates) ? discovery.candidates.length : 0,
  })
  return checkOpenClawUpgradeFromDiscovery(
    discovery || {
      status: 'absent',
      candidates: [],
      activeCandidateId: null,
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: '',
    }
  )
}

async function checkOpenClawUpgradeFromDiscovery(
  discovery: OpenClawDiscoveryResult
): Promise<OpenClawUpgradeCheckResult> {
  const activeCandidate = resolveActiveCandidate(discovery.candidates)
  await appendEnvCheckDiagnostic('main-openclaw-upgrade-check-discovery-resolved', {
    status: discovery.status,
    activeCandidateId: activeCandidate?.candidateId ?? null,
    candidateCount: discovery.candidates.length,
  })
  await appendEnvCheckDiagnostic('main-openclaw-upgrade-check-before-gateway-health', {
    hasActiveCandidate: Boolean(activeCandidate),
    candidateId: activeCandidate?.candidateId ?? null,
  })
  const health = activeCandidate ? await gatewayHealth().catch(() => ({ running: false, raw: '' })) : { running: false, raw: '' }
  await appendEnvCheckDiagnostic('main-openclaw-upgrade-check-after-gateway-health', {
    running: Boolean(health.running),
  })
  const warnings = [...(discovery.warnings || [])]

  if (!activeCandidate) {
    const result: OpenClawUpgradeCheckResult = {
      ok: false,
      activeCandidate: null,
      currentVersion: null,
      targetVersion: PINNED_OPENCLAW_VERSION,
      latestCheck: null,
      policyState: null,
      enforcement: null,
      targetAction: 'install',
      blocksContinue: true,
      canSelfHeal: true,
      canAutoUpgrade: false,
      upToDate: false,
      gatewayRunning: false,
      warnings,
      errorCode: 'not_installed',
    }
    await appendEnvCheckDiagnostic('main-openclaw-upgrade-check-result', {
      ok: result.ok,
      currentVersion: result.currentVersion ?? null,
      targetVersion: result.targetVersion ?? null,
      blocksContinue: result.blocksContinue,
      gatewayRunning: result.gatewayRunning,
    })
    return result
  }

  const policy = resolveOpenClawVersionEnforcement({
    version: activeCandidate.version,
    installSource: activeCandidate.installSource,
    candidatePaths: activeCandidate,
    platform: process.platform,
  })
  const canAutoUpgrade =
    policy.enforcement === 'optional_upgrade' || policy.enforcement === 'auto_correct'
  const manualHint = policy.enforcement === 'manual_block' ? buildManualUpgradeHint(activeCandidate) : undefined

  if (manualHint) {
    warnings.push(manualHint)
  }

  const result: OpenClawUpgradeCheckResult = {
    ok: !policy.blocksContinue,
    activeCandidate,
    currentVersion: activeCandidate.version || null,
    targetVersion: policy.targetVersion,
    latestCheck: null,
    policyState: policy.policyState,
    enforcement: policy.enforcement,
    targetAction: policy.targetAction,
    blocksContinue: policy.blocksContinue,
    canSelfHeal: policy.canSelfHeal,
    canAutoUpgrade,
    upToDate: policy.policyState === 'supported_target',
    gatewayRunning: Boolean(health.running),
    warnings,
    manualHint,
    errorCode: policy.enforcement === 'manual_block' && policy.blocksContinue ? 'manual_only' : undefined,
  }
  await appendEnvCheckDiagnostic('main-openclaw-upgrade-check-result', {
    ok: result.ok,
    currentVersion: result.currentVersion ?? null,
    targetVersion: result.targetVersion ?? null,
    blocksContinue: result.blocksContinue,
    gatewayRunning: result.gatewayRunning,
  })
  return result
}

export async function runOpenClawUpgrade(): Promise<OpenClawUpgradeRunResult> {
  return withManagedOperationLock(RUNTIME_INSTALL_LOCK_KEY, async () => {
    const discovery = await resolveUpgradeDiscovery()
    const check =
      process.platform === 'win32'
        ? await checkOpenClawUpgradeForEnvCheck(discovery)
        : await checkOpenClawUpgradeFromDiscovery(discovery)
    if (!check.activeCandidate) {
      return {
        ok: false,
        blocked: true,
        currentVersion: null,
        targetVersion: check.targetVersion,
        installSource: null,
        backupCreated: null,
        gatewayWasRunning: false,
        gatewayRestored: false,
        warnings: check.warnings,
        message: '当前没有可升级的 OpenClaw 安装对象。',
        errorCode: 'not_installed',
      }
    }

    const canRunCorrection =
      (check.enforcement === 'optional_upgrade' || check.enforcement === 'auto_correct') &&
      Boolean(check.targetVersion)
    if (!canRunCorrection || !check.targetVersion) {
      return {
        ok: false,
        blocked: true,
        currentVersion: check.currentVersion,
        targetVersion: check.targetVersion,
        installSource: check.activeCandidate.installSource,
        backupCreated: null,
        gatewayWasRunning: check.gatewayRunning,
        gatewayRestored: false,
        warnings: check.warnings,
        message: check.manualHint || '当前安装来源暂不支持自动升级。',
        errorCode: check.errorCode || 'manual_only',
      }
    }

    let backupCreated = null
    const backupWarnings: string[] = []
    try {
      const backupRootResolution = await ensureWritableOpenClawBackupRootDirectory()
      backupWarnings.push(...backupRootResolution.warnings)
      backupCreated = await createManagedBackupArchive({
        candidate: check.activeCandidate,
        backupType: 'upgrade-preflight',
        copyMode: check.enforcement === 'auto_correct' ? 'full-state' : 'config-only',
        rootResolution: backupRootResolution,
      })
    } catch (error) {
      return {
        ok: false,
        blocked: true,
        currentVersion: check.currentVersion,
        targetVersion: check.targetVersion,
        installSource: check.activeCandidate.installSource,
        backupCreated: null,
        gatewayWasRunning: check.gatewayRunning,
        gatewayRestored: false,
        warnings: [...check.warnings, ...backupWarnings],
        message: error instanceof Error ? error.message : String(error),
        errorCode: 'snapshot_failed',
      }
    }

    const gatewayWasRunning = check.gatewayRunning
    if (gatewayWasRunning) {
      await runCli(['gateway', 'stop'], MAIN_RUNTIME_POLICY.cli.gatewayStopTimeoutMs, 'upgrade').catch(() => ({
        ok: false,
      }))
    }

    const upgradeResult = await runSourceAwareUpgrade(check.activeCandidate, check.targetVersion)
    if (!upgradeResult.ok) {
      const restoredResult = gatewayWasRunning ? await gatewayStart().catch(() => ({ ok: false })) : { ok: false }
      return {
        ok: false,
        blocked: false,
        currentVersion: check.currentVersion,
        targetVersion: check.targetVersion,
        installSource: check.activeCandidate.installSource,
        backupCreated,
        gatewayWasRunning,
        gatewayRestored: Boolean(restoredResult.ok),
        warnings: [...check.warnings, ...backupWarnings],
        message: upgradeResult.stderr || upgradeResult.stdout || 'OpenClaw 升级失败。',
        errorCode: mapUpgradeFailureErrorCode(upgradeResult),
      }
    }

    const activatedManagedRuntime = await activateManagedRuntimeAfterQclawOwnedUpgrade(check.activeCandidate)
    const activationWarnings =
      process.platform === 'win32' && isQclawOwnedUpgradeSource(check.activeCandidate.installSource) && !activatedManagedRuntime
        ? ['OpenClaw 已写入 Qclaw 托管运行时，但当前会话未能自动切换到新的托管运行时。']
        : []
    const versionCheck = await checkOpenClaw()
    const upgradedVersion = versionCheck.installed ? versionCheck.version : ''
    const upgradeSucceeded =
      versionCheck.installed && compareLooseVersions(upgradedVersion, check.targetVersion) === 0
    const officialRepairResult = upgradeSucceeded
      ? await runOfficialDoctorRepairAfterUpgrade({
          candidate: check.activeCandidate,
          backupCreated,
        })
      : {
          ok: true,
          applied: false,
          rolledBack: false,
          summary: '',
          warnings: [],
        }
    const gatewayRestoreResult = gatewayWasRunning ? await gatewayStart().catch(() => ({ ok: false })) : { ok: false }

    if (!officialRepairResult.ok) {
      return {
        ok: false,
        blocked: false,
        currentVersion: upgradedVersion || check.currentVersion,
        targetVersion: check.targetVersion,
        installSource: check.activeCandidate.installSource,
        backupCreated,
        gatewayWasRunning,
        gatewayRestored: Boolean(gatewayWasRunning ? gatewayRestoreResult.ok : true),
        warnings: [...check.warnings, ...backupWarnings, ...activationWarnings, ...officialRepairResult.warnings],
        message: `OpenClaw 已升级到 ${upgradedVersion || check.targetVersion}，但${officialRepairResult.summary}`,
        errorCode: 'upgrade_failed',
      }
    }

    return {
      ok: upgradeSucceeded,
      blocked: false,
      currentVersion: upgradedVersion || check.currentVersion,
      targetVersion: check.targetVersion,
      installSource: check.activeCandidate.installSource,
      backupCreated,
      gatewayWasRunning,
      gatewayRestored: Boolean(gatewayWasRunning ? gatewayRestoreResult.ok : true),
      warnings: [...check.warnings, ...backupWarnings, ...activationWarnings, ...officialRepairResult.warnings],
      message: upgradeSucceeded
        ? `OpenClaw 已升级到 ${upgradedVersion || check.targetVersion}。 ${officialRepairResult.summary}`.trim()
        : '升级命令已执行，但未能确认目标版本是否生效。',
      errorCode: upgradeSucceeded ? undefined : 'upgrade_failed',
    }
  })
}
