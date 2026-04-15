import type { OpenClawCommandResultLike } from './openclaw-download-fallbacks'
import { buildAppleScriptDoShellScript } from './node-runtime'
import { resolveRuntimeOpenClawPaths } from './openclaw-runtime-paths'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')

const { access, lstat, realpath, stat } = fs.promises
const { homedir, userInfo } = os
const { relative, isAbsolute } = path

const LIFECYCLE_STATUS_MARKER = '__QCLAW_TXN_LIFECYCLE_STATUS__='
const REPAIR_STATUS_MARKER = '__QCLAW_TXN_REPAIR_STATUS__='

export type OpenClawElevatedLifecycleOperation = 'install' | 'upgrade' | 'uninstall'

export type OpenClawElevatedLifecycleTransactionStatus =
  | 'success'
  | 'snapshot_failed'
  | 'lifecycle_failed_environment_not_clean'
  | 'lifecycle_failed_environment_repaired'
  | 'post_repair_failed_after_lifecycle'
  | 'post_repair_verification_failed'

export interface OpenClawRepairTarget {
  role: 'stateRoot' | 'npmCache' | 'managedInstallerRoot' | 'userDataNpmCache'
  path: string
  createIfMissing: boolean
  realPath?: string | null
  isSymlink?: boolean
}

export interface OpenClawRepairSnapshot {
  operation: OpenClawElevatedLifecycleOperation
  stateRootPath: string
  fallbackStateRootUsed: boolean
  targets: OpenClawRepairTarget[]
}

interface VerifyRepairTargetResult {
  ok: boolean
  detail?: string
}

interface ParsedTransactionStatuses {
  stdout: string
  stderr: string
  lifecycleStatus: number | null
  repairStatus: number | null
}

export interface OpenClawElevatedLifecycleTransactionResult extends OpenClawCommandResultLike {
  status: OpenClawElevatedLifecycleTransactionStatus
  snapshot: OpenClawRepairSnapshot | null
  lifecycle: {
    ok: boolean
    code: number | null
  }
  repair: {
    ok: boolean
    code: number | null
  }
  verification: {
    ok: boolean
    failures: Array<{
      role: OpenClawRepairTarget['role']
      path: string
      detail: string
    }>
  }
}

function normalizePathValue(value: string | null | undefined): string {
  return String(value || '').trim()
}

type NodePathModule = typeof path.posix

function inferPathModuleFromPath(value: unknown): NodePathModule {
  const rawValue = normalizePathValue(value as string | null | undefined)
  if (/^[A-Za-z]:[\\/]/.test(rawValue) || rawValue.includes('\\')) return path.win32
  return path.posix
}

function joinPathLike(basePath: string, ...parts: string[]): string {
  return inferPathModuleFromPath(basePath).join(basePath, ...parts)
}

