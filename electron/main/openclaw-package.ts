const childProcess = process.getBuiltinModule('child_process') as typeof import('node:child_process')
const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const path = process.getBuiltinModule('path') as typeof import('node:path')
import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import { resolveWindowsPrivateOpenClawRuntimePaths } from './platforms/windows/windows-runtime-policy'
import { getNamedCommandLookupInvocation } from './command-capabilities'
import { listExecutablePathCandidates } from './runtime-path-discovery'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

export interface OpenClawPackageInfo {
  name: string
  version: string
  packageRoot: string
  packageJsonPath: string
  binaryPath: string
  resolvedBinaryPath: string
}

interface ResolveOpenClawPackageOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  binaryPath?: string
  commandPathResolver?: (commandName: string) => Promise<string>
  commandLookupTimeoutMs?: number
  npmPrefixResolver?: () => Promise<string | null>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fileExists?: (candidatePath: string) => boolean
}

interface ResolveOpenClawBinaryPathFromNpmPrefixOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  npmPrefix: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fileExists?: (candidatePath: string) => boolean
}

interface ResolvedOpenClawPackageLayout {
  binaryPath: string
  resolvedBinaryPath: string
  packageRoot: string
  packageJsonPath: string
  packageJson: Record<string, unknown>
}

interface CommandPathLookupInvocation {
  command: string
  args: string[]
  shell: boolean
}

interface CommandLookupRuntime {
  activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
  commandLookupTimeoutMs: number
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

function extractFirstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function createCommandLookupRuntime(options: ResolveOpenClawPackageOptions = {}): CommandLookupRuntime {
  const platform = options.platform || process.platform
  return {
    activeRuntimeSnapshot:
      options.activeRuntimeSnapshot ?? (platform === 'win32' ? getSelectedWindowsActiveRuntimeSnapshot() : null),
    commandLookupTimeoutMs: Math.max(1, Math.floor(options.commandLookupTimeoutMs ?? 5_000)),
    platform,
    env: options.env || process.env,
  }
}

function withCommandLookupTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function findKnownCommandCandidate(
  runtime: CommandLookupRuntime,
  npmPrefix: string | null,
  fileExists: (candidatePath: string) => boolean = fs.existsSync
): string | null {
  const candidates = listExecutablePathCandidates('openclaw', {
    platform: runtime.platform,
    env: runtime.env,
    currentPath: runtime.env.PATH || '',
    npmPrefix,
    activeRuntimeSnapshot: runtime.activeRuntimeSnapshot,
  })
  for (const candidate of candidates) {
    try {
      if (fileExists(candidate)) return candidate
    } catch {
      // ignore invalid candidate checks and continue probing.
    }
  }
  return null
}

function resolveWindowsSnapshotBinaryPath(
  runtime: CommandLookupRuntime,
  fileExists: (candidatePath: string) => boolean = fs.existsSync
): string | null {
  const candidate = runtime.activeRuntimeSnapshot?.openclawPath?.trim()
  if (!candidate || runtime.platform !== 'win32') return null

  try {
    if (fileExists(candidate)) {
      return candidate
    }
  } catch {
    // Ignore invalid snapshot path checks and continue with the normal lookup flow.
  }

  return null
}

function resolveWindowsSnapshotHostPackageRoot(runtime: CommandLookupRuntime): string | null {
  const candidate = runtime.activeRuntimeSnapshot?.hostPackageRoot?.trim()
  if (!candidate || runtime.platform !== 'win32') return null
  return candidate
}

function normalizeComparablePath(platform: NodeJS.Platform, value: string): string {
  const trimmed = String(value || '').trim()
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

async function resolveWindowsPrivateRuntimePackageLayout(
  runtime: CommandLookupRuntime,
  binaryPath: string,
  resolvedBinaryPath: string,
  fsPromises: typeof fs.promises
): Promise<ResolvedOpenClawPackageLayout | null> {
  if (runtime.platform !== 'win32') return null

  const privateRuntimePaths = resolveWindowsPrivateOpenClawRuntimePaths({
    env: runtime.env,
  })
  const privateExecutable = normalizeComparablePath(runtime.platform, privateRuntimePaths.openclawExecutable)
  const candidateBinaryPaths = [
    normalizeComparablePath(runtime.platform, binaryPath),
    normalizeComparablePath(runtime.platform, resolvedBinaryPath),
  ]
  if (!candidateBinaryPaths.includes(privateExecutable)) {
    return null
  }

  const packageLocation = await findNearestOpenClawPackageLocation(
    privateRuntimePaths.hostPackageRoot,
    fsPromises
  )
  if (!packageLocation) return null

  return {
    binaryPath,
    resolvedBinaryPath,
    packageRoot: packageLocation.packageRoot,
    packageJsonPath: packageLocation.packageJsonPath,
    packageJson: packageLocation.packageJson,
  }
}

export function resolveOpenClawBinaryPathFromNpmPrefix(
  options: ResolveOpenClawBinaryPathFromNpmPrefixOptions
): string {
  const runtime = createCommandLookupRuntime(options)
  const snapshotBinaryPath = resolveWindowsSnapshotBinaryPath(runtime, options.fileExists)
  if (snapshotBinaryPath) return snapshotBinaryPath

  const npmPrefix = String(options.npmPrefix || '').trim()
  const candidate = listExecutablePathCandidates('openclaw', {
    platform: runtime.platform,
    env: runtime.env,
    currentPath: '',
    npmPrefix,
    activeRuntimeSnapshot: runtime.activeRuntimeSnapshot,
  })[0]
  if (candidate) return candidate
  throw new Error(
    `Unable to resolve the openclaw binary from npm prefix: ${npmPrefix || '(empty)'}`
  )
}

function isCommandLookupMiss(commandName: string, message: string): boolean {
  const normalized = String(message || '').trim().toLowerCase()
  const normalizedCommand = commandName.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.includes('could not find files for the given pattern')) return true
  if (normalized.includes(`unable to resolve command path for ${normalizedCommand}`)) return true
  if (normalized.includes('not recognized as an internal or external command') && normalized.includes(normalizedCommand)) return true
  if (normalized.includes('command not found') && normalized.includes(normalizedCommand)) return true
  return false
}

function toActionableCommandLookupError(commandName: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error || '')
  if (isCommandLookupMiss(commandName, message)) {
    return new Error(
      `无法定位 ${commandName} 命令。请先在环境检查中完成 OpenClaw 命令行工具安装，然后重启 Qclaw。`
    )
  }
  return new Error(message || `Unable to resolve command path for ${commandName}`)
}

