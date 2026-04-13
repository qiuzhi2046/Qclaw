import {
  formatDisplayPathWithHome,
  type OpenClawInstallPathProbe,
} from './openclaw-install-permissions'
import type { OpenClawPaths } from './openclaw-paths'

const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { homedir } = os
const { join, relative } = path

export const QCLAW_PERMISSION_REPAIR_MARKER = 'QCLAW_PERMISSION_REPAIR'

const POSIX_QUOTED_PATH_REGEX = /['"]((?:~|\/)[^'"]+)['"]/g
const WINDOWS_QUOTED_PATH_REGEX = /['"]([A-Za-z]:[\\/][^'"]+)['"]/g
const POSIX_BARE_PATH_REGEX = /(^|[\s=:])((?:~|\/)[^\s'",;]+)/g
const WINDOWS_BARE_PATH_REGEX = /(^|[\s=:])([A-Za-z]:[\\/][^\s'",;]+)/g
const PERMISSION_FAILURE_REGEX =
  /\b(eacces|eperm|permission denied|operation not permitted|config file is not readable by the current process|failed to read config at|read failed: error: eacces|watcher error: error: eacces)\b/i

type PermissionRepairOperation =
  | 'openclaw-cli'
  | 'shell'
  | 'direct'
  | 'read-config'
  | 'write-config'
  | 'read-env'
  | 'write-env'

interface PermissionCommandLikeResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  canceled?: boolean
}

interface PermissionCurrentUser {
  uid: number
  gid: number
  username: string
}

export interface PermissionAutoRepairContext {
  operation: PermissionRepairOperation
  controlDomain?: string
  command?: string
  args?: string[]
  targetPath?: string
}

interface PermissionPrivilegedRepairResult {
  ok: boolean
  stdout?: string
  stderr?: string
  code?: number | null
}

export interface PermissionAutoRepairDependencies {
  platform?: NodeJS.Platform
  homeDir?: string
  userDataDir?: string
  safeWorkDir?: string
  pluginNpmCacheDir?: string
  currentUser?: PermissionCurrentUser
  getOpenClawPaths: () => Promise<OpenClawPaths>
  probePath: (pathname: string) => Promise<OpenClawInstallPathProbe>
  runPrivilegedRepair: (request: {
    command: string
    prompt: string
    controlDomain: string
  }) => Promise<PermissionPrivilegedRepairResult>
}

interface ResolvedPermissionAutoRepairDependencies extends PermissionAutoRepairDependencies {
  platform: NodeJS.Platform
  homeDir: string
  userDataDir: string
  safeWorkDir: string
  pluginNpmCacheDir: string
  currentUser: PermissionCurrentUser
}

interface PermissionRepairAttemptResult {
  attempted: boolean
  repaired: boolean
  message?: string
}

function normalizePathValue(value: string | null | undefined): string {
  return String(value || '').trim()
}

function quotePosixShellArg(value: string): string {
  if (!value) return "''"
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function normalizeDependencies(
  dependencies: PermissionAutoRepairDependencies
): ResolvedPermissionAutoRepairDependencies {
  const resolvedHomeDir = normalizePathValue(dependencies.homeDir || homedir())
  return {
    ...dependencies,
    platform: dependencies.platform || process.platform,
    homeDir: resolvedHomeDir,
    userDataDir: normalizePathValue(dependencies.userDataDir || process.env.QCLAW_USER_DATA_DIR || ''),
    safeWorkDir: normalizePathValue(dependencies.safeWorkDir || process.env.QCLAW_SAFE_WORK_DIR || ''),
    pluginNpmCacheDir: normalizePathValue(dependencies.pluginNpmCacheDir || join('/tmp', 'qclaw-lite', 'npm-cache')),
    currentUser:
      dependencies.currentUser || {
        uid: typeof process.getuid === 'function' ? process.getuid() : 0,
        gid: typeof process.getgid === 'function' ? process.getgid() : 0,
        username: process.env.USER || process.env.USERNAME || 'root',
      },
  }
}

function isPathWithinDirectory(baseDir: string, candidatePath: string): boolean {
  const normalizedBase = normalizePathValue(baseDir)
  const normalizedCandidate = normalizePathValue(candidatePath)
  if (!normalizedBase || !normalizedCandidate) return false

  const relativePath = relative(normalizedBase, normalizedCandidate)
  if (!relativePath) return true
  return !relativePath.startsWith('..')
}

function looksLikePermissionFailure(detail: string): boolean {
  return PERMISSION_FAILURE_REGEX.test(String(detail || '').trim())
}

function extractQuotedPaths(detail: string): string[] {
  const text = String(detail || '')
  const matches: string[] = []

  for (const regex of [
    POSIX_QUOTED_PATH_REGEX,
    WINDOWS_QUOTED_PATH_REGEX,
    POSIX_BARE_PATH_REGEX,
    WINDOWS_BARE_PATH_REGEX,
  ]) {
    regex.lastIndex = 0
    let matched: RegExpExecArray | null = null
    while ((matched = regex.exec(text)) !== null) {
      const candidate = normalizePathValue(matched[2] || matched[1])
      if (!candidate) continue
      matches.push(candidate)
    }
  }

  return matches
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const pathname of paths) {
    const normalized = normalizePathValue(pathname)
    if (!normalized) continue
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(normalized)
  }
  return unique
}

function buildFallbackCandidatePaths(
  context: PermissionAutoRepairContext,
  openClawPaths: OpenClawPaths,
  dependencies: ResolvedPermissionAutoRepairDependencies
): string[] {
  const npmHome = join(dependencies.homeDir, '.npm')
  const pluginRoot = join(openClawPaths.homeDir, 'extensions')
  const commonOpenClawPaths = [
    openClawPaths.configFile,
    openClawPaths.envFile,
    openClawPaths.credentialsDir,
    openClawPaths.homeDir,
  ]

  switch (context.operation) {
    case 'read-config':
    case 'write-config':
      return [openClawPaths.configFile, openClawPaths.homeDir]
    case 'read-env':
    case 'write-env':
      return [openClawPaths.envFile, openClawPaths.homeDir]
    case 'shell':
      return [npmHome, dependencies.pluginNpmCacheDir, dependencies.userDataDir, dependencies.safeWorkDir]
    case 'direct':
      if (context.controlDomain === 'plugin-install') {
        return [...commonOpenClawPaths, pluginRoot, npmHome, dependencies.pluginNpmCacheDir]
      }
      if (
        context.controlDomain === 'oauth' ||
        context.controlDomain === 'config-write' ||
        context.controlDomain === 'models' ||
        context.controlDomain === 'chat'
      ) {
        return [...commonOpenClawPaths, dependencies.userDataDir, dependencies.safeWorkDir]
      }
      return []
    case 'openclaw-cli':
    default: {
      if (context.controlDomain === 'plugin-install') {
        return [...commonOpenClawPaths, pluginRoot, npmHome, dependencies.pluginNpmCacheDir]
      }
      return [...commonOpenClawPaths, dependencies.userDataDir, dependencies.safeWorkDir]
    }
  }
}

function resolveRepairRootForPath(
  pathname: string,
  openClawPaths: OpenClawPaths,
  dependencies: ResolvedPermissionAutoRepairDependencies
): string {
  const normalizedPath = normalizePathValue(pathname)
  if (!normalizedPath) return ''

  const npmHome = join(dependencies.homeDir, '.npm')
  if (isPathWithinDirectory(openClawPaths.homeDir, normalizedPath)) return openClawPaths.homeDir
  if (isPathWithinDirectory(npmHome, normalizedPath)) return npmHome
  if (dependencies.userDataDir && isPathWithinDirectory(dependencies.userDataDir, normalizedPath)) {
    return dependencies.userDataDir
  }
  if (dependencies.safeWorkDir && isPathWithinDirectory(dependencies.safeWorkDir, normalizedPath)) {
    return dependencies.safeWorkDir
  }
  if (
    dependencies.pluginNpmCacheDir
    && isPathWithinDirectory(dependencies.pluginNpmCacheDir, normalizedPath)
  ) {
    return dependencies.pluginNpmCacheDir
  }

  return ''
}

function buildBlockedProbeDescription(probe: OpenClawInstallPathProbe): string {
  const parts: string[] = []
  if (!probe.writable) {
    parts.push(`当前用户不可写（检查路径：${formatDisplayPathWithHome(probe.checkPath)}）`)
  }
  if (probe.ownerMatchesCurrentUser === false) {
    parts.push(`owner uid=${probe.ownerUid ?? 'unknown'}`)
  }
  if (!probe.exists) {
    parts.push('路径不存在')
  }
  return `- ${probe.displayPath}: ${parts.join('；') || '写入条件不满足'}`
}

function buildDarwinRepairCommand(
  repairRoots: string[],
  currentUser: PermissionCurrentUser
): string {
  const ownership = `${quotePosixShellArg(String(currentUser.uid))}:${quotePosixShellArg(String(currentUser.gid))}`
  const commands = repairRoots.map((repairRoot) => {
    const quotedRoot = quotePosixShellArg(repairRoot)
    return [
      `if [ -e ${quotedRoot} ] || [ -L ${quotedRoot} ]; then`,
      `  chown -R ${ownership} ${quotedRoot} >/dev/null 2>&1 || qclaw_repair_status="$?"`,
      `  chmod -R u+rwX ${quotedRoot} >/dev/null 2>&1 || qclaw_repair_status="$?"`,
      'fi',
    ].join('\n')
  })

  return [
    'qclaw_repair_status=0',
    ...commands,
    'exit "$qclaw_repair_status"',
  ].join('\n')
}

function buildRepairPrompt(): string {
  return [
    'Qclaw 检测到 OpenClaw 配置或运行目录权限异常。',
    '',
    'Qclaw 需要先修复这些目录的 ownership 和可写权限，才能继续当前操作。',
    '',
    '请输入你的 Mac 登录密码以继续。',
  ].join('\n')
}

function buildRepairFailureMessage(params: {
  blockedProbes: OpenClawInstallPathProbe[]
  repairRoots: string[]
  reason: string
}): string {
  const repairCommand =
    params.repairRoots.length > 0
      ? `sudo chown -R "$(id -u)":"$(id -g)" ${params.repairRoots.map((item) => quotePosixShellArg(item)).join(' ')}`
      : 'sudo chown -R "$(id -u)":"$(id -g)" ~/.openclaw ~/.npm'

  return [
    '检测到 OpenClaw 相关目录权限异常。',
    ...params.blockedProbes.map((probe) => buildBlockedProbeDescription(probe)),
    params.reason,
    '如需手动修复，请先执行：',
    repairCommand,
  ].join('\n')
}

function decoratePermissionFailureMessage(
  result: PermissionCommandLikeResult,
  message: string
): PermissionCommandLikeResult {
  const detail = [message, result.stderr].filter(Boolean).join('\n\n')
  return {
    ...result,
    stderr: `${QCLAW_PERMISSION_REPAIR_MARKER}\n${detail}`.trim(),
  }
}

async function maybeAttemptPermissionRepair(
  detail: string,
  context: PermissionAutoRepairContext,
  dependencies: PermissionAutoRepairDependencies
): Promise<PermissionRepairAttemptResult> {
  if (!looksLikePermissionFailure(detail)) {
    return { attempted: false, repaired: false }
  }

  const resolvedDependencies = normalizeDependencies(dependencies)
  const openClawPaths = await resolvedDependencies.getOpenClawPaths()
  const explicitPaths = dedupePaths([
    ...extractQuotedPaths(detail),
    context.targetPath || '',
  ])
  const candidatePaths = explicitPaths.length > 0
    ? explicitPaths
    : dedupePaths(buildFallbackCandidatePaths(context, openClawPaths, resolvedDependencies))

  const candidateProbes = await Promise.all(
    candidatePaths.map(async (pathname) => ({
      path: pathname,
      probe: await resolvedDependencies.probePath(pathname),
    }))
  )
  const blockedEntries = candidateProbes.filter(({ probe }) => !probe.writable || probe.ownerMatchesCurrentUser === false)
  if (blockedEntries.length === 0) {
    return { attempted: false, repaired: false }
  }

  const repairRoots = dedupePaths(
    blockedEntries.map(({ path }) => resolveRepairRootForPath(path, openClawPaths, resolvedDependencies))
  )
  if (repairRoots.length === 0) {
    return {
      attempted: false,
      repaired: false,
      message: buildRepairFailureMessage({
        blockedProbes: blockedEntries.map((entry) => entry.probe),
        repairRoots,
        reason: '当前故障路径不在 Qclaw 的安全自动修复范围内，请手动修复后重试。',
      }),
    }
  }

  if (resolvedDependencies.platform === 'win32') {
    // Windows: use icacls to grant current user full control on blocked directories
    const currentUser = resolvedDependencies.currentUser.username || '%USERNAME%'
    const icaclsCommands = repairRoots
      .map((repairRoot) => `icacls "${repairRoot}" /grant:r "${currentUser}:(OI)(CI)F" /T /C /Q`)
      .join(' && ')

    const repairResult = await resolvedDependencies.runPrivilegedRepair({
      command: icaclsCommands,
      prompt: [
        'Qclaw 检测到 OpenClaw 配置或运行目录权限异常。',
        '',
        'Qclaw 需要修复这些目录的访问权限，才能继续当前操作。',
        '',
        '点击"是"以管理员权限继续。',
      ].join('\n'),
      controlDomain: context.controlDomain || 'global',
    })

    if (!repairResult.ok) {
      return {
        attempted: true,
        repaired: false,
        message: buildRepairFailureMessage({
          blockedProbes: blockedEntries.map((entry) => entry.probe),
          repairRoots,
          reason: [
            'Windows 权限修复失败。',
            '如需手动修复，请以管理员身份运行 PowerShell 执行：',
            ...repairRoots.map((root) => `icacls "${root}" /grant:r "${currentUser}:(OI)(CI)F" /T /C /Q`),
          ].join('\n'),
        }),
      }
    }

    const verificationProbes = await Promise.all(
      blockedEntries.map(async ({ path }) => ({
        path,
        probe: await resolvedDependencies.probePath(path),
      }))
    )
    const remainingBlocked = verificationProbes.filter(
      ({ probe }) => !probe.writable || probe.ownerMatchesCurrentUser === false
    )
    if (remainingBlocked.length > 0) {
      return {
        attempted: true,
        repaired: false,
        message: buildRepairFailureMessage({
          blockedProbes: remainingBlocked.map((entry) => entry.probe),
          repairRoots,
          reason: 'Qclaw 已尝试自动修复，但仍有目录权限异常。',
        }),
      }
    }

    return {
      attempted: true,
      repaired: true,
    }
  }

  if (resolvedDependencies.platform !== 'darwin') {
    return {
      attempted: false,
      repaired: false,
      message: buildRepairFailureMessage({
        blockedProbes: blockedEntries.map((entry) => entry.probe),
        repairRoots,
        reason: '当前平台暂未接入自动提权修复，请手动修复后重试。',
      }),
    }
  }

  const repairResult = await resolvedDependencies.runPrivilegedRepair({
    command: buildDarwinRepairCommand(repairRoots, resolvedDependencies.currentUser),
    prompt: buildRepairPrompt(),
    controlDomain: context.controlDomain || 'global',
  })

  if (!repairResult.ok) {
    return {
      attempted: true,
      repaired: false,
      message: buildRepairFailureMessage({
        blockedProbes: blockedEntries.map((entry) => entry.probe),
        repairRoots,
        reason: repairResult.stderr || 'Qclaw 自动修复权限失败，请手动修复后重试。',
      }),
    }
  }

  const verificationProbes = await Promise.all(
    blockedEntries.map(async ({ path }) => ({
      path,
      probe: await resolvedDependencies.probePath(path),
    }))
  )
  const remainingBlocked = verificationProbes.filter(
    ({ probe }) => !probe.writable || probe.ownerMatchesCurrentUser === false
  )
  if (remainingBlocked.length > 0) {
    return {
      attempted: true,
      repaired: false,
      message: buildRepairFailureMessage({
        blockedProbes: remainingBlocked.map((entry) => entry.probe),
        repairRoots,
        reason: 'Qclaw 已尝试自动修复，但仍有目录权限异常。',
      }),
    }
  }

  return {
    attempted: true,
    repaired: true,
  }
}

function extractDetailFromResult(result: PermissionCommandLikeResult): string {
  return [String(result.stderr || ''), String(result.stdout || '')].filter(Boolean).join('\n')
}

function extractDetailFromError(error: unknown): string {
  const nodeError = error as NodeJS.ErrnoException
  const detail = [
    nodeError?.message || String(error || ''),
    nodeError?.path ? `path=${nodeError.path}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return detail
}

export async function runCliLikeWithPermissionAutoRepair<T extends PermissionCommandLikeResult>(
  execute: () => Promise<T>,
  context: PermissionAutoRepairContext,
  dependencies: PermissionAutoRepairDependencies
): Promise<T> {
  const firstResult = await execute()
  if (firstResult.ok || firstResult.canceled) return firstResult

  const repairAttempt = await maybeAttemptPermissionRepair(
    extractDetailFromResult(firstResult),
    context,
    dependencies
  )
  if (repairAttempt.repaired) {
    return execute()
  }

  if (repairAttempt.message) {
    return decoratePermissionFailureMessage(firstResult, repairAttempt.message) as T
  }

  return firstResult
}

export async function runFsWithPermissionAutoRepair<T>(
  execute: () => Promise<T>,
  context: PermissionAutoRepairContext,
  dependencies: PermissionAutoRepairDependencies
): Promise<T> {
  try {
    return await execute()
  } catch (error) {
    const repairAttempt = await maybeAttemptPermissionRepair(
      extractDetailFromError(error),
      context,
      dependencies
    )
    if (repairAttempt.repaired) {
      return execute()
    }
    if (repairAttempt.message) {
      throw new Error(`${QCLAW_PERMISSION_REPAIR_MARKER}\n${repairAttempt.message}`)
    }
    throw error
  }
}