function quotePosixShellArg(arg: string): string {
  if (arg === '') return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function isPathWithinDirectory(baseDir: string, candidatePath: string): boolean {
  const normalizedBase = normalizePathValue(baseDir)
  const normalizedCandidate = normalizePathValue(candidatePath)
  if (!normalizedBase || !normalizedCandidate) return false
  const relativePath = relative(normalizedBase, normalizedCandidate)
  if (!relativePath) return true
  return !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

function isTrustedRepairPath(
  candidatePath: string,
  options: {
    homeDir: string
    userDataDir: string
    qclawSafeWorkDir: string
  }
): boolean {
  const normalizedCandidate = normalizePathValue(candidatePath)
  if (!normalizedCandidate) return false
  if (isPathWithinDirectory(options.homeDir, normalizedCandidate)) return true
  if (options.userDataDir && isPathWithinDirectory(options.userDataDir, normalizedCandidate)) return true
  if (options.qclawSafeWorkDir && isPathWithinDirectory(options.qclawSafeWorkDir, normalizedCandidate)) return true
  return false
}

async function isTrustedRepairRealPath(
  candidatePath: string,
  options: {
    homeDir: string
    userDataDir: string
    qclawSafeWorkDir: string
  }
): Promise<boolean> {
  if (isTrustedRepairPath(candidatePath, options)) return true

  for (const trustedRoot of [options.homeDir, options.userDataDir, options.qclawSafeWorkDir]) {
    const normalizedTrustedRoot = normalizePathValue(trustedRoot)
    if (!normalizedTrustedRoot) continue
    const resolvedTrustedRoot = normalizePathValue(await realpath(normalizedTrustedRoot).catch(() => ''))
    if (resolvedTrustedRoot && isPathWithinDirectory(resolvedTrustedRoot, candidatePath)) {
      return true
    }
  }

  return false
}

function dedupeRepairTargets(targets: OpenClawRepairTarget[]): OpenClawRepairTarget[] {
  const seen = new Set<string>()
  const unique: OpenClawRepairTarget[] = []
  for (const target of targets) {
    const normalizedPath = normalizePathValue(target.path)
    const normalizedRealPath = normalizePathValue(target.realPath)
    if (!normalizedPath) continue
    const dedupeKey = normalizedRealPath || normalizedPath
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    unique.push({
      ...target,
      path: normalizedPath,
      realPath: normalizedRealPath || undefined,
    })
  }
  return unique
}

async function resolveRepairTargetMetadata(
  target: OpenClawRepairTarget,
  options: {
    homeDir: string
    userDataDir: string
    qclawSafeWorkDir: string
  }
): Promise<OpenClawRepairTarget> {
  const normalizedPath = normalizePathValue(target.path)
  let isSymlink = false
  let resolvedRealPath = ''

  try {
    const targetStats = await lstat(normalizedPath)
    isSymlink = targetStats.isSymbolicLink()
    resolvedRealPath = normalizePathValue(await realpath(normalizedPath))
  } catch {
    resolvedRealPath = ''
  }

  if (
    resolvedRealPath &&
    !(await isTrustedRepairRealPath(resolvedRealPath, options))
  ) {
    throw new Error(
      `Repair target resolves outside trusted repair scopes: ${normalizedPath} -> ${resolvedRealPath}`
    )
  }

  return {
    ...target,
    path: normalizedPath,
    realPath: resolvedRealPath || undefined,
    isSymlink,
  }
}

function parseStatusMarker(
  output: string,
  marker: string
): {
  cleanedOutput: string
  status: number | null
} {
  const lines = String(output || '').split(/\r?\n/g)
  const keptLines: string[] = []
  let parsedStatus: number | null = null

  for (const line of lines) {
    if (line.startsWith(marker)) {
      const rawStatus = line.slice(marker.length).trim()
      const numericStatus = Number.parseInt(rawStatus, 10)
      parsedStatus = Number.isFinite(numericStatus) ? numericStatus : null
      continue
    }
    keptLines.push(line)
  }

  return {
    cleanedOutput: keptLines.join('\n').replace(/\n+$/g, ''),
    status: parsedStatus,
  }
}

function parseTransactionStatuses(result: OpenClawCommandResultLike): ParsedTransactionStatuses {
  const stdoutLifecycle = parseStatusMarker(result.stdout, LIFECYCLE_STATUS_MARKER)
  const stdoutRepair = parseStatusMarker(stdoutLifecycle.cleanedOutput, REPAIR_STATUS_MARKER)
  const stderrLifecycle = parseStatusMarker(result.stderr, LIFECYCLE_STATUS_MARKER)
  const stderrRepair = parseStatusMarker(stderrLifecycle.cleanedOutput, REPAIR_STATUS_MARKER)

  return {
    stdout: stdoutRepair.cleanedOutput,
    stderr: stderrRepair.cleanedOutput,
    lifecycleStatus:
      stdoutLifecycle.status ??
      stderrLifecycle.status ??
      (result.ok ? 0 : result.code ?? 1),
    repairStatus:
      stdoutRepair.status ??
      stderrRepair.status ??
      (result.ok ? 0 : null),
  }
}

async function defaultVerifyRepairTargetAccess(
  target: OpenClawRepairTarget,
  currentUserId: number | null
): Promise<VerifyRepairTargetResult> {
  try {
    const verificationPath = normalizePathValue(target.realPath || target.path)
    const info = await stat(verificationPath)
    const requiredMode = info.isDirectory()
      ? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
      : fs.constants.R_OK | fs.constants.W_OK
    await access(verificationPath, requiredMode)
    if (
      currentUserId !== null &&
      typeof info.uid === 'number' &&
      info.uid !== currentUserId
    ) {
      return {
        ok: false,
        detail: `owner mismatch: expected ${currentUserId}, received ${info.uid}`,
      }
    }
    if (target.isSymlink) {
      const linkInfo = await lstat(target.path)
      if (
        currentUserId !== null &&
        typeof linkInfo.uid === 'number' &&
        linkInfo.uid !== currentUserId
      ) {
        return {
          ok: false,
          detail: `symlink owner mismatch: expected ${currentUserId}, received ${linkInfo.uid}`,
        }
      }
    }
    return { ok: true }
  } catch (error) {
    const errorCode =
      typeof error === 'object' && error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || '').trim()
        : ''
    if (errorCode === 'ENOENT' && target.createIfMissing === false) {
      return { ok: true }
    }
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error || 'unknown verification error'),
    }
  }
}