export function getCommandPathLookupInvocation(
  commandName: string,
  platformOrRuntime:
    | NodeJS.Platform
    | {
        platform?: NodeJS.Platform
        env?: NodeJS.ProcessEnv
      } = process.platform
): CommandPathLookupInvocation {
  return getNamedCommandLookupInvocation(commandName, platformOrRuntime)
}

function runCommandPathLookup(commandName: string, runtime: CommandLookupRuntime): Promise<string> {
  return new Promise((resolve, reject) => {
    const invocation = getCommandPathLookupInvocation(commandName, runtime)
    const child = childProcess.spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
      env: runtime.env,
      cwd: resolveSafeWorkingDirectory({ env: runtime.env, platform: runtime.platform }),
      timeout: runtime.commandLookupTimeoutMs,
      windowsHide: runtime.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const resolved = extractFirstNonEmptyLine(stdout)
      if (code === 0 && resolved) {
        resolve(resolved)
        return
      }
      reject(new Error(stderr.trim() || `Unable to resolve command path for ${commandName}`))
    })
  })
}

function runDirectCommand(command: string, args: string[], runtime: CommandLookupRuntime): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: runtime.env,
      cwd: resolveSafeWorkingDirectory({ env: runtime.env, platform: runtime.platform }),
      timeout: runtime.commandLookupTimeoutMs,
      windowsHide: runtime.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() || `Command failed: ${command}`))
    })
  })
}

async function resolveNpmGlobalPrefix(runtime: CommandLookupRuntime): Promise<string | null> {
  try {
    const npmCommandPath = await runCommandPathLookup('npm', runtime)
    const stdout = await runDirectCommand(npmCommandPath.trim(), ['config', 'get', 'prefix'], runtime)
    const prefix = extractFirstNonEmptyLine(stdout)
    if (!prefix || prefix === 'undefined' || prefix === 'null') return null
    return prefix
  } catch {
    return null
  }
}

async function resolvePackageLayout(
  options: ResolveOpenClawPackageOptions = {}
): Promise<ResolvedOpenClawPackageLayout> {
  const runtime = createCommandLookupRuntime(options)
  const binaryPath = options.binaryPath?.trim() || (await resolveOpenClawBinaryPath(options))
  if (!binaryPath) {
    throw new Error('Unable to resolve the openclaw binary path')
  }

  const fsPromises = fs.promises
  if (!fsPromises) {
    throw new Error('Node fs.promises is unavailable in this runtime')
  }
  const resolvedBinaryPath = await fsPromises.realpath(binaryPath)
  const snapshotHostPackageRoot = resolveWindowsSnapshotHostPackageRoot(runtime)
  if (snapshotHostPackageRoot) {
    const snapshotPackageLocation = await findNearestOpenClawPackageLocation(
      snapshotHostPackageRoot,
      fsPromises
    )
    if (snapshotPackageLocation?.packageRoot === snapshotHostPackageRoot) {
      return {
        binaryPath,
        resolvedBinaryPath,
        packageRoot: snapshotPackageLocation.packageRoot,
        packageJsonPath: snapshotPackageLocation.packageJsonPath,
        packageJson: snapshotPackageLocation.packageJson,
      }
    }
  }

  const privateRuntimeLayout = await resolveWindowsPrivateRuntimePackageLayout(
    runtime,
    binaryPath,
    resolvedBinaryPath,
    fsPromises
  )
  if (privateRuntimeLayout) {
    return privateRuntimeLayout
  }

  let startDir = path.dirname(resolvedBinaryPath)
  const packageLocation = await findNearestOpenClawPackageLocation(startDir, fsPromises)
  if (!packageLocation) {
    throw new Error(
      `Resolved OpenClaw binary does not have an adjacent or parent openclaw package.json: ${resolvedBinaryPath}`
    )
  }

  const { packageRoot, packageJsonPath, packageJson } = packageLocation

  return {
    binaryPath,
    resolvedBinaryPath,
    packageRoot,
    packageJsonPath,
    packageJson,
  }
}