function buildRepairCommands(
  snapshot: OpenClawRepairSnapshot,
  userId: number,
  groupId: number
): string[] {
  const ownership = `${quotePosixShellArg(String(userId))}:${quotePosixShellArg(String(groupId))}`
  return snapshot.targets.flatMap((target) => {
    const quotedPath = quotePosixShellArg(target.path)
    const recursiveRepairPath = normalizePathValue(target.realPath || target.path)
    const quotedRecursiveRepairPath = quotePosixShellArg(recursiveRepairPath)
    const commands: string[] = []
    if (target.createIfMissing && !target.isSymlink) {
      commands.push(`mkdir -p ${quotedPath} >/dev/null 2>&1 || qclaw_repair_status="$?"`)
    }
    if (target.isSymlink) {
      commands.push(`if [ -L ${quotedPath} ]; then`)
      commands.push(`  chown -h ${ownership} ${quotedPath} >/dev/null 2>&1 || qclaw_repair_status="$?"`)
      commands.push('fi')
    }
    commands.push(`if [ -e ${quotedRecursiveRepairPath} ]; then`)
    commands.push(
      `  chown -R ${ownership} ${quotedRecursiveRepairPath} >/dev/null 2>&1 || qclaw_repair_status="$?"`
    )
    commands.push(
      `  chmod -R u+rwX ${quotedRecursiveRepairPath} >/dev/null 2>&1 || qclaw_repair_status="$?"`
    )
    commands.push('fi')
    return commands
  })
}

export async function buildOpenClawRepairSnapshot(options: {
  operation: OpenClawElevatedLifecycleOperation
  binaryPath?: string | null
  preferredStateRootPath?: string | null
  homeDir?: string | null
  userDataDir?: string | null
  qclawSafeWorkDir?: string | null
  includeManagedInstallerRoot?: boolean
  includeUserDataNpmCache?: boolean
  runtimePathsResolver?: (input: {
    binaryPath?: string
    cacheTtlMs?: number
  }) => Promise<{ homeDir?: string | null }>
}): Promise<OpenClawRepairSnapshot> {
  const homeDir = normalizePathValue(options.homeDir || homedir())
  const userDataDir = normalizePathValue(options.userDataDir || process.env.QCLAW_USER_DATA_DIR || '')
  const qclawSafeWorkDir = normalizePathValue(
    options.qclawSafeWorkDir || process.env.QCLAW_SAFE_WORK_DIR || resolveSafeWorkingDirectory()
  )
  const fallbackStateRoot = homeDir ? joinPathLike(homeDir, '.openclaw') : '.openclaw'
  const preferredStateRootPath = normalizePathValue(options.preferredStateRootPath)
  const createIfMissing = options.operation !== 'uninstall'

  let stateRootPath = ''
  let fallbackStateRootUsed = false
  let runtimeStateRoot = ''

  try {
    const runtimePaths = await (
      options.runtimePathsResolver || ((input) => resolveRuntimeOpenClawPaths(input))
    )({
      binaryPath: normalizePathValue(options.binaryPath) || undefined,
      cacheTtlMs: 0,
    })
    runtimeStateRoot = normalizePathValue(runtimePaths?.homeDir)
  } catch {
    // Fall through to preferred path or literal fallback below.
  }

  if (runtimeStateRoot) {
    if (!isTrustedRepairPath(runtimeStateRoot, { homeDir, userDataDir, qclawSafeWorkDir })) {
      throw new Error(`Runtime state root is outside trusted repair scopes: ${runtimeStateRoot}`)
    }
    stateRootPath = runtimeStateRoot
  }

  if (!stateRootPath && preferredStateRootPath) {
    if (!isTrustedRepairPath(preferredStateRootPath, { homeDir, userDataDir, qclawSafeWorkDir })) {
      throw new Error(`Preferred state root is outside trusted repair scopes: ${preferredStateRootPath}`)
    }
    stateRootPath = preferredStateRootPath
  }

  if (!stateRootPath) {
    stateRootPath = fallbackStateRoot
    fallbackStateRootUsed = true
  }

  const targets = dedupeRepairTargets(
    await Promise.all(
      [
        {
          role: 'stateRoot' as const,
          path: stateRootPath,
          createIfMissing,
        },
        {
          role: 'npmCache' as const,
          path: joinPathLike(homeDir, '.npm'),
          createIfMissing,
        },
        ...(options.includeManagedInstallerRoot
          ? [
              {
                role: 'managedInstallerRoot' as const,
                path: joinPathLike(qclawSafeWorkDir, 'openclaw-installer'),
                createIfMissing,
              },
            ]
          : []),
        ...(options.includeUserDataNpmCache && userDataDir
          ? [
              {
                role: 'userDataNpmCache' as const,
                path: joinPathLike(userDataDir, 'npm-cache'),
                createIfMissing,
              },
            ]
          : []),
      ]
        .filter((target) =>
          isTrustedRepairPath(target.path, { homeDir, userDataDir, qclawSafeWorkDir })
        )
        .map((target) =>
          resolveRepairTargetMetadata(target, {
            homeDir,
            userDataDir,
            qclawSafeWorkDir,
          })
        )
    )
  )

  return {
    operation: options.operation,
    stateRootPath,
    fallbackStateRootUsed,
    targets,
  }
}

export function buildMacOpenClawElevatedLifecycleTransactionCommand(options: {
  lifecycleCommand: string
  snapshot: OpenClawRepairSnapshot
  userId: number
  groupId: number
}): string {
  const commands = [
    'qclaw_lifecycle_status=0',
    `(${options.lifecycleCommand})`,
    'qclaw_lifecycle_status="$?"',
    'qclaw_repair_status=0',
    ...buildRepairCommands(options.snapshot, options.userId, options.groupId),
    `printf '%s\\n' "${LIFECYCLE_STATUS_MARKER}$qclaw_lifecycle_status"`,
    `printf '%s\\n' "${REPAIR_STATUS_MARKER}$qclaw_repair_status"`,
    'if [ "$qclaw_lifecycle_status" -ne 0 ] || [ "$qclaw_repair_status" -ne 0 ]; then',
    '  exit 1',
    'fi',
    'exit 0',
  ]

  return commands.join('\n')
}