function resolveOpenClawCliBinRelativePath(packageJson: Record<string, unknown>): string {
  const rawBin = packageJson.bin
  if (typeof rawBin === 'string') {
    return rawBin.trim()
  }
  if (rawBin && typeof rawBin === 'object') {
    const openclawBin = (rawBin as Record<string, unknown>).openclaw
    if (typeof openclawBin === 'string') {
      return openclawBin.trim()
    }
  }
  return ''
}

async function findNearestOpenClawPackageLocation(
  startDir: string,
  fsPromises: typeof fs.promises
): Promise<{
  packageRoot: string
  packageJsonPath: string
  packageJson: Record<string, unknown>
} | null> {
  let currentDir = startDir

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json')
    try {
      const rawPackageJson = await fsPromises.readFile(packageJsonPath, 'utf8')
      let packageJson: Record<string, unknown>
      try {
        packageJson = JSON.parse(rawPackageJson) as Record<string, unknown>
      } catch {
        throw new Error(`Failed to parse OpenClaw package.json: ${packageJsonPath}`)
      }

      if (packageJson.name === 'openclaw') {
        return {
          packageRoot: currentDir,
          packageJsonPath,
          packageJson,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '')
      if (message.startsWith('Failed to parse OpenClaw package.json:')) {
        throw error
      }
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return null
    currentDir = parentDir
  }
}

export async function resolveOpenClawBinaryPath(
  options: ResolveOpenClawPackageOptions = {}
): Promise<string> {
  const runtime = createCommandLookupRuntime(options)
  const resolveCommandPath =
    options.commandPathResolver ||
    ((commandName: string) => runCommandPathLookup(commandName, runtime))

  const snapshotBinaryPath = resolveWindowsSnapshotBinaryPath(runtime, options.fileExists)
  if (snapshotBinaryPath) {
    return snapshotBinaryPath
  }

  try {
    const binaryPath = await withCommandLookupTimeout(
      resolveCommandPath('openclaw'),
      runtime.commandLookupTimeoutMs,
      'openclaw command lookup'
    )
    const trimmed = binaryPath.trim()
    if (!trimmed) {
      throw new Error('Unable to resolve the openclaw binary path')
    }
    return trimmed
  } catch (error) {
    const npmPrefix =
      (await options.npmPrefixResolver?.().catch(() => null)) ??
      (await withCommandLookupTimeout(
        resolveNpmGlobalPrefix(runtime),
        runtime.commandLookupTimeoutMs,
        'npm prefix lookup'
      ).catch(() => null))
    const fallbackCandidate = findKnownCommandCandidate(runtime, npmPrefix, options.fileExists)
    if (fallbackCandidate) return fallbackCandidate
    throw toActionableCommandLookupError('openclaw', error)
  }
}

export async function resolveOpenClawPackageRoot(
  options: ResolveOpenClawPackageOptions = {}
): Promise<string> {
  const layout = await resolvePackageLayout(options)
  return layout.packageRoot
}

export async function resolveOpenClawCliEntrypointPath(
  options: ResolveOpenClawPackageOptions = {}
): Promise<string> {
  const layout = await resolvePackageLayout(options)
  const relativeEntryPath = resolveOpenClawCliBinRelativePath(layout.packageJson)
  if (!relativeEntryPath) {
    throw new Error(
      `Resolved OpenClaw package.json is missing a usable openclaw bin entry: ${layout.packageJsonPath}`
    )
  }

  return path.resolve(layout.packageRoot, relativeEntryPath)
}

export async function readOpenClawPackageInfo(
  options: ResolveOpenClawPackageOptions = {}
): Promise<OpenClawPackageInfo> {
  const layout = await resolvePackageLayout(options)
  const version = String(layout.packageJson.version || '').trim()
  if (!version) {
    throw new Error(`Resolved OpenClaw package.json is missing a version: ${layout.packageJsonPath}`)
  }

  return {
    name: 'openclaw',
    version,
    packageRoot: layout.packageRoot,
    packageJsonPath: layout.packageJsonPath,
    binaryPath: layout.binaryPath,
    resolvedBinaryPath: layout.resolvedBinaryPath,
  }
}