export async function runMacOpenClawElevatedLifecycleTransaction(options: {
  operation: OpenClawElevatedLifecycleOperation
  lifecycleCommand: string
  prompt: string
  timeoutMs: number
  controlDomain: string
  binaryPath?: string | null
  preferredStateRootPath?: string | null
  homeDir?: string | null
  userDataDir?: string | null
  qclawSafeWorkDir?: string | null
  includeManagedInstallerRoot?: boolean
  includeUserDataNpmCache?: boolean
  snapshotResolver?: () => Promise<OpenClawRepairSnapshot>
  runDirect: (
    command: string,
    args: string[],
    timeout: number,
    controlDomain: string
  ) => Promise<OpenClawCommandResultLike>
  verifyTargetAccess?: (target: OpenClawRepairTarget) => Promise<VerifyRepairTargetResult>
  buildAppleScript?: (
    command: string,
    options?: {
      prompt?: string
    }
  ) => string
}): Promise<OpenClawElevatedLifecycleTransactionResult> {
  let snapshot: OpenClawRepairSnapshot | null = null

  try {
    snapshot = await (
      options.snapshotResolver ||
      (() =>
        buildOpenClawRepairSnapshot({
          operation: options.operation,
          binaryPath: options.binaryPath,
          preferredStateRootPath: options.preferredStateRootPath,
          homeDir: options.homeDir,
          userDataDir: options.userDataDir,
          qclawSafeWorkDir: options.qclawSafeWorkDir,
          includeManagedInstallerRoot: options.includeManagedInstallerRoot,
          includeUserDataNpmCache: options.includeUserDataNpmCache,
        }))
    )()
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error || 'repair snapshot failed'),
      code: 1,
      status: 'snapshot_failed',
      snapshot: null,
      lifecycle: {
        ok: false,
        code: null,
      },
      repair: {
        ok: false,
        code: null,
      },
      verification: {
        ok: false,
        failures: [],
      },
    }
  }

  const currentUser = userInfo()
  const currentUserId = typeof currentUser.uid === 'number' ? currentUser.uid : null
  const currentGroupId = typeof currentUser.gid === 'number' ? currentUser.gid : null
  const lifecycleCommand = buildMacOpenClawElevatedLifecycleTransactionCommand({
    lifecycleCommand: options.lifecycleCommand,
    snapshot,
    userId: currentUserId ?? 0,
    groupId: currentGroupId ?? 0,
  })
  const appleScript = (options.buildAppleScript || buildAppleScriptDoShellScript)(lifecycleCommand, {
    prompt: options.prompt,
  })
  const elevatedResult = await options.runDirect(
    'osascript',
    ['-e', appleScript],
    options.timeoutMs,
    options.controlDomain
  )
  const parsed = parseTransactionStatuses(elevatedResult)
  const lifecycleOk = parsed.lifecycleStatus === 0
  const repairOk = parsed.repairStatus === 0
  const verifyTargetAccess =
    options.verifyTargetAccess ||
    ((target: OpenClawRepairTarget) => defaultVerifyRepairTargetAccess(target, currentUserId))
  const verificationChecks = await Promise.all(
    snapshot.targets.map(async (target) => ({
      target,
      result: await verifyTargetAccess(target),
    }))
  )
  const verificationFailures = verificationChecks
    .filter((entry) => !entry.result.ok)
    .map((entry) => ({
      role: entry.target.role,
      path: entry.target.path,
      detail: entry.result.detail || 'verification failed',
    }))
  const verificationOk = verificationFailures.length === 0

  let status: OpenClawElevatedLifecycleTransactionStatus = 'success'
  if (!lifecycleOk && repairOk && verificationOk) {
    status = 'lifecycle_failed_environment_repaired'
  } else if (!lifecycleOk) {
    status = 'lifecycle_failed_environment_not_clean'
  } else if (!repairOk) {
    status = 'post_repair_failed_after_lifecycle'
  } else if (!verificationOk) {
    status = 'post_repair_verification_failed'
  }

  const extraMessages: string[] = []
  if (status === 'lifecycle_failed_environment_repaired') {
    extraMessages.push('管理员命令执行失败，但提权后的用户目录修复与校验已完成。')
  } else if (status === 'lifecycle_failed_environment_not_clean') {
    extraMessages.push('管理员命令执行失败，且提权后的用户目录未完全恢复到健康状态。')
  } else if (status === 'post_repair_failed_after_lifecycle') {
    extraMessages.push('管理员命令执行完成，但提权后的用户目录修复失败。')
  } else if (status === 'post_repair_verification_failed') {
    extraMessages.push('管理员命令执行完成，但提权后的用户目录校验仍未通过。')
  }

  if (verificationFailures.length > 0) {
    extraMessages.push(
      verificationFailures
        .map((failure) => `${failure.role}: ${failure.path} -> ${failure.detail}`)
        .join('\n')
    )
  }

  return {
    ok: status === 'success',
    stdout: parsed.stdout,
    stderr: [parsed.stderr, ...extraMessages].filter(Boolean).join('\n\n'),
    code: elevatedResult.code,
    canceled: elevatedResult.canceled,
    status,
    snapshot,
    lifecycle: {
      ok: lifecycleOk,
      code: parsed.lifecycleStatus,
    },
    repair: {
      ok: repairOk,
      code: parsed.repairStatus,
    },
    verification: {
      ok: verificationOk,
      failures: verificationFailures,
    },
  }
}
